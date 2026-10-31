import { describe, it, expect, vi, beforeEach } from 'vitest';
import { folderTools } from '../src/tools/folder-tools.js';

let folderStatusHandler: Function;

const mockServer = {
  registerTool: vi.fn((name: string, _schema: any, handler: Function) => {
    if (name === 'imap_folder_status') {
      folderStatusHandler = handler;
    }
    toolHandlers[name] = handler;
  }),
};

const toolHandlers: Record<string, Function> = {};

const mockImapService = {
  getFolderStatusSnapshot: vi.fn(),
  selectFolder: vi.fn(),
  getFolderStatus: vi.fn(),
  getFolderUnseenStatus: vi.fn(),
  listFolders: vi.fn(async () => []),
  searchEmails: vi.fn(),
};

// The handler consumes ONE locked snapshot: STATUS counts plus the mailbox
// flag object, captured in the same region (T01 review).
const snapshotResponse = (
  statusOverrides: Record<string, number> = {},
  mailboxOverrides: Record<string, unknown> = {},
) => ({
  status: folderStatus(statusOverrides),
  snapshot: mailboxObject(mailboxOverrides),
});

// What imapflow's mailboxOpen() actually resolves to (MailboxObject): flag
// *Sets*, camelCase uid fields, `exists` — and no `messages` object at all.
// The previous mock used node-imap's shape, which is why #138 slipped through.
const mailboxObject = (overrides: Record<string, unknown> = {}) => ({
  path: 'INBOX',
  delimiter: '/',
  flags: new Set(['\\Seen', '\\Flagged', '$cl_3']),
  permanentFlags: new Set(['\\Seen', '\\Flagged', '$cl_3', '\\*']),
  uidValidity: 1234567890n,
  uidNext: 456,
  exists: 21,
  ...overrides,
});

// ImapService.getFolderStatus already normalizes STATUS to plain numbers.
const folderStatus = (overrides: Record<string, number> = {}) => ({
  messages: 21,
  recent: 1,
  unseen: 2,
  uidValidity: 1234567890,
  uidNext: 456,
  ...overrides,
});

const runStatus = async () => {
  const result = await folderStatusHandler({ accountId: 'acc1', folder: 'INBOX' });
  return JSON.parse(result.content[0].text);
};

describe('imap_folder_status Tool Handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    folderTools(mockServer as any, mockImapService as any, { resolveAccountId: (id: string) => id } as any);
  });

  it('derives customKeywords from mailbox flags, excluding system flags', async () => {
    mockImapService.getFolderStatusSnapshot.mockResolvedValueOnce(snapshotResponse());

    expect((await runStatus()).customKeywords).toEqual(['$cl_3']);
  });

  it('returns an empty customKeywords array when the mailbox has no custom keywords', async () => {
    mockImapService.getFolderStatusSnapshot.mockResolvedValueOnce(snapshotResponse(
      { messages: 0, recent: 0, unseen: 0 },
      { flags: new Set(['\\Seen', '\\Deleted']), permanentFlags: new Set(['\\Seen', '\\Deleted']) },
    ));

    expect((await runStatus()).customKeywords).toEqual([]);
  });

  // Regression: the handler used to read node-imap's `box.messages.total`,
  // which imapflow never sets — every call threw "Cannot read properties of
  // undefined (reading 'total')" regardless of provider (#138).
  it('reports message counts from STATUS rather than the mailbox object', async () => {
    mockImapService.getFolderStatusSnapshot.mockResolvedValueOnce(snapshotResponse({ messages: 21, recent: 3, unseen: 7 }));

    expect((await runStatus()).messages).toEqual({ total: 21, new: 3, unseen: 7 });
  });

  it('reports uidvalidity and uidnext instead of dropping them', async () => {
    mockImapService.getFolderStatusSnapshot.mockResolvedValueOnce(snapshotResponse({ uidValidity: 1234567890, uidNext: 99 }));

    const parsed = await runStatus();
    expect(parsed.uidvalidity).toBe(1234567890);
    expect(parsed.uidnext).toBe(99);
  });

  // imapflow hands back Sets; JSON.stringify renders those as {}.
  it('serializes flag sets as arrays', async () => {
    mockImapService.getFolderStatusSnapshot.mockResolvedValueOnce(snapshotResponse());

    const parsed = await runStatus();
    expect(parsed.flags).toEqual(['\\Seen', '\\Flagged', '$cl_3']);
    expect(parsed.permanentFlags).toEqual(['\\Seen', '\\Flagged', '$cl_3', '\\*']);
  });

  it('tolerates a mailbox that omits permanentFlags', async () => {
    mockImapService.getFolderStatusSnapshot.mockResolvedValueOnce(snapshotResponse({}, { permanentFlags: undefined }));

    expect((await runStatus()).permanentFlags).toEqual([]);
  });
});

// T29 / MAIL-06: unread counts come from named STATUS (no metadata download,
// supports mailboxes past the search cap) and a failed or missing-unseen
// folder is reported as unknown — never silently as zero.
describe('T29: imap_get_unread_count semantics', () => {
  let unreadHandler: Function;
  beforeEach(() => {
    unreadHandler = toolHandlers['imap_get_unread_count'];
    mockImapService.searchEmails.mockReset();
  });

  const run = async (args: any) => JSON.parse((await unreadHandler({ accountId: 'acc1', ...args })).content[0].text);

  it('T29-STATUS-COUNT: counts via STATUS without downloading metadata', async () => {
    mockImapService.listFolders.mockResolvedValue([{ name: 'INBOX' }, { name: 'Archive' }]);
    mockImapService.getFolderUnseenStatus
      .mockResolvedValueOnce({ unseen: 3 })
      .mockResolvedValueOnce({ unseen: 39 });

    const parsed = await run({});

    expect(mockImapService.searchEmails).not.toHaveBeenCalled();
    expect(parsed.byFolder).toEqual({ INBOX: 3, Archive: 39 });
    expect(parsed.totalUnread).toBe(42);
    expect(parsed.complete).toBe(true);
  });

  it('T29-FAIL-NOT-ZERO: a folder that cannot be queried is unknown, not zero', async () => {
    mockImapService.listFolders.mockResolvedValue([{ name: 'INBOX' }, { name: 'Locked' }]);
    mockImapService.getFolderUnseenStatus
      .mockResolvedValueOnce({ unseen: 1 })
      .mockResolvedValueOnce({ unknownReason: 'status_failed: NO' });

    const parsed = await run({});

    expect(parsed.byFolder).toEqual({ INBOX: 1 });
    expect(parsed.byFolder['Locked']).toBeUndefined();
    expect(parsed.unknownFolders).toEqual(['Locked']);
    expect(parsed.totalUnread).toBe(1);
    expect(parsed.complete).toBe(false);
  });

  it('T29-LARGE-MAILBOX: STATUS counts past the search cap', async () => {
    mockImapService.listFolders.mockResolvedValue([{ name: 'INBOX' }]);
    mockImapService.getFolderUnseenStatus.mockResolvedValue({ unseen: 12000 });

    const parsed = await run({});

    expect(parsed.byFolder.INBOX).toBe(12000);
    expect(parsed.totalUnread).toBe(12000);
    expect(parsed.complete).toBe(true);
  });

  it('T29-EXPLICIT-FOLDERS: an explicitly requested unknown folder stays unknown', async () => {
    mockImapService.getFolderUnseenStatus.mockResolvedValue({ unknownReason: 'status_failed: NO' });

    const parsed = await run({ folders: ['Broken'] });

    expect(parsed.unknownFolders).toEqual(['Broken']);
    expect(parsed.complete).toBe(false);
  });
  it('T29R-CONNECTION-FAIL-KEEPS-COUNTS: an auth failure after one folder keeps counts and marks the rest unknown', async () => {
    mockImapService.listFolders.mockResolvedValue([{ name: 'INBOX' }, { name: 'Locked' }, { name: 'Locked2' }]);
    mockImapService.getFolderUnseenStatus
      .mockResolvedValueOnce({ unseen: 5 })
      .mockRejectedValueOnce(new Error('AUTHENTICATION failed'))
      .mockRejectedValueOnce(new Error('AUTHENTICATION failed'));

    const parsed = await run({});

    expect(parsed.byFolder).toEqual({ INBOX: 5 });
    expect(parsed.totalUnread).toBe(5);
    expect(parsed.unknownFolders).toEqual(['Locked', 'Locked2']);
    expect(parsed.complete).toBe(false);
  });

});
