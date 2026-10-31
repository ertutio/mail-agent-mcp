/**
 * Shared search-input validation for every IMAP search entry point
 * (T28 / SA-05). Dates must be real calendar days in YYYY-MM-DD, ranges must
 * be ordered, and limits must be positive bounded integers — all checked
 * before any network I/O, with identical semantics on the plain and unified
 * (cross-account) entries.
 */
export const MAX_FOLDER_SEARCH_LIMIT = 5000;

/**
 * Parses an inclusive/exclusive search date bound. Rejects anything that is
 * not exactly YYYY-MM-DD and any date that is not a real calendar day (the
 * previous plain-search parser silently rolled 2026-02-30 into March).
 */
export function parseSearchDateBound(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Dates must use YYYY-MM-DD');
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error('Invalid calendar date');
  }
  return date;
}

/** An ordered range: since must strictly precede before. */
export function validateSearchRange(since: Date | undefined, before: Date | undefined): void {
  if (since && before && since.getTime() >= before.getTime()) {
    throw new Error('since must precede before');
  }
}

/** Per-folder search limit bounds; the unified entry keeps its own tighter cap. */
export function validateSearchLimit(limit: number, max: number = MAX_FOLDER_SEARCH_LIMIT): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    throw new Error(`limit must be an integer between 1 and ${max}`);
  }
  return limit;
}
