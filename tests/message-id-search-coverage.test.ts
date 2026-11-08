import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ImapService } from '../src/services/imap-service.js';
import type { ImapAccount } from '../src/types/index.js';

// B3: findEmailByMessageId used to swallow per-folder search errors and
// silently truncate past 25 folders, so found:false could mean "searched
// everywhere", "half the folders errored" or "range never searched". The
// result now reports status/complete/foldersFailed/foldersPending so the
// caller can judge coverage. Exact Message-ID verification is unchanged.

let mockInstance: any;

vi.mock('imapflow', () => {
  return {
    ImapFlow: class {
      constructor() {
        Object.assign(this, mockInstance);
        for (const key of ['connect', 'logout', 'close', 'list', 'mailboxOpen', 'getMailboxLock', 'search', 'fetch', 'fetchOne', 'status', 'on']) {
          (this as any)[key] = typeof mockInstance[key] === 'function' ? mockInstance[key].bind(mockInstance) : mockInstance[key];
        }
      }
    },
  };
});

const SYNTHETIC_PASSWORD = ['synth', 'pass'].join('');

const message = (messageId: string) => ({
  uid: 7,
  internalDate: new Date('2026-01-01T00:00:00Z'),
  envelope: { subject: 'B3', messageId, from: [{ address: 'a@synth.test' }], to: [] },
  flags: new Set<string>(),
});

const harness = () => {
  let currentFolder = '';
  const listMock = vi.fn();
  const getMailboxLockMock = vi.fn(async (name: string) => {
    currentFolder = name;
    return { release: vi.fn() };
  });
  const searchMock = vi.fn(async () => []);
  const fetchMock = vi.fn();
  mockInstance = {
    connect: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    close: vi.fn(),
    list: listMock,
    mailboxOpen: vi.fn(async () => ({})),
    getMailboxLock: getMailboxLockMock,
    search: searchMock,
    fetch: fetchMock,
    fetchOne: vi.fn(async () => null),
    status: vi.fn(async () => ({ messages: 0 })),
    on: vi.fn(),
    usable: true,
    capabilities: new Map([['IMAP4rev1', true]]),
  };
  const svc = new ImapService();
  const account: ImapAccount = {
    id: 'b3-acc',
    name: 'B3 Account',
    host: 'imap.synth.test',
    port: 993,
    user: 'user@synth.test',
    password: SYNTHETIC_PASSWORD,
    tls: true,
  };
  // One-message iterator per fetch call, keyed by the folder under lock.
  fetchMock.mockImplementation(() => {
    const messageId = currentFolder === 'HasIt' ? '<b3-target@synth.test>' : '<prefix-b3-target@synth.test>';
    let used = false;
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          if (used) return { done: true as const };
          used = true;
          return { done: false as const, value: message(messageId) };
        },
      }),
    };
  });
  return { svc, account, listMock, searchMock, getMailboxLockMock };
};

const folders = (names: string[]) => names.map(path => ({ path, delimiter: '/', flags: [] }));

describe('B3: Message-ID lookup reports coverage explicitly', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('B3-ALL-FAILED: every folder search failing is partial, not a clean not-found', async () => {
    const { svc, account, listMock, searchMock } = harness();
    listMock.mockResolvedValue(folders(['INBOX', 'Archive']));
    searchMock.mockRejectedValue(new Error('select failed'));

    await svc.connect(account);
    const res = await svc.findEmailByMessageId(account.id, '<b3-target@synth.test>');

    expect(res.found).toBe(false);
    expect(res.status).toBe('partial');
    expect(res.complete).toBe(false);
    expect(res.foldersSearched).toEqual([]);
    expect(res.foldersFailed).toEqual([
      { folder: 'INBOX', error: 'select failed' },
      { folder: 'Archive', error: 'select failed' },
    ]);
  });

  it('B3-PARTIAL-FAILURE: a failed folder is a coverage hole between searched folders', async () => {
    const { svc, account, listMock, searchMock, getMailboxLockMock } = harness();
    listMock.mockResolvedValue(folders(['INBOX', 'Broken', 'Archive']));
    getMailboxLockMock.mockImplementation(async (name: string) => {
      if (name === 'Broken') throw new Error('mailbox vanished');
      return { release: vi.fn() };
    });

    await svc.connect(account);
    const res = await svc.findEmailByMessageId(account.id, '<b3-target@synth.test>');

    expect(res.found).toBe(false);
    expect(res.status).toBe('partial');
    expect(res.complete).toBe(false);
    expect(res.foldersSearched).toEqual(['INBOX', 'Archive']);
    expect(res.foldersFailed).toEqual([{ folder: 'Broken', error: 'mailbox vanished' }]);
    expect(searchMock).toHaveBeenCalledTimes(2);
  });

  it('B3-NOT-FOUND-COMPLETE: full coverage without a match is an explicit not-found', async () => {
    const { svc, account, listMock, searchMock } = harness();
    listMock.mockResolvedValue(folders(['INBOX', 'Archive']));
    searchMock.mockResolvedValue([]);

    await svc.connect(account);
    const res = await svc.findEmailByMessageId(account.id, '<b3-target@synth.test>');

    expect(res.found).toBe(false);
    expect(res.status).toBe('not_found');
    expect(res.complete).toBe(true);
    expect(res.foldersSearched).toEqual(['INBOX', 'Archive']);
    expect(res.foldersFailed).toBeUndefined();
    expect(res.foldersPending).toBeUndefined();
  });

  it('B3-CAP: folders past the 25-folder cap are reported as pending, not dropped', async () => {
    const { svc, account, listMock, searchMock } = harness();
    listMock.mockResolvedValue(folders(Array.from({ length: 27 }, (_, i) => `F${String(i + 1).padStart(2, '0')}`)));
    searchMock.mockResolvedValue([]);

    await svc.connect(account);
    const res = await svc.findEmailByMessageId(account.id, '<b3-target@synth.test>');

    expect(res.found).toBe(false);
    expect(res.status).toBe('partial');
    expect(res.complete).toBe(false);
    expect(res.foldersSearched).toHaveLength(25);
    expect(res.foldersPending).toEqual(['F26', 'F27']);
  });

  it('B3-FOUND: a match reports found with the exact-ID verification intact', async () => {
    const { svc, account, listMock, searchMock } = harness();
    listMock.mockResolvedValue(folders(['INBOX', 'HasIt', 'Archive']));
    searchMock.mockResolvedValue([7]);

    await svc.connect(account);
    const res = await svc.findEmailByMessageId(account.id, '<b3-target@synth.test>');

    expect(res.found).toBe(true);
    expect(res.status).toBe('found');
    expect(res.folder).toBe('HasIt');
    expect(res.uid).toBe(7);
    expect(res.foldersPending).toEqual(['Archive']);
  });

  it('B3-SUBSTRING-REJECTED: a server substring hit with a different Message-ID does not match', async () => {
    const { svc, account, listMock, searchMock } = harness();
    listMock.mockResolvedValue(folders(['INBOX', 'Archive']));
    searchMock.mockResolvedValue([7]);

    await svc.connect(account);
    // The fetch harness returns '<prefix-b3-target@synth.test>' outside the
    // 'HasIt' folder — a server substring match that must be rejected.
    const res = await svc.findEmailByMessageId(account.id, '<b3-target@synth.test>');

    expect(res.found).toBe(false);
    expect(res.status).toBe('not_found');
    expect(res.complete).toBe(true);
  });
});
