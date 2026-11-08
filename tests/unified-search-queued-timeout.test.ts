import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { unifiedSearchTools } from '../src/tools/unified-search-tools.js';
import { createHash } from 'node:crypto';
import { accountRevision } from '../src/utils/account-revision.js';

// B4: when the overall deadline expired while an account was still queued,
// the early-return branch emitted a bare cursor — dropping the account's
// folder, beforeUid and uidValidity from the input cursors, so the next
// pass re-scanned that account from scratch. A queued timeout must carry
// every unfinished folder's resume position forward.

const ACCOUNTS = [
  { id: 'slow-1', name: 'slow-one', host: 'imap.a.synth.test' },
  { id: 'slow-2', name: 'slow-two', host: 'imap.b.synth.test' },
  { id: 'slow-3', name: 'slow-three', host: 'imap.c.synth.test' },
  { id: 'queued', name: 'queued-acct', host: 'imap.d.synth.test' },
];

const filterKey = createHash('sha256')
  .update(JSON.stringify({ criteria: {}, limit: 50, searchAllFolders: true, folder: 'INBOX', includeTrash: false, includeSpam: false, includeDrafts: false }))
  .digest('hex');

const revision = (account: { id: string; name: string; host: string }) =>
  accountRevision({ id: account.id, name: account.name, host: account.host } as any);

const cursorFor = (account: typeof ACCOUNTS[number], extra: Record<string, unknown> = {}) => ({
  accountId: account.id,
  accountName: account.name,
  accountRevision: revision(account),
  filterKey,
  ...extra,
});

function setup() {
  let handler: any;
  const manager = {
    getAllAccounts: () => ACCOUNTS,
    resolveAccountId: (_id: string | undefined, name: string | undefined) => {
      const found = ACCOUNTS.find(a => a.name === name);
      if (!found) throw new Error('missing');
      return found.id;
    },
  };
  const imap = {
    listFolders: vi.fn(async (id: string) => [{ name: 'INBOX', delimiter: '/', attributes: [] }, { name: 'Archive', delimiter: '/', attributes: [] }]),
    searchEmailPage: vi.fn(async (id: string) => {
      if (id === 'queued') return { messages: [], matched: 0 };
      return new Promise(() => {}); // slow accounts hang until their account timeout
    }),
    abortConnection: vi.fn(),
  };
  unifiedSearchTools(
    { registerTool: (_n: string, _s: any, h: any) => { handler = h; } } as any,
    imap as any,
    manager as any,
    // The per-account timeout sits BEYOND the overall deadline, so the slow
    // accounts only free their workers after the overall deadline is spent —
    // the queued account then starts with nothing left on the clock.
    { accountTimeoutMs: 5_000, overallTimeoutMs: 1_000 },
  );
  return { handler, imap };
}

describe('B4: queued-timeout keeps the account resume positions', () => {
  beforeEach(() => { vi.useFakeTimers({ now: 1_000_000 }); });
  afterEach(() => { vi.useRealTimers(); });

  const queuedTimeoutResult = async (cursors: any[]) => {
    const { handler, imap } = setup();
    const pending = handler({ cursors, limit: 50 });
    await vi.advanceTimersByTimeAsync(1_500);
    const result = JSON.parse((await pending).content[0].text);
    const queued = result.accounts.find((a: any) => a.accountId === 'queued');
    return { result, queued, imap };
  };

  it('B4-QUEUED-MULTI-FOLDER: a queued timeout preserves every folder cursor with its position', async () => {
    const cursors = [
      cursorFor(ACCOUNTS[0], { folder: 'INBOX', beforeUid: 5, uidValidity: 123 }),
      cursorFor(ACCOUNTS[1], { folder: 'INBOX', beforeUid: 5, uidValidity: 123 }),
      cursorFor(ACCOUNTS[2], { folder: 'INBOX', beforeUid: 5, uidValidity: 123 }),
      cursorFor(ACCOUNTS[3], { folder: 'INBOX', beforeUid: 7, uidValidity: 111 }),
      cursorFor(ACCOUNTS[3], { folder: 'Archive', beforeUid: 9, uidValidity: 222 }),
    ];

    const { result, queued, imap } = await queuedTimeoutResult(cursors);

    expect(queued.status).toBe('timeout');
    // The queued account never dialed: it was never started.
    expect(imap.searchEmailPage).not.toHaveBeenCalledWith('queued', expect.anything(), expect.anything(), expect.anything());
    const queuedCursors = result.cursors.filter((c: any) => c.accountId === 'queued');
    expect(queuedCursors).toHaveLength(2);
    expect(queuedCursors.map((c: any) => [c.folder, c.beforeUid, c.uidValidity]).sort())
      .toEqual([['Archive', 9, 222], ['INBOX', 7, 111]]);
  });

  it('B4-QUEUED-UIDVALIDITY-RESET: a folder cursor without a position (UIDVALIDITY reset shape) keeps its folder', async () => {
    const cursors = [
      cursorFor(ACCOUNTS[0], { folder: 'INBOX', beforeUid: 5, uidValidity: 123 }),
      cursorFor(ACCOUNTS[1], { folder: 'INBOX', beforeUid: 5, uidValidity: 123 }),
      cursorFor(ACCOUNTS[2], { folder: 'INBOX', beforeUid: 5, uidValidity: 123 }),
      // After a mid-pass UIDVALIDITY change the folder cursor carries no
      // beforeUid/uidValidity — the folder itself must still survive.
      cursorFor(ACCOUNTS[3], { folder: 'Archive' }),
    ];

    const { result, queued } = await queuedTimeoutResult(cursors);

    expect(queued.status).toBe('timeout');
    const queuedCursors = result.cursors.filter((c: any) => c.accountId === 'queued');
    expect(queuedCursors).toHaveLength(1);
    expect(queuedCursors[0].folder).toBe('Archive');
    expect(queuedCursors[0].beforeUid).toBeUndefined();
    expect(queuedCursors[0].uidValidity).toBeUndefined();
  });

  it('B4-QUEUED-FIRST-SEARCH: a queued account without cursors still emits a bare restart cursor', async () => {
    const { handler } = setup();
    const pending = handler({ limit: 50 });
    await vi.advanceTimersByTimeAsync(1_500);
    const result = JSON.parse((await pending).content[0].text);

    const queued = result.accounts.find((a: any) => a.accountId === 'queued');
    expect(queued.status).toBe('timeout');
    const queuedCursors = result.cursors.filter((c: any) => c.accountId === 'queued');
    expect(queuedCursors).toHaveLength(1);
    expect(queuedCursors[0].accountName).toBe('queued-acct');
    expect(queuedCursors[0].folder).toBeUndefined();
  });

  it('B4-QUEUED-VALIDATION: identity, revision and filter checks stay enforced', async () => {
    const { handler } = setup();
    // Wrong revision on the queued account's cursor is still rejected.
    await expect(handler({
      limit: 50,
      cursors: [
        cursorFor(ACCOUNTS[0], { folder: 'INBOX', beforeUid: 5, uidValidity: 123 }),
        cursorFor(ACCOUNTS[1], { folder: 'INBOX', beforeUid: 5, uidValidity: 123 }),
        cursorFor(ACCOUNTS[2], { folder: 'INBOX', beforeUid: 5, uidValidity: 123 }),
        { ...cursorFor(ACCOUNTS[3], { folder: 'INBOX', beforeUid: 7, uidValidity: 111 }), accountRevision: 'x'.repeat(16) },
      ],
    })).rejects.toThrow(/identity changed/);
  });
});
