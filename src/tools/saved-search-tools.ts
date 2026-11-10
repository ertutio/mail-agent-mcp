import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ImapService } from '../services/imap-service.js';
import type { AccountManager } from '../services/account-manager.js';
import { createUnifiedSearchRunner, type UnifiedSearchArgs } from './unified-search-tools.js';
import { parseSearchDateBound } from '../utils/search-input.js';
import {
  listSavedSearches, getSavedSearch, upsertSavedSearch, deleteSavedSearch, type SavedSearch,
} from '../utils/saved-searches.js';
import { findUnansweredReminders, type ReminderMessage } from '../utils/mail-reminders.js';

/**
 * F5: saved searches plus the two scheduler-facing entries (digest and
 * unanswered-reply reminders). Nothing here schedules by itself — the user
 * saves the criteria and the HOST calls the digest/reminder tool on its own
 * schedule; a complete example lives in docs/agent-integration.md.
 *
 * Scope rule: digests and reminders only ever summarize mail selected by the
 * user's stored criteria / explicit inputs, metadata only, no bodies.
 */

interface SavedSearchRuntime {
  overallTimeoutMs?: number;
  accountTimeoutMs?: number;
}

const criteriaShape = {
  accountNames: z.array(z.string().min(1)).optional(),
  query: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  subject: z.string().optional(),
  since: z.string().optional(),
  before: z.string().optional(),
  seen: z.boolean().optional(),
  flagged: z.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  searchAllFolders: z.boolean().optional(),
  folder: z.string().optional(),
  includeTrash: z.boolean().optional(),
  includeSpam: z.boolean().optional(),
  includeDrafts: z.boolean().optional(),
  dedupe: z.boolean().optional(),
  groupByConversation: z.boolean().optional(),
};

function validateCriteria(criteria: Record<string, unknown>): void {
  // Fail before the network on the same rules the unified search enforces.
  if (criteria.since !== undefined && criteria.since !== '') parseSearchDateBound(String(criteria.since));
  if (criteria.before !== undefined && criteria.before !== '') parseSearchDateBound(String(criteria.before));
}

function normalizeSavedSearchDates(criteria: SavedSearch['criteria']): SavedSearch['criteria'] {
  const normalized = { ...criteria };
  if (normalized.since === '') delete normalized.since;
  if (normalized.before === '') delete normalized.before;
  return normalized;
}

function json(result: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
}

export function savedSearchTools(
  server: McpServer,
  imap: ImapService,
  accountManager: AccountManager,
  runtime: SavedSearchRuntime = {},
  storage: { directory?: string } = {},
): void {
  const runUnifiedSearch = createUnifiedSearchRunner(imap, accountManager, runtime);
  const dir = storage.directory;

  server.registerTool('imap_save_search', {
    description: 'Save or update named search criteria (upsert by name) for later runs, digests and reminders. Nothing is scheduled by this tool — the saved entry is material the host can run on its own schedule.',
    inputSchema: {
      name: z.string().trim().min(1).max(120).describe('Unique name for the saved search'),
      ...criteriaShape,
      digestThresholdHours: z.coerce.number().int().min(1).max(24 * 30).optional().describe('Optional digest window (hours) the host scheduler can reuse'),
      reminderThresholdDays: z.coerce.number().int().min(1).max(365).optional().describe('Optional unanswered-reminder threshold (days) the host scheduler can reuse'),
    },
  }, async (args: any) => {
    const { name, digestThresholdHours, reminderThresholdDays, ...criteria } = args;
    validateCriteria(criteria);
    const saved = upsertSavedSearch({ name, criteria, digestThresholdHours, reminderThresholdDays }, dir);
    return json({ success: true, saved });
  });

  server.registerTool('imap_list_saved_searches', {
    description: 'List saved searches (name, criteria, digest/reminder defaults).',
    inputSchema: {},
  }, async () => json({ success: true, savedSearches: listSavedSearches(dir) }));

  server.registerTool('imap_delete_saved_search', {
    description: 'Delete a saved search by name.',
    inputSchema: { name: z.string().min(1).max(120) },
  }, async ({ name }: { name: string }) => {
    const deleted = deleteSavedSearch(name, dir);
    if (!deleted) throw new Error(`No saved search named "${name}"`);
    return json({ success: true, deleted: name });
  });

  server.registerTool('imap_run_saved_search', {
    description: 'Run a saved search through the unified search pipeline (same result shape as imap_search_all_accounts, including continuation cursors).',
    inputSchema: { name: z.string().min(1).max(120) },
  }, async ({ name }: { name: string }) => {
    const saved = getSavedSearch(name, dir);
    if (!saved) throw new Error(`No saved search named "${name}"`);
    const result = await runUnifiedSearch({ ...normalizeSavedSearchDates(saved.criteria), pass: 1 });
    return json({ success: true, savedSearch: saved.name, ...result });
  });

  // Scheduler entry: the host calls this on its own schedule (e.g. daily).
  server.registerTool('imap_mail_digest', {
    description: 'Metadata digest of recent mail matching a saved search (or an ad-hoc window over all accounts): per-account counts plus newest-first items with subject/from/date/location. Metadata only — no bodies. Designed as the entry a host scheduler calls; nothing runs on a timer inside this server.',
    inputSchema: {
      savedSearch: z.string().max(120).optional().describe('Run these stored criteria instead of the ad-hoc window'),
      sinceHours: z.coerce.number().int().min(1).max(24 * 90).default(24).describe('Ad-hoc window: mail received within the last N hours (used when savedSearch is omitted)'),
      limit: z.coerce.number().int().min(1).max(200).default(50).describe('Digest item cap'),
    },
  }, async ({ savedSearch, sinceHours, limit }: { savedSearch?: string; sinceHours: number; limit: number }) => {
    let criteria: Record<string, unknown>;
    if (savedSearch) {
      const saved = getSavedSearch(savedSearch, dir);
      if (!saved) throw new Error(`No saved search named "${savedSearch}"`);
      criteria = { ...normalizeSavedSearchDates(saved.criteria), limit };
    } else {
      const since = new Date(Date.now() - sinceHours * 3_600_000);
      // IMAP SINCE filters whole days; the exact hour cutoff is applied below.
      criteria = { since: since.toISOString().slice(0, 10), limit };
    }
    // A digest is a summary: duplicate copies across mailboxes are noise, so
    // dedupe defaults on unless the criteria explicitly disable it.
    const result = await runUnifiedSearch({ ...criteria, dedupe: (criteria as { dedupe?: boolean }).dedupe ?? true } as UnifiedSearchArgs);
      if (!savedSearch) {
        // P2: enforce the precise hour window on the returned items and
        // stats — the IMAP-level date filter is only a superset.
        const cutoff = Date.now() - sinceHours * 3_600_000;
        const scoped = ((result as { messages?: Array<{ date?: unknown }> }).messages ?? []).filter(message => {
          const value = new Date(message.date as unknown as string).getTime();
          return Number.isFinite(value) && value >= cutoff;
        });
        (result as Record<string, unknown>).messages = scoped;
        (result as Record<string, unknown>).returned = scoped.length;
        (result as Record<string, unknown>).totalFoundInWindow = scoped.length;
        (result as Record<string, unknown>).windowStart = new Date(cutoff).toISOString();
      }
    return json({ success: true, windowHours: savedSearch ? undefined : sinceHours, savedSearch, ...(result as Record<string, unknown>) });
  });

  // Scheduler entry: unanswered replies older than the user-set threshold.
  server.registerTool('imap_unanswered_reminders', {
    description: 'List conversations where the user sent mail (from any configured identity), the newest own message is older than the threshold, and nobody else replied after it. Conversations merge by Message-ID/In-Reply-To/References; duplicate outbound copies collapse. Metadata only.',
    inputSchema: {
      thresholdDays: z.coerce.number().int().min(1).max(365).optional().describe('Days without an answer before a conversation needs a reminder (defaults to the saved search value, else 3)'),
      accountNames: z.array(z.string().min(1)).optional().describe('Restrict the scan to these accounts'),
      lookbackDays: z.coerce.number().int().min(1).max(365).optional().describe('How far back to scan Sent and INBOX (defaults to twice the threshold, capped at 90)'),
    },
  }, async ({ thresholdDays, accountNames, lookbackDays }: { thresholdDays?: number; accountNames?: string[]; lookbackDays?: number }) => {
    const accounts = accountManager.getAllAccounts()
      .filter(account => !accountNames?.length || accountNames.includes(account.name));
    if (!accounts.length) throw new Error('No mail accounts configured');
    const threshold = thresholdDays
      ?? (() => {
        for (const account of accounts) {
          const stored = listSavedSearches(dir).find(entry => entry.reminderThresholdDays !== undefined);
          if (stored?.reminderThresholdDays) return stored.reminderThresholdDays;
        }
        return 3;
      })();
    const lookback = Math.min(lookbackDays ?? Math.min(threshold * 2, 90), 365);
    const since = new Date(Date.now() - lookback * 86_400_000).toISOString().slice(0, 10);

    const scanFailures: Array<{ accountName: string; folder: string; error: string }> = [];
    const sentMissing: Array<{ accountName: string; reason: string }> = [];
    const messages: ReminderMessage[] = [];
    const sentFolders: string[] = [];
    for (const account of accounts) {
      const folders = new Set<string>(['INBOX']);
        let sent: string | undefined;
        try {
          sent = account.sentFolder
            ?? await imap.findSpecialUseFolder(account.id, '\\Sent', ['Sent', 'Sent Items', 'Sent Messages', 'INBOX.Sent'])
            ?? '';
        } catch (error) {
          // R7: a discovery failure is a coverage hole — the INBOX scan
          // continues but the response reports the failed phase.
          sentMissing.push({
            accountName: account.name,
            reason: `Sent 文件夹发现失败：${error instanceof Error ? error.message : String(error)}` + '；该账号的发件不计入本扫描。',
          });
        }
        if (sent) { folders.add(sent); sentFolders.push(`${account.name}:${sent}`); }
        else if (!sentMissing.some(m => m.accountName === account.name)) {
          sentMissing.push({ accountName: account.name, reason: '未发现 Sent 文件夹（无 SPECIAL-USE 标记且未配置 sentFolder）；该账号的发件不计入本扫描。' });
        }
      for (const folder of folders) {
        try {
          const found = await imap.searchEmails(account.id, folder, { since: new Date(since) }, { includeThreadHeaders: true });
          for (const message of found) {
            messages.push({ ...message, accountId: account.id, accountName: account.name, folder });
          }
        } catch (error) {
          // P2: a failed folder search must not silently shrink the scan —
          // the response reports the hole and marks the result incomplete.
          scanFailures.push({
            accountName: account.name,
            folder,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    const allAccounts = accountManager.getAllAccounts();
    // P2: identity recognition spans EVERY configured account — accountNames
    // only limits the scan, so an unscanned own mailbox is never mistaken
    // for an external replier.
    const identities = allAccounts.flatMap(account => [account.email, account.user].filter(Boolean) as string[]);
    const reminders = findUnansweredReminders(messages, identities, threshold);
    return json({
      success: true,
      complete: scanFailures.length === 0 && sentMissing.length === 0,
      ...(scanFailures.length ? { failures: scanFailures } : {}),
      ...(sentMissing.length ? { missingSent: sentMissing } : {}),
      ...(scanFailures.length || sentMissing.length ? { incompleteNote: '部分文件夹搜索失败或未发现 Sent 文件夹，结果不完整：受影响的会话可能被高估或遗漏；修复后请重新运行。' } : {}),
      thresholdDays: threshold,
      lookbackDays: lookback,
      scannedAccounts: accounts.map(account => account.name),
      sentFolders,
      reminderCount: reminders.length,
      reminders,
    });
  });
}

export type { SavedSearch };
