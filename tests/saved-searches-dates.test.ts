import { describe, it, expect, vi } from 'vitest';
import { savedSearchTools } from '../src/tools/saved-search-tools.js';
import { listSavedSearches, upsertSavedSearch, getSavedSearch, deleteSavedSearch } from '../src/utils/saved-searches.js';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { z } from 'zod';

function registerTools(directory: string) {
  const handlers = new Map<string, Function>();
  const schemas = new Map<string, z.ZodRawShape>();
  const imap = {
    listFolders: vi.fn(async () => [{ name: 'INBOX', delimiter: '/', attributes: [] }]),
    searchEmailPage: vi.fn(async () => ({ messages: [], matched: 0 })),
  };
  const manager = {
    getAllAccounts: () => [{ id: 'a1', name: 'A1', host: 'imap.a.synth.test' }],
    resolveAccountId: (id?: string) => id ?? 'a1',
  };
  savedSearchTools(
    { registerTool: (name: string, definition: { inputSchema: z.ZodRawShape }, handler: Function) => {
      handlers.set(name, handler);
      schemas.set(name, definition.inputSchema);
    } } as any,
    imap as any, manager as any, {}, { directory },
  );
  return async (name: string, args: Record<string, unknown>) => {
    const input = z.object(schemas.get(name)!).parse(args);
    const response = await handlers.get(name)!(input);
    return JSON.parse(response.content[0].text);
  };
}

describe('R6 round 4: empty date fields treated as unset', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'r6-dates-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it.each([
    { id: 'SINCE-EMPTY', criteria: { since: '' } },
    { id: 'BEFORE-EMPTY', criteria: { before: '' } },
    { id: 'BOTH-EMPTY', criteria: { since: '', before: '' } },
    { id: 'MIXED-BEFORE', criteria: { since: '', before: '2026-06-01' } },
    { id: 'MIXED-SINCE', criteria: { since: '2026-01-01', before: '' } },
  ])('R6-DATES-DIGEST-$id: saves, lists, runs, digests and deletes', async ({ criteria }) => {
    const call = registerTools(dir);
    const saved = await call('imap_save_search', { name: 'empty-dates', ...criteria });
    expect(saved.success).toBe(true);
    const list = await call('imap_list_saved_searches', {});
    expect(list.savedSearches).toHaveLength(1);
    expect(list.savedSearches[0].criteria).toEqual(criteria);
    const run = await call('imap_run_saved_search', { name: 'empty-dates' });
    expect(run.success).toBe(true);
    const digest = await call('imap_mail_digest', { savedSearch: 'empty-dates' });
    expect(digest.success).toBe(true);
    const del = await call('imap_delete_saved_search', { name: 'empty-dates' });
    expect(del.success).toBe(true);
  });

  it('R6-DATES-BEFORE-EMPTY: before:\'\' saves and reads cleanly', async () => {
    upsertSavedSearch({ name: 'empty-before', criteria: { before: '' } }, dir);
    const list = listSavedSearches(dir);
    expect(list[0].criteria.before).toBe('');
    expect(list[0].criteria.since).toBeUndefined();
  });

  it('R6-DATES-BOTH-EMPTY: both since and before empty save and read cleanly', async () => {
    upsertSavedSearch({ name: 'both-empty', criteria: { since: '', before: '' } }, dir);
    const list = listSavedSearches(dir);
    expect(list[0].criteria.since).toBe('');
    expect(list[0].criteria.before).toBe('');
  });

  it('R6-DATES-OLD-STORE: an old store with empty dates loads, runs, digests, updates and deletes', async () => {
    const path = join(dir, 'saved-searches.json');
    const old = JSON.stringify([{ name: 'legacy', criteria: { since: '', before: '', query: 'real' } }]);
    writeFileSync(path, old, 'utf8');
    const list = listSavedSearches(dir);
    expect(list).toHaveLength(1);
    expect(list[0].criteria.query).toBe('real');
    const call = registerTools(dir);
    expect((await call('imap_run_saved_search', { name: 'legacy' })).success).toBe(true);
    expect((await call('imap_mail_digest', { savedSearch: 'legacy' })).success).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(old);
    // Update works on the loaded entry.
    const updated = upsertSavedSearch({ name: 'legacy', criteria: { since: '', query: 'updated' } }, dir);
    expect(updated.criteria.query).toBe('updated');
    expect(updated.criteria.since).toBe('');
    // Delete works.
    expect(deleteSavedSearch('legacy', dir)).toBe(true);
  });

  it('R6-DATES-MIXED: empty since + non-empty valid before coexist', () => {
    upsertSavedSearch({ name: 'mixed', criteria: { since: '', before: '2026-06-01' } }, dir);
    const list = listSavedSearches(dir);
    expect(list[0].criteria.since).toBe('');
    expect(list[0].criteria.before).toBe('2026-06-01');
  });

  it('R6-DATES-INVALID-NONEMPTY: a non-empty invalid date is still rejected with bytes preserved', () => {
    const path = join(dir, 'saved-searches.json');
    const good = JSON.stringify([{ name: 'good', criteria: { since: '2026-01-01' } }]);
    writeFileSync(path, good, 'utf8');
    expect(() => upsertSavedSearch({ name: 'bad', criteria: { since: '2026-02-30' } }, dir)).toThrow(/calendar date/);
    expect(readFileSync(path, 'utf8')).toBe(good);
    expect(getSavedSearch('good', dir)?.criteria.since).toBe('2026-01-01');
  });
});
