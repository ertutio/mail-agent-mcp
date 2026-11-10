import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { accountStoreDirectory } from './account-store-lock.js';
import { parseSearchDateBound } from './search-input.js';

/** R6: persisted criteria contract — mirrors the imap_save_search schema.
 * Dates follow the shared calendar rules (strict YYYY-MM-DD). */
const SAVED_CRITERIA_SPEC: Record<string, { kind: string; max?: number }> = {
  accountNames: { kind: 'string[]' },
  query: { kind: 'string', max: 2000 },
  from: { kind: 'string', max: 2000 },
  to: { kind: 'string', max: 2000 },
  subject: { kind: 'string', max: 2000 },
  since: { kind: 'date' },
  before: { kind: 'date' },
  seen: { kind: 'boolean' },
  flagged: { kind: 'boolean' },
  limit: { kind: 'int', max: 200 },
  searchAllFolders: { kind: 'boolean' },
  folder: { kind: 'string', max: 500 },
  includeTrash: { kind: 'boolean' },
  includeSpam: { kind: 'boolean' },
  includeDrafts: { kind: 'boolean' },
  dedupe: { kind: 'boolean' },
  groupByConversation: { kind: 'boolean' },
};


/**
 * F5: persisted saved searches, following the local config conventions —
 * the account store directory (IMAP_MCP_CONFIG_DIR) and the T31 write
 * discipline: only an ENOENT initializes an empty store; a corrupt or
 * unreadable file is an explicit failure that never overwrites the bytes on
 * disk; writes go through a temp file + rename (atomic replacement).
 */

export interface SavedSearch {
  /** User-chosen unique name (the save/update/delete handle). */
  name: string;
  /** Search criteria — the same fields imap_search_all_accounts accepts. */
  criteria: {
    accountNames?: string[];
    query?: string;
    from?: string;
    to?: string;
    subject?: string;
    since?: string;
    before?: string;
    seen?: boolean;
    flagged?: boolean;
    limit?: number;
    searchAllFolders?: boolean;
    folder?: string;
    includeTrash?: boolean;
    includeSpam?: boolean;
    includeDrafts?: boolean;
    dedupe?: boolean;
    groupByConversation?: boolean;
  };
  /** F5: optional digest/reminder defaults the host scheduler can reuse. */
  digestThresholdHours?: number;
  reminderThresholdDays?: number;
  createdAt: string;
  updatedAt: string;
}

const STORE_FILE = 'saved-searches.json';

export function savedSearchesPath(directory: string = accountStoreDirectory()): string {
  return join(directory, STORE_FILE);
}

/** R6 round 3: shared criteria member validation — the exact same rules
 * run at tool entry, upsert, and persisted-store read, so save and read
 * stay consistent. Empty optional strings are valid (they mean "no
 * filter applied"), matching the tool schema (z.string().optional()).
 * Over-long strings, wrong types, invalid dates, and unknown members
 * fail explicitly. */
function validateSavedCriteria(name: string, criteria: Record<string, unknown>): void {
  for (const key of Object.keys(criteria)) {
    if (!(key in SAVED_CRITERIA_SPEC)) throw new Error(`saved search "${name}" criteria has an unknown member "${key}"`);
  }
  const spec = SAVED_CRITERIA_SPEC as Record<string, { kind: string; max?: number }>;
  for (const [key, rule] of Object.entries(spec)) {
    const value = criteria[key];
    if (value === undefined) continue;
    if (rule.kind === 'string[]') {
      if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) throw new Error(`saved search "${name}" criteria.${key} must be an array of strings`);
    } else if (rule.kind === 'string') {
      if (typeof value !== 'string' || value.length > (rule.max ?? 2000)) throw new Error(`saved search "${name}" criteria.${key} must be a string of at most ${rule.max ?? 2000} characters`);
    } else if (rule.kind === 'boolean') {
      if (typeof value !== 'boolean') throw new Error(`saved search "${name}" criteria.${key} must be a boolean`);
    } else if (rule.kind === 'date') {
      // R6 round 4: an empty string is treated as unset — the same rule the
      // tool schema enforces (z.string().optional() allows ''). Non-empty
      // values still go through strict format + real-calendar validation.
      if (value === '') continue;
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`saved search "${name}" criteria.${key} must be a YYYY-MM-DD date`);
      try { parseSearchDateBound(value); } catch (cause) { throw new Error(`saved search "${name}" criteria.${key} is not a valid calendar date: ${(cause as Error).message}`); }
    } else if (rule.kind === 'int') {
      if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > (rule.max ?? 200)) throw new Error(`saved search "${name}" criteria.${key} must be an integer 1-${rule.max ?? 200}`);
    }
  }
}

function loadEntries(directory: string): SavedSearch[] {
  let raw: string;
  try {
    raw = readFileSync(savedSearchesPath(directory), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    // Unreadable store (permissions, I/O): an explicit failure, never treated as empty.
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error('saved searches store must be a JSON array');
    for (const entry of parsed) {
      // F5 review: validate the whole structure — a corrupt entry fails
      // explicitly (bytes preserved) instead of being silently filtered
      // out and overwritten by the next upsert.
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('saved search entry must be an object');
      const candidate = entry as Record<string, unknown>;
      if (typeof candidate.name !== 'string' || !candidate.name.trim() || candidate.name.length > 120) throw new Error('saved search entry name must be a 1-120 character string');
      if (!candidate.criteria || typeof candidate.criteria !== 'object' || Array.isArray(candidate.criteria)) throw new Error(`saved search "${candidate.name}" has no criteria object`);
      // R6: every criteria member is validated — types, ranges and dates —
      // so a corrupted entry fails here instead of silently rewriting the
      // store on the next upsert. Empty optional strings are valid values
      // meaning "no filter applied" — the same rule the tool schema enforces
      const criteria = candidate.criteria as Record<string, unknown>;
      validateSavedCriteria(candidate.name as string, criteria);
      for (const field of ['digestThresholdHours', 'reminderThresholdDays'] as const) {
        const value = candidate[field];
        if (value !== undefined && (!Number.isInteger(value) || (value as number) < 1)) throw new Error(`saved search "${candidate.name}" has an invalid ${field}`);
      }
    }
    return parsed as SavedSearch[];
  } catch (error) {
    // Corrupt store: surface it — the caller must not silently replace the
    // user's saved searches with an empty set.
    throw new Error(`Saved-search store is corrupt (${savedSearchesPath(directory)}): ${(error as Error).message}`);
  }
}

function persist(entries: SavedSearch[], directory: string): void {
  const target = savedSearchesPath(directory);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(entries, null, 2), 'utf8');
  try {
    renameSync(temp, target);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

export function listSavedSearches(directory: string = accountStoreDirectory()): SavedSearch[] {
  return loadEntries(directory);
}

export function getSavedSearch(name: string, directory: string = accountStoreDirectory()): SavedSearch | undefined {
  const target = name.trim().toLowerCase();
  return loadEntries(directory).find(entry => entry.name.trim().toLowerCase() === target);
}

export function upsertSavedSearch(
  input: { name: string; criteria: SavedSearch['criteria']; digestThresholdHours?: number; reminderThresholdDays?: number },
  directory: string = accountStoreDirectory(),
): SavedSearch {
  const name = input.name.trim();
  if (!name || name.length > 120) throw new Error('Saved-search name must be 1-120 characters');
  const entries = loadEntries(directory);
  // R6 round 3: the same validation runs at write time — invalid input
  // fails before the store is touched.
  validateSavedCriteria(name, input.criteria as Record<string, unknown>);
  const key = name.toLowerCase();
  const existing = entries.find(entry => entry.name.trim().toLowerCase() === key);
  const now = new Date().toISOString();
  const saved: SavedSearch = {
    name,
    criteria: input.criteria,
    ...(input.digestThresholdHours !== undefined ? { digestThresholdHours: input.digestThresholdHours } : {}),
    ...(input.reminderThresholdDays !== undefined ? { reminderThresholdDays: input.reminderThresholdDays } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const next = existing
    ? entries.map(entry => (entry === existing ? saved : entry))
    : [...entries, saved];
  persist(next, directory);
  return saved;
}

export function deleteSavedSearch(name: string, directory: string = accountStoreDirectory()): boolean {
  const key = name.trim().toLowerCase();
  const entries = loadEntries(directory);
  const next = entries.filter(entry => entry.name.trim().toLowerCase() !== key);
  if (next.length === entries.length) return false;
  persist(next, directory);
  return true;
}
