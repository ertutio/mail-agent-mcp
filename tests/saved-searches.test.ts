import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listSavedSearches, upsertSavedSearch, getSavedSearch, deleteSavedSearch,
} from '../src/utils/saved-searches.js';
import { findUnansweredReminders, type ReminderMessage } from '../src/utils/mail-reminders.js';
import { savedSearchTools } from '../src/tools/saved-search-tools.js';
import { ImapService } from '../src/services/imap-service.js';

// F5: saved searches persist in the local config directory with the T31
// write discipline; the scheduler entries (digest, unanswered reminders)
// summarize metadata only and never schedule by themselves.

describe('F5: saved-search store', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'f5-store-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('F5-STORE-ENOENT: a missing store reads as empty', () => {
    expect(listSavedSearches(dir)).toEqual([]);
  });

  it('F5-STORE-ROUNDTRIP: upsert, update and delete persist exactly', () => {
    const saved = upsertSavedSearch({ name: 'Weekly digest', criteria: { query: '项目', limit: 20 } }, dir);
    expect(getSavedSearch('weekly DIGEST', dir)?.name).toBe('Weekly digest'); // lookup is case-insensitive

    const updated = upsertSavedSearch({ name: 'Weekly digest', criteria: { query: '新条件', limit: 5 }, reminderThresholdDays: 7 }, dir);
    expect(updated.createdAt).toBe(saved.createdAt);
    expect(updated.criteria).toEqual({ query: '新条件', limit: 5 });
    expect(updated.reminderThresholdDays).toBe(7);

    const raw = JSON.parse(readFileSync(join(dir, 'saved-searches.json'), 'utf8'));
    expect(raw).toHaveLength(1);

    expect(deleteSavedSearch('weekly digest', dir)).toBe(true);
    expect(deleteSavedSearch('weekly digest', dir)).toBe(false);
    expect(listSavedSearches(dir)).toEqual([]);
  });

  it('F5-STORE-CORRUPT: a corrupt store fails explicitly and its bytes stay untouched', () => {
    const path = join(dir, 'saved-searches.json');
    writeFileSync(path, '{ not json', 'utf8');
    const before = readFileSync(path, 'utf8');
    expect(() => listSavedSearches(dir)).toThrow(/corrupt/i);
    expect(() => upsertSavedSearch({ name: 'x', criteria: {} }, dir)).toThrow(/corrupt/i);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(existsSync(path + '.tmp')).toBe(false);
  });
});

const message = (overrides: Partial<ReminderMessage>): ReminderMessage => ({
  accountId: 'a1', accountName: 'A1', folder: 'INBOX', uid: 1,
  date: new Date('2026-01-01T00:00:00Z'), subject: 'F5',
  ...overrides,
});

describe('F5: unanswered-reply reminders', () => {
  const NOW = new Date('2026-01-20T00:00:00Z');
  const identities = ['me@a.synth.test', 'other-id@b.synth.test'];
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

  it('F5-REM-UNANSWERED: an old sent message without any reply needs a reminder', () => {
    const reminders = findUnansweredReminders([
      message({ uid: 1, from: 'Me <me@a.synth.test>', messageId: '<s1@t>', subject: 'Quote', date: daysAgo(10) }),
    ], identities, 3, NOW);
    expect(reminders).toHaveLength(1);
    expect(reminders[0].waitingDays).toBe(10);
    expect(reminders[0].sentFrom[0].uid).toBe(1);
  });

  it('F5-REM-ANSWERED: a reply from someone else after the sent message closes the thread', () => {
    const reminders = findUnansweredReminders([
      message({ uid: 1, from: 'me@a.synth.test', messageId: '<s1@t>', date: daysAgo(10) }),
      message({ accountId: 'a2', accountName: 'A2', uid: 2, from: 'them@t', inReplyTo: '<s1@t>', date: daysAgo(2) }),
    ], identities, 3, NOW);
    expect(reminders).toHaveLength(0);
  });

  it('F5-REM-OLD-REPLY: a reply that predates the newest own message does not close the thread', () => {
    const reminders = findUnansweredReminders([
      message({ uid: 1, from: 'me@a.synth.test', messageId: '<s1@t>', date: daysAgo(10) }),
      message({ accountId: 'a2', accountName: 'A2', uid: 2, from: 'them@t', inReplyTo: '<s1@t>', date: daysAgo(12) }),
      message({ uid: 3, from: 'Me <me@a.synth.test>', messageId: '<s2@t>', inReplyTo: '<s1@t>', date: daysAgo(9) }),
    ], identities, 3, NOW);
    // The newest own message (s2, 9 days ago) is still unanswered.
    expect(reminders).toHaveLength(1);
    expect(reminders[0].waitingDays).toBe(9);
  });

  it('F5-REM-DUPLICATE-OUTBOUND: copies of the same sent mail across accounts merge into one reminder', () => {
    const reminders = findUnansweredReminders([
      message({ uid: 1, folder: 'Sent', from: 'me@a.synth.test', messageId: '<s1@t>', date: daysAgo(10) }),
      message({ accountId: 'a2', accountName: 'A2', folder: 'INBOX', uid: 2, from: 'me@a.synth.test', messageId: '<s1@t>', date: daysAgo(10) }),
    ], identities, 3, NOW);
    expect(reminders).toHaveLength(1);
    expect(reminders[0].sentFrom).toHaveLength(2);
  });

  it('F5-REM-OWN-IDENTITIES: mail sent from either configured identity counts as the user', () => {
    const reminders = findUnansweredReminders([
      message({ accountId: 'a2', accountName: 'A2', uid: 2, folder: 'Sent', from: 'other-id@b.synth.test', messageId: '<s9@t>', date: daysAgo(5) }),
    ], identities, 3, NOW);
    expect(reminders).toHaveLength(1);
  });

  it('F5-REM-THRESHOLD: a conversation inside the threshold stays silent', () => {
    const reminders = findUnansweredReminders([
      message({ uid: 1, from: 'me@a.synth.test', messageId: '<s1@t>', date: daysAgo(2) }),
    ], identities, 3, NOW);
    expect(reminders).toHaveLength(0);
  });
});

describe('F5: saved-search tools', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'f5-tools-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const setup = (searchEmails?: Function) => {
    const handlers = new Map<string, Function>();
    const accounts = [
      { id: 'a1', name: 'A1', host: 'imap.a.synth.test', email: 'me@a.synth.test', user: 'me@a.synth.test' },
      { id: 'a2', name: 'A2', host: 'imap.b.synth.test', email: 'other-id@b.synth.test', user: 'other-id@b.synth.test' },
    ];
    const imap = {
      listFolders: vi.fn(async () => [{ name: 'INBOX', delimiter: '/', attributes: [] }]),
      searchEmailPage: vi.fn(async (id: string) => ({
        messages: [{
          uid: 1, date: new Date(Date.now() - 3_600_000), subject: 'F5 digest item', from: 's@t', to: [],
          messageId: '<digest@t>', flags: [], customKeywords: [],
        }],
        matched: 1,
      })),
      searchEmails: searchEmails ?? vi.fn(async () => []),
      findSpecialUseFolder: vi.fn(async (_id: string, flag: string) => flag === '\\Sent' ? 'Sent' : undefined),
    };
    const manager = { getAllAccounts: () => accounts, resolveAccountId: (_id: any, name?: string) => accounts.find(a => a.name === name)!.id };
    savedSearchTools(
      { registerTool: (name: string, _def: unknown, handler: Function) => handlers.set(name, handler) } as any,
      imap as any, manager as any, {}, { directory: dir },
    );
    return { handlers, imap };
  };

  it('F5-TOOL-SAVE-LIST-DELETE: save, list, run and delete through the MCP surface', async () => {
    const { handlers } = setup();
    const saved = JSON.parse((await handlers.get('imap_save_search')!({
      name: '客户邮件', subject: '报价', dedupe: true, reminderThresholdDays: 5,
    })).content[0].text);
    expect(saved.saved.criteria).toMatchObject({ subject: '报价', dedupe: true });

    const list = JSON.parse((await handlers.get('imap_list_saved_searches')!({})).content[0].text);
    expect(list.savedSearches).toHaveLength(1);

    const run = JSON.parse((await handlers.get('imap_run_saved_search')!({ name: '客户邮件' })).content[0].text);
    expect(run.success).toBe(true);
    expect(run.savedSearch).toBe('客户邮件');
    expect(run.messages).toHaveLength(1);
    expect(run.messages[0]).toMatchObject({ subject: 'F5 digest item', accountId: expect.any(String) });

    await handlers.get('imap_delete_saved_search')!({ name: '客户邮件' });
    await expect(handlers.get('imap_run_saved_search')!({ name: '客户邮件' })).rejects.toThrow(/No saved search/);
  });

  it('F5-TOOL-DIGEST-SAVED: the digest runs stored criteria and returns metadata only', async () => {
    const { handlers } = setup();
    await handlers.get('imap_save_search')!({ name: 'daily', query: '报价' });
    const digest = JSON.parse((await handlers.get('imap_mail_digest')!({ savedSearch: 'daily', limit: 10 })).content[0].text);
    expect(digest.success).toBe(true);
    expect(digest.savedSearch).toBe('daily');
    expect(digest.messages[0].subject).toBe('F5 digest item');
    // Metadata only: no body fields anywhere in the digest.
    expect(JSON.stringify(digest)).not.toContain('textContent');
  });

  it('F5-TOOL-DIGEST-ADHOC: without a saved search the window covers all accounts', async () => {
    const { handlers, imap } = setup();
    const digest = JSON.parse((await handlers.get('imap_mail_digest')!({ sinceHours: 24, limit: 10 })).content[0].text);
    expect(digest.messages).toHaveLength(1);
    // Both accounts were searched (scope: all configured accounts).
    expect(imap.searchEmailPage.mock.calls.some((call: any[]) => call[0] === 'a1')).toBe(true);
    expect(imap.searchEmailPage.mock.calls.some((call: any[]) => call[0] === 'a2')).toBe(true);
  });

  it('F5-TOOL-REMINDERS: sent+inbox are scanned and unanswered conversations surface', async () => {
    const sentMail = [message({ accountId: 'a1', folder: 'Sent', uid: 7, from: 'Me <me@a.synth.test>', messageId: '<s1@t>', subject: 'Quote', date: new Date(Date.now() - 10 * 86_400_000) })];
    const inboxMail = [];
    const { handlers, imap } = setup(vi.fn(async (accountId: string, folder: string) => {
      if (folder === 'Sent') return sentMail;
      return inboxMail;
    }));
    const result = JSON.parse((await handlers.get('imap_unanswered_reminders')!({ thresholdDays: 3 })).content[0].text);
    expect(result.reminderCount).toBe(1);
    expect(result.reminders[0]).toMatchObject({ subject: 'Quote', waitingDays: 10 });
    expect(result.sentFolders).toEqual(['A1:Sent', 'A2:Sent']);
    expect(imap.searchEmails).toHaveBeenCalled();
  });

  it('F5-TOOL-REMINDERS-ANSWERED: a later reply in the same conversation suppresses the reminder', async () => {
    const { handlers } = setup(vi.fn(async (accountId: string, folder: string) => {
      if (folder === 'Sent') {
        return [message({ accountId: 'a1', folder: 'Sent', uid: 7, from: 'me@a.synth.test', messageId: '<s1@t>', date: new Date(Date.now() - 10 * 86_400_000) })];
      }
      return [message({ accountId: 'a2', folder: 'INBOX', uid: 8, from: 'them@t', inReplyTo: '<s1@t>', date: new Date(Date.now() - 2 * 86_400_000) })];
    }));
    const result = JSON.parse((await handlers.get('imap_unanswered_reminders')!({ thresholdDays: 3 })).content[0].text);
    expect(result.reminderCount).toBe(0);
  });
});

// F5 review regressions.
describe('F5 review: coverage, identities, hour window, corrupt entries', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'f5-review-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('F5-STORE-CORRUPT-ENTRY: a structurally broken entry fails explicitly and keeps the bytes', async () => {
    const path = join(dir, 'saved-searches.json');
    const broken = JSON.stringify([{ name: 'broken' }, null]);
    writeFileSync(path, broken, 'utf8');
    expect(() => listSavedSearches(dir)).toThrow(/corrupt/i);
    expect(() => upsertSavedSearch({ name: 'x', criteria: {} }, dir)).toThrow(/corrupt/i);
    expect(readFileSync(path, 'utf8')).toBe(broken);
  });

  it('F5-STORE-CORRUPT-CRITERIA: an entry without a criteria object is corrupt, not filtered', async () => {
    const path = join(dir, 'saved-searches.json');
    const broken = JSON.stringify([{ name: 'ok', criteria: {} }, { name: 'broken', criteria: 'nope' }]);
    writeFileSync(path, broken, 'utf8');
    expect(() => listSavedSearches(dir)).toThrow(/criteria/);
  });

  it('F5-REMINDERS-SCAN-FAIL: a failed folder search marks the result incomplete with the failure listed', async () => {
    const handlers = new Map<string, Function>();
    const accounts = [
      { id: 'a1', name: 'A1', host: 'imap.a.synth.test', email: 'me@a.synth.test', user: 'me@a.synth.test' },
    ];
    const imap = {
      findSpecialUseFolder: vi.fn(async () => 'Sent'),
      searchEmails: vi.fn(async (_id: string, folder: string) => {
        if (folder === 'INBOX') throw new Error('connection dropped');
        return [message({ accountId: 'a1', folder: 'Sent', uid: 7, from: 'me@a.synth.test', messageId: '<s1@t>', subject: 'Quote', date: new Date(Date.now() - 10 * 86_400_000) })];
      }),
    };
    const manager = { getAllAccounts: () => accounts, resolveAccountId: (id?: string) => id };
    savedSearchTools(
      { registerTool: (name: string, _def: unknown, handler: Function) => handlers.set(name, handler) } as any,
      imap as any, manager as any, {}, { directory: dir },
    );
    const result = JSON.parse((await handlers.get('imap_unanswered_reminders')!({ thresholdDays: 3 })).content[0].text);
    expect(result.success).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.failures).toEqual([{ accountName: 'A1', folder: 'INBOX', error: 'connection dropped' }]);
    expect(result.incompleteNote).toContain('不完整');
    expect(result.reminderCount).toBe(1); // the Sent-side reminder still surfaces
  });

  it('F5-REMINDERS-IDENTITIES: an unscanned own identity is never treated as an external replier', async () => {
    const handlers = new Map<string, Function>();
    const accounts = [
      { id: 'a1', name: 'A1', host: 'imap.a.synth.test', email: 'me@a.synth.test', user: 'me@a.synth.test' },
      { id: 'a2', name: 'A2', host: 'imap.b.synth.test', email: 'other-id@b.synth.test', user: 'other-id@b.synth.test' },
    ];
    const imap = {
      findSpecialUseFolder: vi.fn(async () => 'Sent'),
      searchEmails: vi.fn(async (id: string, folder: string) => {
        if (id !== 'a1' || folder !== 'INBOX') return []; // only A1/INBOX is scanned
        return [
          message({ accountId: 'a1', folder: 'INBOX', uid: 5, from: 'me@a.synth.test', messageId: '<s1@t>', subject: 'Quote', date: new Date(Date.now() - 10 * 86_400_000) }),
          message({ accountId: 'a1', folder: 'INBOX', uid: 6, from: 'other-id@b.synth.test', messageId: '<m2@t>', subject: 'Quote', date: new Date(Date.now() - 9 * 86_400_000) }),
        ];
      }),
    };
    const manager = { getAllAccounts: () => accounts, resolveAccountId: (id?: string) => id };
    savedSearchTools(
      { registerTool: (name: string, _def: unknown, handler: Function) => handlers.set(name, handler) } as any,
      imap as any, manager as any, {}, { directory: dir },
    );
    const result = JSON.parse((await handlers.get('imap_unanswered_reminders')!({ thresholdDays: 3, accountNames: ['A1'] })).content[0].text);
    // A2's identity is OWN even though A2 was not scanned — the mail it
    // sent must not suppress the reminder.
    expect(result.reminders.some((r: any) => r.subject === 'Quote')).toBe(true);
  });

  it('F5-DIGEST-HOUR-WINDOW: a one-hour digest excludes older same-day mail and reports the exact window', async () => {
    const handlers = new Map<string, Function>();
    const accounts = [
      { id: 'a1', name: 'A1', host: 'imap.a.synth.test', email: 'me@a.synth.test', user: 'me@a.synth.test' },
    ];
    const imap = {
      listFolders: vi.fn(async () => [{ name: 'INBOX', delimiter: '/', attributes: [] }]),
      searchEmailPage: vi.fn(async () => ({
        messages: [
          { uid: 1, date: new Date(Date.now() - 30 * 60_000), subject: 'inside', from: 's@t', to: [], messageId: '<in@t>', flags: [], customKeywords: [] },
          { uid: 2, date: new Date(Date.now() - 6 * 3_600_000), subject: 'older same-day', from: 's@t', to: [], messageId: '<out@t>', flags: [], customKeywords: [] },
        ],
        matched: 2,
      })),
    };
    const manager = { getAllAccounts: () => accounts, resolveAccountId: (id?: string) => id };
    savedSearchTools(
      { registerTool: (name: string, _def: unknown, handler: Function) => handlers.set(name, handler) } as any,
      imap as any, manager as any, {}, { directory: dir },
    );
    const result = JSON.parse((await handlers.get('imap_mail_digest')!({ sinceHours: 1, limit: 50 })).content[0].text);
    expect(result.messages.map((m: any) => m.subject)).toEqual(['inside']);
    expect(result.totalFoundInWindow).toBe(1);
    expect(typeof result.windowStart).toBe('string');
  });
});
// F5 review round 2: R5 real-chain References, R6 criteria members, R7 Sent coverage.

const r5Message = (overrides: Record<string, unknown>) => ({
  accountId: 'a1', accountName: 'A1', folder: 'INBOX', uid: 1,
  date: new Date('2026-01-01T00:00:00Z'), subject: 'F5-R5', flags: [], customKeywords: [],
  ...overrides,
});

describe('F5-R5: real read chain delivers References into the reminder scan', () => {
  it('F5-R5-REFERENCES-REPLY: a References-only external reply closes the reminder', async () => {
    const svc = new ImapService();
    vi.spyOn(svc as any, 'ensureConnected').mockResolvedValue({
      usable: true,
      getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
      search: vi.fn(async () => [7]),
      fetch: vi.fn(() => ({
        [Symbol.asyncIterator]: () => {
          let used = false;
          return {
            next: async () => {
              if (used) return { done: true as const };
              used = true;
              return { done: false as const, value: {
                uid: 7,
                internalDate: new Date(Date.now() - 2 * 86_400_000),
                envelope: { subject: 'F5-R5', messageId: '<re@t>', from: [{ address: 'them@synth.test' }], to: [] },
                flags: new Set<string>(),
                headers: 'References: <s1@t>\r\n',
              } };
            },
          };
        },
      })),
    });
    const dir = mkdtempSync(join(tmpdir(), 'f5-r5-'));
    process.env.IMAP_MCP_CONFIG_DIR = dir;
    try {
      // R5: the reminders scan delegates to the REAL searchEmails with the
      // thread-header flag — References-only replies must be visible.
      const imap = {
        findSpecialUseFolder: vi.fn(async () => 'Sent'),
        searchEmails: vi.fn(async (id: string, folder: string, criteria: any, options: any) => {
          void criteria; void folder;
          return svc.searchEmails(id, folder, criteria, options);
        }),
      };
      const manager = { getAllAccounts: () => [{ id: 'a1', name: 'A1', host: 'imap.a.synth.test', email: 'me@a.synth.test', user: 'me@a.synth.test' }], resolveAccountId: (id?: string) => id };
      const handlers = new Map<string, Function>();
      savedSearchTools(
        { registerTool: (name: string, _def: unknown, handler: Function) => handlers.set(name, handler) } as any,
        imap as any, manager as any, {}, {},
      );
      const result = JSON.parse((await handlers.get('imap_unanswered_reminders')!({ thresholdDays: 3 })).content[0].text);
      // The References-only reply from them@synth.test closes the thread.
      expect(result.reminderCount).toBe(0);
      expect(result.complete).toBe(true);
    } finally {
      delete process.env.IMAP_MCP_CONFIG_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('F5-R6: persisted criteria member validation', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'f5-r6-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const cases: Array<{ label: string; criteria: Record<string, unknown> }> = [
    { label: 'accountNames is a string', criteria: { accountNames: 'A1' } },
    { label: 'seen is a string', criteria: { seen: 'yes' } },
    { label: 'limit out of range', criteria: { limit: 500 } },
    { label: 'since not a real date', criteria: { since: '2026-02-30' } },
    { label: 'unknown member', criteria: { sneaky: true } },
  ];
  for (const { label, criteria } of cases) {
    it(`F5-R6-${label.replace(/ /g, '-')}: list/upsert/get/delete fail explicitly and bytes stay`, () => {
      const path = join(dir, 'saved-searches.json');
      const broken = JSON.stringify([{ name: 'ok', criteria: { query: 'x' } }, { name: 'bad', criteria }]);
      writeFileSync(path, broken, 'utf8');
      expect(() => listSavedSearches(dir)).toThrow(/criteria/);
      expect(() => upsertSavedSearch({ name: 'x', criteria: {} }, dir)).toThrow(/criteria/);
      expect(() => getSavedSearch('ok', dir)).toThrow(/criteria/);
      expect(() => deleteSavedSearch('ok', dir)).toThrow(/criteria/);
      expect(readFileSync(path, 'utf8')).toBe(broken);
    });
  }
});

describe('F5-R7: missing Sent folder is a coverage hole', () => {
  it('F5-R7-SENT-MISSING: no Sent folder marks the result incomplete with the reason', async () => {
    const handlers = new Map<string, Function>();
    const accounts = [
      { id: 'a1', name: 'A1', host: 'imap.a.synth.test', email: 'me@a.synth.test', user: 'me@a.synth.test' },
    ];
    const imap = {
      findSpecialUseFolder: vi.fn(async () => undefined),
      searchEmails: vi.fn(async () => [r5Message({ accountId: 'a1', folder: 'INBOX', uid: 9, from: 'me@a.synth.test', messageId: '<s9@t>', subject: 'No Sent', date: new Date(Date.now() - 10 * 86_400_000) })]),
    };
    const manager = { getAllAccounts: () => accounts, resolveAccountId: (id?: string) => id };
    savedSearchTools(
      { registerTool: (name: string, _def: unknown, handler: Function) => handlers.set(name, handler) } as any,
      imap as any, manager as any, {}, {},
    );
    const result = JSON.parse((await handlers.get('imap_unanswered_reminders')!({ thresholdDays: 3 })).content[0].text);
    expect(result.complete).toBe(false);
    expect(result.missingSent).toEqual([{ accountName: 'A1', reason: expect.stringContaining('Sent') }]);
    expect(result.incompleteNote).toContain('不完整');
    expect(result.reminderCount).toBe(1);
  });

  it('F5-R7-SENT-FOUND: normal success stays complete', async () => {
    const handlers = new Map<string, Function>();
    const accounts = [
      { id: 'a1', name: 'A1', host: 'imap.a.synth.test', email: 'me@a.synth.test', user: 'me@a.synth.test' },
    ];
    const imap = {
      findSpecialUseFolder: vi.fn(async () => 'Sent'),
      searchEmails: vi.fn(async () => []),
    };
    const manager = { getAllAccounts: () => accounts, resolveAccountId: (id?: string) => id };
    savedSearchTools(
      { registerTool: (name: string, _def: unknown, handler: Function) => handlers.set(name, handler) } as any,
      imap as any, manager as any, {}, {},
    );
    const result = JSON.parse((await handlers.get('imap_unanswered_reminders')!({ thresholdDays: 3 })).content[0].text);
    expect(result.complete).toBe(true);
    expect(result.missingSent).toBeUndefined();
  });
});
