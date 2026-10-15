import { describe, it, expect } from 'vitest';
import { accountTools } from '../src/tools/account-tools.js';
describe('account tools are read-only configuration access', () => {
  it('has no credential input or account mutation handlers even when called without filtering', () => {
    const tools = new Map<string, any>();
    accountTools({ registerTool: (name: string, config: any, handler: any) => tools.set(name, { config, handler }) } as any, {} as any, {} as any);
    expect([...tools.keys()].sort()).toEqual(['imap_connect', 'imap_disconnect', 'imap_list_accounts', 'imap_test_account']);
    for (const { config } of tools.values()) expect(Object.keys(config.inputSchema)).not.toContain('password');
  });
});
