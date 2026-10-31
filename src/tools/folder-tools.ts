import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ImapService } from '../services/imap-service.js';
import { AccountManager } from '../services/account-manager.js';
import { isSystemFlag } from '../types/index.js';
import { z } from 'zod';

// Backward-compatible account selector (accountId stays accepted; accountName
// and the single-account default are additive conveniences).
const accountSelector = {
  accountId: z.string().optional().describe('Account ID (from imap_list_accounts). Optional if accountName is given or only one account is configured.'),
  accountName: z.string().optional().describe('Account name instead of accountId. Optional if accountId is given or only one account is configured.'),
};

export function folderTools(
  server: McpServer,
  imapService: ImapService,
  accountManager: AccountManager
): void {
  // List folders tool
  server.registerTool('imap_list_folders', {
    description: 'List all folders/mailboxes for an account (names, hierarchy delimiter, attributes, RFC 6154 special-use role). Use this first to discover exact folder names before searching, moving, or creating subfolders  folder naming varies by provider (e.g. "Archive" vs "[Gmail]/All Mail" vs "INBOX.Archive"). The specialUse field ("\\\\Sent", "\\\\Drafts", "\\\\Trash", "\\\\Junk", "\\\\Archive") identifies a folder\'s role independent of its localized name (e.g. "Gesendet" is the Sent folder when specialUse is "\\\\Sent").',
    inputSchema: {
      ...accountSelector,
    }
  }, async ({ accountId: rawAccountId, accountName }) => {
    const accountId = accountManager.resolveAccountId(rawAccountId, accountName);
    const folders = await imapService.listFolders(accountId);
    
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          folders: folders.map(folder => ({
            name: folder.name,
            delimiter: folder.delimiter,
            attributes: folder.attributes,
            // RFC 6154 special-use role (language-independent): lets callers
            // find e.g. the Sent folder even when it is named "Gesendet".
            specialUse: folder.specialUse,
            hasChildren: !!folder.children && folder.children.length > 0,
          })),
        }, null, 2)
      }]
    };
  });

  // Get folder status tool
  server.registerTool('imap_folder_status', {
    description: 'Get status information about a folder',
    inputSchema: {
      ...accountSelector,
      folder: z.string().describe('Folder name'),
    }
  }, async ({ accountId: rawAccountId, accountName, folder }) => {
    const accountId = accountManager.resolveAccountId(rawAccountId, accountName);

    // T01 review: counts (STATUS) and the flag snapshot come from ONE locked
    // region — getFolderStatusSnapshot — so the response can never mix
    // metadata from two moments or two mailboxes, and the locked SELECT can
    // never re-point an in-flight operation to a different folder (MAIL-01).
    const { status, snapshot } = await imapService.getFolderStatusSnapshot(accountId, folder);

    // imapflow returns flag sets as `Set`, which JSON.stringify renders as {}.
    const toFlagArray = (flags: Iterable<string> | undefined): string[] =>
      Array.from(flags ?? []);
    const flags = toFlagArray(snapshot.flags);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          folder: folder,
          messages: {
            total: status.messages,
            new: status.recent,
            unseen: status.unseen,
          },
          uidvalidity: status.uidValidity,
          uidnext: status.uidNext,
          flags,
          permanentFlags: toFlagArray(snapshot.permanentFlags),
          customKeywords: flags.filter(f => !isSystemFlag(f)),
        }, null, 2)
      }]
    };
  });

  // Create folder tool
  server.registerTool('imap_create_folder', {
    description:
      'Create a new IMAP folder/mailbox. Most servers also create any missing parent folders ' +
      '(e.g. creating "Archives/2026/2026-05" auto-creates "Archives" and "Archives/2026"). ' +
      'Returns success even if the folder already exists.',
    inputSchema: {
      ...accountSelector,
      folder: z.string().describe('Full folder path to create (e.g. "Archives/2026/2026-05" or "INBOX.Archive")'),
    }
  }, async ({ accountId: rawAccountId, accountName, folder }) => {
    const accountId = accountManager.resolveAccountId(rawAccountId, accountName);
    try {
      const result = await imapService.createFolder(accountId, folder);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            folder: result.path,
            created: result.created,
            alreadyExisted: result.alreadyExisted,
            message: result.alreadyExisted
              ? `Folder "${result.path}" already existed`
              : `Folder "${result.path}" created`,
          }, null, 2)
        }]
      };
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            folder,
            error: err instanceof Error ? err.message : 'Unknown error',
          }, null, 2)
        }]
      };
    }
  });

  // Get unread count tool
  server.registerTool('imap_get_unread_count', {
    description: 'Count unread (unseen) emails per folder via named STATUS, plus a total. Use for "how many unread do I have?" overviews. Defaults to all folders; pass a folders list to limit scope. Folders whose count cannot be determined are listed in unknownFolders — they are never counted as zero.',
    inputSchema: {
      ...accountSelector,
      folders: z.array(z.string()).optional().describe('List of folders to check (default: all)'),
    }
  }, async ({ accountId: rawAccountId, accountName, folders }) => {
    const accountId = accountManager.resolveAccountId(rawAccountId, accountName);
    const allFolders = await imapService.listFolders(accountId);
    const foldersToCheck = folders || allFolders.map(f => f.name);

    const byFolder: Record<string, number> = {};
    const unknownFolders: string[] = [];
    let totalUnread = 0;

    // T29 / MAIL-06: named STATUS counts server-side (no metadata download,
    // no search cap). A folder that cannot be queried is reported as unknown
    // rather than silently counted as zero.
    for (const folderName of foldersToCheck) {
      try {
        const outcome = await imapService.getFolderUnseenStatus(accountId, folderName);
        if (outcome.unknownReason !== undefined || outcome.unseen === undefined) {
          unknownFolders.push(folderName);
          continue;
        }
        byFolder[folderName] = outcome.unseen;
        totalUnread += outcome.unseen;
      } catch (err) {
        // T29 review: a connection/auth failure mid-sweep must not lose the
        // counts already acquired — the folder is unknown, the rest continue.
        unknownFolders.push(folderName);
      }
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          totalUnread,
          complete: unknownFolders.length === 0,
          byFolder,
          ...(unknownFolders.length > 0 ? { unknownFolders } : {}),
        }, null, 2)
      }]
    };
  });
}