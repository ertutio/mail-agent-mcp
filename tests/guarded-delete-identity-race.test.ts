import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ImapService } from '../src/services/imap-service.js';
import { guardedDeletion } from '../src/tools/guarded-delete-tools.js';

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text?: string }> }>;

function fixture() {
  let revision: string | undefined = 'identity-a';
  const handlers = new Map<string, Handler>();
  const imap = {
    getAccountRevision: vi.fn(() => revision),
    getFolderStatus: vi.fn(async () => ({ uidValidity: 123 })),
    resolveTrashFolder: vi.fn(async () => 'Trash'),
    searchEmails: vi.fn(async () => [{ uid: 7 }]),
    bulkDelete: vi.fn(async () => ({ deleted: 1, failed: 0, errors: [] })),
    deleteEmail: vi.fn(),
  };
  const server = {
    registerTool(name: string, _config: unknown, handler: Handler) { handlers.set(name, handler); },
  };
  const guarded = guardedDeletion(server as unknown as McpServer, imap as unknown as ImapService);
  guarded.server.registerTool('imap_bulk_delete_by_search', {
    description: 'Synthetic deletion selection',
    inputSchema: { accountId: z.string(), folder: z.string() },
  }, async ({ accountId, folder }) => {
    const selected = await guarded.imap.searchEmails(accountId, folder, {});
    await guarded.imap.bulkDelete(accountId, folder, selected.map(item => item.uid));
    return { content: [{ type: 'text', text: 'selection captured' }] };
  });
  const preview = async () => {
    const result = await handlers.get('imap_bulk_delete_by_search')!({ accountId: 'account', folder: 'INBOX' });
    return JSON.parse(result.content[0]!.text!) as { previewId: string };
  };
  const confirm = (previewId: string) => handlers.get('imap_confirm_delete')!({ previewId, confirmed: true });
  return { imap, preview, confirm, setRevision: (next: string | undefined) => { revision = next; } };
}

describe('deletion preview account identity across awaited work', () => {
  it('rejects identity replacement during selection even when UIDVALIDITY is unchanged', async () => {
    const f = fixture();
    f.imap.searchEmails.mockImplementation(async () => {
      f.setRevision('identity-b');
      return [{ uid: 7 }];
    });
    await expect(f.preview()).rejects.toThrow(/account.*(identity|changed)|identity.*changed/i);
    expect(f.imap.bulkDelete).not.toHaveBeenCalled();
  });

  it('rejects identity replacement during confirmation trash resolution', async () => {
    const f = fixture();
    const preview = await f.preview();
    f.imap.resolveTrashFolder.mockImplementation(async () => {
      f.setRevision('identity-b');
      return 'Trash';
    });
    await expect(f.confirm(preview.previewId)).rejects.toThrow(/account.*(identity|changed)|identity.*changed/i);
    expect(f.imap.bulkDelete).not.toHaveBeenCalled();
  });

  it('passes the frozen account identity into the mutation service', async () => {
    const f = fixture();
    const preview = await f.preview();
    await f.confirm(preview.previewId);
    expect(f.imap.bulkDelete).toHaveBeenCalledExactlyOnceWith(
      'account', 'INBOX', [7], 50, undefined, 123, false, 'identity-a',
    );
  });

  it('cannot create a deletion preview without an account identity', async () => {
    const f = fixture();
    f.setRevision(undefined);
    await expect(f.preview()).rejects.toThrow(/account.*(removed|not found)|identity/i);
    expect(f.imap.bulkDelete).not.toHaveBeenCalled();
  });
});
