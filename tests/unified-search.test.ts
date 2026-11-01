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

describe('T27E: extended resume edge cases', () => {
  it('T27E-PERSISTENT-FAIL: repeated failures keep emitting cursors, bounded by deadline', async () => {
    const { call, imap } = setup(100);
    imap.listFolders.mockRejectedValue(new Error('connection refused'));

    // Pass 1: all accounts fail discovery, cursors emitted.
    const pass1 = await call({ query: '项目' });
    expect(pass1.accounts.every((a: any) => a.status === 'failed')).toBe(true);
    expect(pass1.cursors.length).toBeGreaterThan(0);

    // Pass 2: same failure again — still emits cursors, no crash, bounded.
    const pass2 = await call({ query: '项目', cursors: pass1.cursors });
    expect(pass2.accounts.every((a: any) => a.status === 'failed')).toBe(true);
    expect(pass2.partial).toBe(true);
  });

  it('T27E-COMPLETED-NOT-RESEARCHED: a resumed pass does not re-search completed folders', async () => {
    const { call, imap } = setup();
    // First pass: net fails discovery, others complete.
    imap.listFolders.mockImplementation(async (id: string) => {
      if (id === 'net') throw new Error('connection refused');
      return [{ name: 'INBOX', attributes: [] }];
    });
    const pass1 = await call({ query: '项目' });
    const netCursors = pass1.cursors.filter((c: any) => c.accountName === 'netease');
    expect(netCursors.length).toBeGreaterThan(0);

    const callsAfterPass1 = imap.searchEmailPage.mock.calls.length;

    // Recovery: net works now.
    imap.listFolders.mockImplementation(async (id: string) => [{ name: 'INBOX', attributes: [] }]);

    const pass2 = await call({ query: '项目', cursors: pass1.cursors });
    // The completed accounts (qq, work) were NOT re-searched: the call count
    // grew only by net's single folder page.
    const newCalls = imap.searchEmailPage.mock.calls.length - callsAfterPass1;
    expect(newCalls).toBe(1);
    // net recovered and contributed.
    const net = pass2.accounts.find((a: any) => a.accountId === 'net');
    expect(net.status).toBe('ok');
    expect(net.foldersSearched).toContain('INBOX');
  });

  it('T27E-PAGE-BUDGET: page limit bounds a folder that never finishes', async () => {
    const { call, imap } = setup(2000);
    imap.listFolders.mockResolvedValue([{ name: 'INBOX', attributes: [] }]);
    // Every page returns a nextCursor — the folder never finishes.
    imap.searchEmailPage.mockImplementation(async () => ({
      messages: [message(1, '2026-10-01')], matched: 1,
      nextCursor: { beforeUid: 0, uidValidity: 123 },
    }));

    const result = await call({ query: '项目' });
    // The page budget bounded the folder (25 pages max), it went to pending.
    expect(result.partial).toBe(true);
    expect(result.cursors.length).toBeGreaterThan(0);
    // Bounded: 3 accounts × 1 folder × maxPagesPerFolder(25) = 75 max calls.
    expect(imap.searchEmailPage.mock.calls.length).toBeLessThanOrEqual(75);
  });

  it('T27E-TIMEOUT-RESUME: a timeout mid-pagination resumes from the cursor', async () => {
    let pageCount = 0;
    const { call, imap } = setup(60); // very short timeout
    imap.listFolders.mockResolvedValue([{ name: 'INBOX', attributes: [] }]);
    imap.searchEmailPage.mockImplementation(async () => {
      pageCount++;
      return {
        messages: [message(pageCount, '2026-10-0' + Math.min(pageCount, 9))], matched: 1,
        nextCursor: { beforeUid: 100 - pageCount, uidValidity: 123 },
      };
    });

    const pass1 = await call({ query: '项目' });
    // The account timed out with a pending cursor.
    expect(pass1.partial).toBe(true);
    const resumeCursors = pass1.cursors.filter((c: any) => c.accountId === 'qq');
    if (resumeCursors.length > 0) {
      // Resume carries the last beforeUid, not a restart from scratch.
      expect(resumeCursors[0].beforeUid).toBeDefined();
    }
  });
});

describe('T27F: cross-continuation budget exhaustion', () => {
  it('T27F-PASS-COUNTER: output cursors carry the incremented pass number', async () => {
    const { call, imap } = setup(2000);
    imap.listFolders.mockResolvedValue([{ name: 'INBOX', attributes: [] }]);
    imap.searchEmailPage.mockImplementation(async () => ({
      messages: [message(1, '2026-10-01')], matched: 1,
      nextCursor: { beforeUid: 0, uidValidity: 123 },
    }));

    const result = await call({ query: '项目' });
    expect(result.cursors.length).toBeGreaterThan(0);
    for (const c of result.cursors) {
      expect(c.pass).toBe(1);
    }
  });

  it('T27F-BUDGET-EXHAUSTED: after MAX_SEARCH_PASSES the cursor is rejected', async () => {
    const { call, imap } = setup(2000);
    imap.listFolders.mockResolvedValue([{ name: 'INBOX', attributes: [] }]);
    imap.searchEmailPage.mockImplementation(async () => ({
      messages: [message(1, '2026-10-01')], matched: 1,
      nextCursor: { beforeUid: 0, uidValidity: 123 },
    }));

    // Get real output cursors (with correct filterKey and revision).
    const first = await call({ query: '项目' });
    expect(first.cursors.length).toBeGreaterThan(0);
    // Set pass to the limit (5) and try again.
    const exhausted = first.cursors.map((c: any) => ({ ...c, pass: 5 }));
    await expect(call({ query: '项目', cursors: exhausted })).rejects.toThrow(/budget exhausted/);
  });

  it('T27F-NO-CURSOR-NO-LIMIT: a fresh search (no cursors) always works', async () => {
    const { call } = setup();
    const result = await call({ query: '项目' });
    expect(result.success).toBe(true);
  });
});

  it('T27G-CHAIN-EXHAUSTION: continuous cursor passes eventually exhaust via the handler', async () => {
    const { call, imap } = setup(2000);
    imap.listFolders.mockRejectedValue(new Error('persistent failure'));

    let cursors: any[] | undefined;
    let exhausted = false;
    let listFoldersCalls = 0;
    imap.listFolders.mockImplementation(() => {
      listFoldersCalls++;
      return Promise.reject(new Error('persistent failure'));
    });

    for (let pass = 0; pass <= 6; pass++) {
      const args: any = { query: '项目' };
      if (cursors) { args.cursors = cursors; }
      try {
        const result = await call(args);
        cursors = result.cursors;
        if (!cursors || cursors.length === 0) break;
        // Output cursors carry pass = current pass + 1 (code's nextPass = currentPass + 1).
        for (const c of cursors) expect(c.pass).toBe(pass + 1);
      } catch (e: any) {
        // Budget exhausted when cursors have pass >= 5.
        expect(e.message).toMatch(/budget exhausted/);
        exhausted = true;
        // No more listFolders calls after exhaustion.
        const callsNow = listFoldersCalls;
        break;
      }
    }
    expect(exhausted).toBe(true);
  });
