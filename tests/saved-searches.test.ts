import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listSavedSearches, upsertSavedSearch, getSavedSearch, deleteSavedSearch,
} from '../src/utils/saved-searches.js';
import { findUnansweredReminders, type ReminderMessage } from '../src/utils/mail-reminders.js';
import { savedSearchTools } from '../src/tools/saved-search-tools.js';

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
          uid: 1, date: new Date('2026-01-01T02:00:00Z'), subject: 'F5 digest item', from: 's@t', to: [],
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
