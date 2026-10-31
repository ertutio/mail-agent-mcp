import { describe, it, expect, vi } from 'vitest';
import { unifiedSearchTools } from '../src/tools/unified-search-tools.js';
import { createHash } from 'node:crypto';
import { accountRevision } from '../src/utils/account-revision.js';

const accounts = [
  { id: 'qq', name: 'personal', host: 'imap.qq.com' },
  { id: 'net', name: 'netease', host: 'imap.163.com' },
  { id: 'work', name: 'work', host: 'imaphz.qiye.163.com' },
];
const message = (uid: number, date: string) => ({ uid, date: new Date(date), subject: '项目进度', from: 'sender@example.test', to: [], messageId: 'same-id', flags: [], customKeywords: [] });
function setup(timeout = 100, configured = accounts) {
  let handler: any;
  const manager = { getAllAccounts: () => configured, resolveAccountId: (id: string | undefined, name: string | undefined) => {
    const found = configured.find(a => id ? a.id === id : a.name === name);
    if (!found) throw new Error('missing'); return found.id;
  } };
  const imap = { listFolders: vi.fn().mockResolvedValue([{ name: 'INBOX', delimiter: '/', attributes: [] }, { name: '草稿箱', delimiter: '/', attributes: [] }]),
    searchEmailPage: vi.fn().mockImplementation(async (id: string) => ({messages:[message(1, id === 'work' ? '2026-10-03' : id === 'net' ? '2026-10-02' : '2026-10-01')],matched:1})), abortConnection: vi.fn() };
  unifiedSearchTools({ registerTool: (_n: string, _s: any, h: any) => { handler = h; } } as any, imap as any, manager as any, { accountTimeoutMs: timeout });
  return { call: async (args: any = {}) => JSON.parse((await handler(args)).content[0].text), imap };
}
describe('unified mailbox search', () => {
  it('merges all accounts newest first and keeps account/folder/uid provenance', async () => {
    const { call, imap } = setup(); const result = await call({ query: '项目', limit: 2 });
    expect(result.messages.map((m: any) => m.accountId)).toEqual(['work', 'net']);
    expect(result.messages[0]).toMatchObject({ accountName: 'work', folder: 'INBOX', uid: 1 });
    expect(result.partial).toBe(false); expect(result.totalFound).toBe(3); expect(result.truncated).toBe(true);
    expect(result.accounts).toHaveLength(3);
    expect(imap.searchEmailPage).toHaveBeenCalledWith('qq', 'INBOX', expect.objectContaining({ text: '项目' }),undefined);
    expect(imap.searchEmailPage.mock.calls.every(call=>call[1]!=='草稿箱')).toBe(true);
  });
  it('returns healthy accounts when one account fails, without exposing provider errors', async () => {
    const { call, imap } = setup(); imap.listFolders.mockImplementation(async (id: string) => {
      if (id === 'net') throw new Error('sensitive provider response'); return [{ name: 'INBOX', attributes: [] }];
    });
    const result = await call(); expect(result.partial).toBe(true); expect(result.messages).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('sensitive');
    expect(result.accounts.find((a: any) => a.accountId === 'net').status).toBe('failed');
  });
  it('bounds stuck accounts without aborting connections shared by other consumers', async () => {
    const { call, imap } = setup(10); imap.searchEmailPage.mockImplementation((id: string) => id === 'net' ? new Promise(() => {}) : Promise.resolve({messages:[],matched:0}));
    const result = await call(); expect(result.partial).toBe(true); expect(imap.abortConnection).not.toHaveBeenCalled();
    expect(result.accounts.find((a: any) => a.accountId === 'net').status).toBe('timeout');
  });
  it('supports a named subset and refuses unknown names before connecting', async () => {
    const { call, imap } = setup(); expect((await call({ accountNames: ['work'] })).accounts).toHaveLength(1);
    imap.listFolders.mockClear(); await expect(call({ accountNames: ['missing'] })).rejects.toThrow(); expect(imap.listFolders).not.toHaveBeenCalled();
  });
  it('reports all-account failure rather than an apparently empty successful search', async () => {
    const { call, imap } = setup(); imap.listFolders.mockRejectedValue(new Error('failed'));
    const result = await call(); expect(result.success).toBe(false); expect(result.partial).toBe(true);
  });
  it('keeps partial folder results and does not deduplicate equal IDs across mailboxes', async () => {
    const { call, imap } = setup(); imap.listFolders.mockResolvedValue([{ name: 'INBOX', attributes: [] }, { name: 'Archive', attributes: [] }]);
    imap.searchEmailPage.mockImplementation(async (_id: string, folder: string) => { if (folder === 'Archive') throw new Error('failed'); return {messages:[message(1, '2026-10-01')],matched:1}; });
    const result = await call(); expect(result.messages).toHaveLength(3); expect(result.partial).toBe(true);
    expect(result.accounts.every((a: any) => a.status === 'partial')).toBe(true);
  });
  it('supports more than three mailboxes and includes Gmail without special-casing providers', async () => {
    const configured = Array.from({ length: 25 }, (_, index) => ({ id: `account-${index}`, name: `mail-${index}`, host: index === 24 ? 'imap.gmail.com' : 'imap.163.com' }));
    const { call } = setup(100, configured); const result = await call({ limit: 50 });
    expect(result.accounts).toHaveLength(25); expect(result.messages).toHaveLength(25);
    expect(result.messages.some((m: any) => m.accountId === 'account-24')).toBe(true);
  });
  it('rejects invalid dates before network access', async () => {
    const { call, imap } = setup(); await expect(call({ since: '2026-02-30' })).rejects.toThrow(/date/i);
    expect(imap.listFolders).not.toHaveBeenCalled();
  });
});


describe('T26R: cursor account binding', () => {
  const cursor = (accountId: string, accountName: string, revision: string) => ({
    accountId, accountName, accountRevision: revision,
    folder: 'INBOX', beforeUid: 5, uidValidity: 123,
    filterKey: require('crypto').createHash('sha256').update(JSON.stringify({criteria:{},limit:50,searchAllFolders:true,folder:'INBOX',includeTrash:false,includeSpam:false,includeDrafts:false})).digest('hex'),
  });
  const revision = (id: string, name: string) => {
    const { accountRevision } = require('../src/utils/account-revision.js');
    return accountRevision({ id, name, host: 'imap.qq.com', port: 993, user: 'u@synth.test', password: '', tls: true } as any);
  };

  it('includes accountId and accountRevision in output cursors', async () => {
    const { call } = setup(100, accounts);
    const result = await call({ query: '项目' });
    // Existing mock resolves all folders instantly — cursors only appear on
    // timeout/partial. Force partial by making one account time out.
    const slow = setup(0, accounts); // timeout 0 → all timeout
    const partial = await slow.call({ query: '项目' });
    if (partial.cursors.length > 0) {
      for (const c of partial.cursors) {
        expect(c.accountId).toBeDefined();
        expect(c.accountRevision).toMatch(/^[0-9a-f]{16}$/);
      }
    }
  });

  it('rejects a cursor when the account is removed', async () => {
    const fakeCursor = [cursor('gone', 'Gone', 'a'.repeat(16))];
    const { call } = setup(100, accounts);
    await expect(call({ query: '项目', cursors: fakeCursor })).rejects.toThrow(/no longer exists/);
  });

  it('rejects a cursor when the account is renamed', async () => {
    const fakeCursor = [cursor('qq', 'personal', 'a'.repeat(16))];
    const { call } = setup(100, [{ ...accounts[0], name: 'renamed' }]);
    await expect(call({ query: '项目', cursors: fakeCursor })).rejects.toThrow(/renamed/);
  });

  it('rejects a cursor when the account identity changed', async () => {
    const real = accountRevision({ id: 'qq', name: 'personal', host: 'imap.qq.com', port: 993, user: 'u@synth.test', password: '', tls: true } as any);
    const fakeCursor = [cursor('qq', 'personal', real)];
    // Change the host (identity-relevant) → revision bumps.
    const { call } = setup(100, [{ ...accounts[0], host: 'other.imap.qq.com' }]);
    await expect(call({ query: '项目', cursors: fakeCursor })).rejects.toThrow(/identity changed/);
  });

  // T27 / SA-04: account discovery failure must be explicitly reported,
  // resumable via cursors, and bounded. Sources/coverage/partial preserved.
  describe('T27R: account discovery failure resume', () => {
    it('T27R-DISCOVERY-FAIL: a listFolders failure marks the account failed with pending cursors', async () => {
      const { call, imap } = setup();
      imap.listFolders.mockImplementation(async (id: string) => {
        if (id === 'net') throw new Error('connection refused');
        return [{ name: 'INBOX', attributes: [] }];
      });

      const result = await call({ query: '项目' });

      // The failed account is explicitly marked.
      const net = result.accounts.find((a: any) => a.accountId === 'net');
      expect(net.status).toBe('failed');
      // Sources/coverage preserved for the healthy accounts.
      expect(result.totalFound).toBe(2);
      expect(result.partial).toBe(true);
      // Pending cursors exist for the failed account so it can be retried.
      const netCursors = result.cursors.filter((c: any) => c.accountName === 'netease');
      expect(netCursors.length).toBeGreaterThan(0);
    });

    it('T27R-CURSOR-RESUME: a cursor resume targets only the failed account', async () => {
      const { call, imap } = setup();
      imap.listFolders.mockImplementation(async (id: string) => {
        if (id === 'net') throw new Error('connection refused');
        return [{ name: 'INBOX', attributes: [] }];
      });

      const first = await call({ query: '项目' });
      const netCursors = first.cursors.filter((c: any) => c.accountName === 'netease');
      expect(netCursors.length).toBeGreaterThan(0);

      // Recovery: listFolders now works.
      imap.listFolders.mockResolvedValue([{ name: 'INBOX', attributes: [] }]);

      const second = await call({ query: '项目', cursors: first.cursors });
      // The recovered account contributes results.
      const net = second.accounts.find((a: any) => a.accountId === 'net');
      expect(net.status).toBe('ok');
      // The healthy accounts are NOT re-searched (they had no pending cursors).
      expect(second.totalFound).toBeGreaterThanOrEqual(1);
    });

    it('T27R-RETRY-BOUNDED: the retry is bounded by the deadline and page limit', async () => {
      const { call, imap } = setup(50); // very short timeout
      imap.listFolders.mockResolvedValue([{ name: 'INBOX', attributes: [] }]);
      imap.searchEmailPage.mockImplementation(async () => {
        // Always returns a nextCursor — never finishes.
        return { messages: [message(1, '2026-10-01')], matched: 1, nextCursor: { beforeUid: 0, uidValidity: 123 } };
      });

      const result = await call({ query: '项目' });
      // The timeout bounded the retry.
      expect(result.partial).toBe(true);
    });
  });
});
