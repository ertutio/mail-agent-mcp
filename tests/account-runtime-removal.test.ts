import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/services/account-manager.js';
import { ImapService } from '../src/services/imap-service.js';
describe('browser account changes are visible to a running MCP process', () => {
  it('refreshes account listings and name lookup after another manager adds or removes an account', async () => {
    const root = await mkdtemp(join(tmpdir(), 'account-refresh-fixture-'));
    const previous = process.env.IMAP_MCP_CONFIG_DIR;
    process.env.IMAP_MCP_CONFIG_DIR = root;
    try {
      const browser = new AccountManager(); const mcp = new AccountManager();
      const account = await browser.addAccount({ name: 'fixture', host: 'imap.example.test', user: 'fixture@example.test', password: ['fixture', '-only'].join(''), port: 993, tls: true });
      expect(mcp.getAllAccounts().map(a => a.id)).toEqual([account.id]);
      expect(mcp.getAccountByName('fixture')?.id).toBe(account.id);
      await browser.removeAccount(account.id);
      expect(mcp.getAllAccounts()).toEqual([]);
      expect(mcp.getAccountByName('fixture')).toBeUndefined();
      expect(() => mcp.resolveAccountId(account.id)).toThrow(/not found/);
    } finally {
      if (previous === undefined) delete process.env.IMAP_MCP_CONFIG_DIR; else process.env.IMAP_MCP_CONFIG_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
  it('rejects operations on an already cached live connection after account removal', async () => {
    const service = new ImapService();
    service.setAccountManager({ getAccount: () => undefined } as any);
    const client = { usable: true, close: vi.fn(), list: vi.fn(async () => []) };
    (service as any).connections.set('removed', { client, isConnected: true, account: { id: 'removed' } });
    await expect(service.listFolders('removed')).rejects.toThrow(/removed|not found/);
    expect(client.close).toHaveBeenCalledOnce();
    expect(client.list).not.toHaveBeenCalled();
  });
});
