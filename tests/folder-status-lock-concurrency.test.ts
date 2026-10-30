import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ImapService } from '../src/services/imap-service.js';
import { folderTools } from '../src/tools/folder-tools.js';
import { ImapAccount } from '../src/types/index.js';

// T01 / MAIL-01: folder status reads must respect the same per-folder mailbox
// lock as UID reads, flag changes, moves and deletes. Case IDs in this file:
//   T01-LOCK-{READ,FLAGS,MOVE,DELETE} — interleaved folder_status must not
//     switch the selected mailbox under a held lock (same UID 7 in two folders
//     with different UIDVALIDITY must act on the locked folder's message).
//   T01-SNAPSHOT-01 — the snapshot returned to the handler is a stable value,
//     not the live client.mailbox reference.
//   T01-LOCK-FAIL-01 — a failed lock grant or failed select releases/never
//     holds the lock and the queue keeps working.

const SYNTHETIC_PASSWORD = ['t01-', 'synthetic', '-pw'].join('');

// These mocks mirror the real imapflow concurrency semantics observed in
// node_modules/imapflow/lib/imap-flow.js:
// - getMailboxLock() is a connection-level FIFO mutex. On grant it SELECTs the
//   requested mailbox unless it is already selected; the next queued lock
//   waits until release().
// - mailboxOpen() is a bare SELECT. run() never checks currentLock, so it
//   switches the selected mailbox immediately even while a lock is held —
//   the bypass MAIL-01 exploits.
// - status() does not change the selected mailbox.
// - UID commands act on whatever mailbox is selected when the command runs.
interface MockFolderSpec {
  uidValidity: bigint;
  uidNext: number;
  flags: string[];
  permanentFlags?: string[];
  messages: Map<number, string>;
}

type Deferred = { promise: Promise<void>; release: () => void };
const makeDeferred = (): Deferred => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};

interface CommandRecord {
  cmd: string;
  selection: string | null;
  uid: number | string;
}

class LockModelingImapFlow {
  usable = true;
  mailbox: any = null;
  // The MOVE/UIDPLUS gates (T03/T04) read the server's advertised capability
  // map; a realistic default keeps the lock-model tests focused on locking.
  capabilities = new Map<string, boolean>([
    ['IMAP4rev1', true],
    ['MOVE', true],
    ['UIDPLUS', true],
  ]);
  folders = new Map<string, MockFolderSpec>();
  events: string[] = [];
  commands: CommandRecord[] = [];
  // When armed, a lock grant for this path pauses after SELECT until released.
  lockGate: { path: string; deferred: Deferred } | null = null;
  // One-shot failure injected into the next mailboxOpen for this path.
  failMailboxOpenOnce: { path: string; error: Error } | null = null;

  private lockQueue: Array<{
    path: string;
    resolve: (lock: { path: string; release: () => void }) => void;
    reject: (err: Error) => void;
    released: boolean;
  }> = [];
  private grantProcessing = false;
  private lockHeldPath: string | null = null;

  connect(): Promise<void> { return Promise.resolve(); }
  async logout(): Promise<void> {}
  on(): void {}

  addFolder(path: string, spec: MockFolderSpec): void {
    this.folders.set(path, spec);
  }

  private buildMailboxObject(path: string): any {
    const spec = this.folders.get(path);
    if (!spec) return null;
    return {
      path,
      uidValidity: spec.uidValidity,
      uidNext: spec.uidNext,
      exists: spec.messages.size,
      flags: new Set(spec.flags),
      permanentFlags: spec.permanentFlags ? new Set(spec.permanentFlags) : undefined,
      readOnly: false,
    };
  }

  mailboxOpen(path: string): Promise<any> {
    const fail = this.failMailboxOpenOnce;
    if (fail && fail.path === path) {
      this.failMailboxOpenOnce = null;
      return Promise.reject(fail.error);
    }
    const box = this.buildMailboxObject(path);
    if (!box) {
      return Promise.reject(new Error(`Mailbox "${path}" does not exist`));
    }
    // The bypass: bare SELECT switches the connection with no lock check.
    this.mailbox = box;
    this.events.push(`select:${path}`);
    return Promise.resolve(box);
  }

  getMailboxLock(path: string): Promise<{ path: string; release: () => void }> {
    return new Promise((resolve, reject) => {
      this.lockQueue.push({ path, resolve, reject, released: false });
      this.processLockQueue();
    });
  }

  private processLockQueue(): void {
    if (this.grantProcessing) return;
    this.grantProcessing = true;
    void this.grantLoop().finally(() => { this.grantProcessing = false; });
  }

  private async grantLoop(): Promise<void> {
    while (this.lockQueue.length > 0 && this.lockHeldPath === null) {
      const entry = this.lockQueue.shift()!;
      if (!this.usable) {
        entry.reject(Object.assign(new Error('Connection not available'), { code: 'NoConnection' }));
        continue;
      }
      try {
        if (this.mailbox?.path !== entry.path) {
          await this.mailboxOpen(entry.path);
        }
      } catch (err) {
        entry.reject(err as Error);
        continue;
      }
      // The lock is held from here: no other queued lock can be granted
      // while this grantLoop pass is still running (gate included).
      this.lockHeldPath = entry.path;
      this.events.push(`lock:granted:${entry.path}`);
      if (this.lockGate && this.lockGate.path === entry.path) {
        this.events.push(`gate:await:${entry.path}`);
        await this.lockGate.deferred.promise;
        this.events.push(`gate:passed:${entry.path}`);
        this.lockGate = null;
      }
      entry.resolve({
        path: entry.path,
        release: () => {
          if (this.lockHeldPath === entry.path && !entry.released) {
            entry.released = true;
            this.lockHeldPath = null;
            this.events.push(`lock:released:${entry.path}`);
            setImmediate(() => this.processLockQueue());
          }
        },
      });
      break; // hold the connection lock until release()
    }
  }

  status(path: string): Promise<any> {
    const spec = this.folders.get(path);
    if (!spec) return Promise.reject(new Error(`Mailbox "${path}" does not exist`));
    return Promise.resolve({
      messages: spec.messages.size,
      recent: 0,
      unseen: 1,
      uidNext: spec.uidNext,
      uidValidity: spec.uidValidity,
    });
  }

  private async runUid<T>(cmd: string, uid: number | string, impl: (selection: string | null) => T): Promise<T> {
    const selection = this.mailbox?.path ?? null;
    this.commands.push({ cmd, selection, uid });
    this.events.push(`cmd:${cmd}@${selection}:${uid}`);
    return impl(selection);
  }

  fetchOne(uid: number): Promise<any> {
    return this.runUid('fetchOne', uid, selection => {
      const spec = selection ? this.folders.get(selection) : undefined;
      const marker = spec?.messages.get(uid);
      if (!marker) return null;
      return {
        uid,
        flags: new Set(['\\Seen']),
        source: Buffer.from(`From: sender@synth.test\r\nSubject: ${marker}\r\n\r\nsynthetic body of ${marker}\r\n`),
        size: 96,
      };
    });
  }

  messageFlagsAdd(uid: number | string): Promise<boolean> {
    return this.runUid('messageFlagsAdd', uid, () => true);
  }

  messageMove(uid: number | string, target: string): Promise<any> {
    return this.runUid('messageMove', uid, selection => {
      const spec = selection ? this.folders.get(selection) : undefined;
      const marker = spec?.messages.get(Number(uid));
      if (!marker) throw new Error('Message not found in selected mailbox');
      spec!.messages.delete(Number(uid));
      let dest = this.folders.get(target);
      if (!dest) {
        dest = { uidValidity: 999n, uidNext: 2, flags: [], messages: new Map() };
        this.folders.set(target, dest);
      }
      dest.messages.set(Number(uid), marker);
      return { path: selection, destination: target };
    });
  }

  list(): Promise<any> {
    return Promise.resolve(Array.from(this.folders.keys()).map(path => ({ path, flags: [], delimiter: '/' })));
  }
}

const instances: LockModelingImapFlow[] = [];
let nextInstance: () => LockModelingImapFlow = () => new LockModelingImapFlow();

vi.mock('imapflow', () => ({
  ImapFlow: class {
    constructor() {
      const instance = nextInstance();
      instances.push(instance);
      return instance;
    }
  },
}));

// Two folders in the same account share UID 7 for different messages and
// report different UIDVALIDITY — the exact precondition that makes a
// mis-directed UID command observable.
const INBOX_SPEC: MockFolderSpec = {
  uidValidity: 111n,
  uidNext: 8,
  flags: ['\\Seen', '\\Flagged', '$inbox_keyword'],
  permanentFlags: ['\\Seen', '\\Flagged', '\\*'],
  messages: new Map([[7, 'inbox-msg-7']]),
};
const ARCHIVE_SPEC: MockFolderSpec = {
  uidValidity: 222n,
  uidNext: 8,
  flags: ['\\Seen', '$archive_keyword'],
  permanentFlags: ['\\Seen', '\\*'],
  messages: new Map([[7, 'archive-msg-7']]),
};

const account: ImapAccount = {
  id: 'acc-t01',
  name: 'T01 Synthetic Account',
  host: 'imap.synth.test',
  port: 993,
  user: 'user@synth.test',
  password: SYNTHETIC_PASSWORD,
  tls: true,
};

let imapService: ImapService;
let mockClient: LockModelingImapFlow;
let folderStatusHandler: Function;
const flush = async (turns = 6) => {
  for (let i = 0; i < turns; i++) await new Promise(resolve => setImmediate(resolve));
};

beforeEach(async () => {
  instances.length = 0;
  nextInstance = () => {
    const client = new LockModelingImapFlow();
    client.addFolder('INBOX', { ...INBOX_SPEC, messages: new Map(INBOX_SPEC.messages) });
    client.addFolder('Archive', { ...ARCHIVE_SPEC, messages: new Map(ARCHIVE_SPEC.messages) });
    return client;
  };
  imapService = new ImapService();
  imapService.setAccountManager({
    resolveAccountId: (id: string) => id,
    getAccount: (_id: string) => account,
  } as any);

  const server = {
    registerTool: (_name: string, _schema: any, handler: Function) => {
      if (_name === 'imap_folder_status') folderStatusHandler = handler;
    },
  };
  folderTools(server as any, imapService, { resolveAccountId: (id: string) => id } as any);
  await imapService.connect(account);
  mockClient = instances[0]!;
});

/**
 * Controlled interleaving: operation A locks INBOX and is paused by the lock
 * gate after its SELECT but before its first UID command; operation B is the
 * real imap_folder_status handler asking for Archive. In the fixed flow B
 * must wait for A's release; in the buggy flow B's bare SELECT switches the
 * mailbox mid-operation and A's UID command lands on Archive.
 */
async function runInterleaved(op: 'read' | 'flags' | 'move' | 'delete'): Promise<{ b: any }> {
  mockClient.lockGate = { path: 'INBOX', deferred: makeDeferred() };

  let aPromise: Promise<any>;
  if (op === 'read') {
    aPromise = imapService.getEmailContent(account.id, 'INBOX', 7);
  } else if (op === 'flags') {
    aPromise = imapService.markAsRead(account.id, 'INBOX', 7);
  } else if (op === 'move') {
    aPromise = imapService.moveEmail(account.id, 'INBOX', 7, 'Trash');
  } else {
    aPromise = imapService.bulkDelete(account.id, 'INBOX', [7], 1, undefined, 111);
  }

  // Let A acquire the lock and reach the gate.
  await flush();
  expect(mockClient.events).toContain('lock:granted:INBOX');
  expect(mockClient.events).toContain('gate:await:INBOX');

  const bPromise = folderStatusHandler({ accountId: account.id, folder: 'Archive' })
    .then((r: any) => JSON.parse(r.content[0].text));
  // Let B run as far as it can while A holds the lock.
  await flush();

  mockClient.lockGate.deferred.release();
  const [aResult, b] = await Promise.all([aPromise, bPromise]);
  return { b, aResult };
}

describe('T01: imap_folder_status shares the per-folder mailbox lock (MAIL-01)', () => {
  it('T01-LOCK-READ: gated read on INBOX is not re-pointed to Archive by a concurrent folder_status', async () => {
    const { b, aResult } = await runInterleaved('read');

    expect(aResult.textContent).toContain('inbox-msg-7');
    const read = mockClient.commands.find(c => c.cmd === 'fetchOne');
    expect(read?.selection).toBe('INBOX');
    expect(mockClient.folders.get('Archive')!.messages.get(7)).toBe('archive-msg-7');
    // B waited for A's release before its SELECT ran.
    expect(mockClient.events.indexOf('lock:released:INBOX')).toBeLessThan(
      mockClient.events.indexOf('select:Archive')
    );
    expect(b.uidvalidity).toBe(222);
    expect(b.flags).toContain('$archive_keyword');
    expect(b.customKeywords).toContain('$archive_keyword');
  });

  it('T01-LOCK-FLAGS: gated flag change on INBOX is not re-pointed to Archive', async () => {
    const { b } = await runInterleaved('flags');

    const flag = mockClient.commands.find(c => c.cmd === 'messageFlagsAdd');
    expect(flag?.selection).toBe('INBOX');
    expect(mockClient.folders.get('Archive')!.messages.get(7)).toBe('archive-msg-7');
    expect(mockClient.events.indexOf('lock:released:INBOX')).toBeLessThan(
      mockClient.events.indexOf('select:Archive')
    );
    expect(b.uidvalidity).toBe(222);
  });

  it('T01-LOCK-MOVE: gated move out of INBOX does not move Archive UID 7', async () => {
    const { b } = await runInterleaved('move');

    const move = mockClient.commands.find(c => c.cmd === 'messageMove');
    expect(move?.selection).toBe('INBOX');
    // The moved message is INBOX UID 7, not the same-UID Archive message.
    expect(mockClient.folders.get('Trash')!.messages.get(7)).toBe('inbox-msg-7');
    expect(mockClient.folders.get('Archive')!.messages.get(7)).toBe('archive-msg-7');
    expect(mockClient.events.indexOf('lock:released:INBOX')).toBeLessThan(
      mockClient.events.indexOf('select:Archive')
    );
    expect(b.uidvalidity).toBe(222);
  });

  it('T01-LOCK-DELETE: gated bulk delete out of INBOX does not delete Archive UID 7', async () => {
    const { b, aResult } = await runInterleaved('delete');

    expect(aResult.deleted).toBe(1);
    const move = mockClient.commands.find(c => c.cmd === 'messageMove');
    expect(move?.selection).toBe('INBOX');
    expect(mockClient.folders.get('Trash')!.messages.get(7)).toBe('inbox-msg-7');
    expect(mockClient.folders.get('Archive')!.messages.get(7)).toBe('archive-msg-7');
    expect(mockClient.events.indexOf('lock:released:INBOX')).toBeLessThan(
      mockClient.events.indexOf('select:Archive')
    );
    expect(b.uidvalidity).toBe(222);
  });

  it('T01-SNAPSHOT-01: selectFolder returns a stable snapshot, not the live mailbox reference', async () => {
    const snapshot = await imapService.selectFolder(account.id, 'Archive');
    expect(snapshot.path).toBe('Archive');

    const live = mockClient.mailbox;
    expect(snapshot).not.toBe(live);
    expect(snapshot.flags).not.toBe(live.flags);

    // Server-side mutation of the live mailbox after release must not leak
    // into the already-returned snapshot, and vice versa.
    live.flags.add('$later_keyword');
    expect(snapshot.flags).not.toContain('$later_keyword');
    snapshot.flags.push('$caller_mutation');
    expect(live.flags.has('$caller_mutation')).toBe(false);
  });

  it('T01-LOCK-FAIL-01: failed select does not hold the lock and the queue keeps working', async () => {
    mockClient.failMailboxOpenOnce = {
      path: 'Archive',
      error: new Error('SELECT failed: no such mailbox'),
    };

    // STATUS of a missing folder fails before any lock is involved.
    await expect(
      folderStatusHandler({ accountId: account.id, folder: 'Missing' })
    ).rejects.toThrow();
    // A failed lock grant must not poison the connection's lock queue.
    await expect(
      folderStatusHandler({ accountId: account.id, folder: 'Archive' })
    ).rejects.toThrow();
    // The same folder works again on retry.
    const retry = await folderStatusHandler({ accountId: account.id, folder: 'Archive' });
    const parsed = JSON.parse(retry.content[0].text);
    expect(parsed.uidvalidity).toBe(222);
    expect(mockClient.events.filter(e => e === 'select:Archive')).toHaveLength(1);
  });
});

  // T01 review: the folder_status snapshot must reflect ONE consistent moment
  // — a mailbox that mutates while folder_status waits on the lock yields the
  // post-mutation state across ALL fields, never a mix — and an operation
  // that fails inside its locked section must release the lock for the queue.
  describe('T01R: snapshot consistency and failure release', () => {
    it('T01R-CONSISTENT-SNAPSHOT: a mid-wait mutation yields one consistent post-mutation snapshot', async () => {
      mockClient.lockGate = { path: 'INBOX', deferred: makeDeferred() };

      // A locks INBOX and pauses at the gate; B asks folder_status for the
      // SAME folder and queues behind it.
      const aPromise = imapService.getEmailContent(account.id, 'INBOX', 7);
      await flush();
      const bPromise = folderStatusHandler({ accountId: account.id, folder: 'INBOX' })
        .then((r: any) => JSON.parse(r.content[0].text));
      await flush();

      // While both wait, the mailbox mutates: new UIDVALIDITY, one more
      // message, and a changed flag set.
      mockClient.folders.set('INBOX', {
        uidValidity: 333n,
        uidNext: 9,
        flags: ['\\Seen', '\\Flagged', '$mutated_keyword'],
        permanentFlags: ['\\Seen', '\\Flagged', '\\*'],
        messages: new Map([[7, 'inbox-msg-7'], [8, 'inbox-msg-8']]),
      });
      // A real server pushes mailbox updates into the SELECTED mailbox object;
      // model that so the live object and the spec stay in sync.
      if (mockClient.mailbox && mockClient.mailbox.path === 'INBOX') {
        mockClient.mailbox.uidValidity = 333n;
        mockClient.mailbox.uidNext = 9;
        mockClient.mailbox.exists = 2;
        mockClient.mailbox.flags = new Set(['\\Seen', '\\Flagged', '$mutated_keyword']);
      }

      mockClient.lockGate.deferred.release();
      await Promise.all([aPromise, bPromise]);

      // The queued folder_status was granted AFTER the mutation: every field
      // comes from that same post-mutation moment — no old uidvalidity mixed
      // with new counts, no pre-mutation flags.
      const b = await (async () => bPromise)();
      expect(b.uidvalidity).toBe(333);
      expect(b.messages.total).toBe(2);
      expect(b.flags).toContain('$mutated_keyword');
      expect(b.flags).not.toContain('$cl_3');
    });

    it('T01R-READ-FAIL-RELEASES-LOCK: a failing read releases the lock for the queue', async () => {
      await expect(
        imapService.getEmailContent(account.id, 'INBOX', 99), // uid 99 does not exist
      ).rejects.toThrow(/not found/i);

      // The lock was released despite the failure: the next folder_status
      // acquires the lock and completes.
      const ok = await folderStatusHandler({ accountId: account.id, folder: 'INBOX' });
      const parsed = JSON.parse(ok.content[0].text);
      expect(parsed.uidvalidity).toBe(111);
    });
  });
