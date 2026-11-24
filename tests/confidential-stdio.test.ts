import { describe, expect, it } from 'vitest';
import { resolveEnabledTools } from '../src/tools/index.js';
import { confidentialMarkers } from '../src/utils/confidential-message.js';

describe('confidential policy injection', () => {
  it('does not parse ambient policy when resolving ordinary tools', () => {
    expect(resolveEnabledTools({ IMAP_MCP_CONFIDENTIAL_MARKERS: 'invalid' })).toBeNull();
  });
  it('restricts tools using the explicitly parsed policy', () => {
    const policy = confidentialMarkers({ IMAP_MCP_CONFIDENTIAL_MARKERS: '["private"]' });
    expect([...resolveEnabledTools({}, policy)!]).toEqual(['imap_get_email']);
    expect([...resolveEnabledTools({ IMAP_MCP_ENABLED_TOOLS: 'search_emails' }, policy)!]).toEqual([]);
  });
});

it('rejects malformed configuration at the STDIO entry before creating a transport', async () => {
  const { vi } = await import('vitest');
  const transport = vi.fn();
  vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: transport }));
  vi.stubEnv('IMAP_MCP_CONFIDENTIAL_MARKERS', 'invalid');
  const originalWrite = process.stdout.write;
  try {
    await expect(import('../src/index.js')).rejects.toThrow('IMAP_MCP_CONFIDENTIAL_MARKERS must be a JSON array');
    expect(transport).not.toHaveBeenCalled();
  } finally {
    process.stdout.write = originalWrite;
    vi.unstubAllEnvs();
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
    vi.resetModules();
  }
});

it('constructs the real web server and ordinary IMAP service with malformed STDIO configuration', async () => {
  const { vi } = await import('vitest');
  vi.stubEnv('IMAP_MCP_CONFIDENTIAL_MARKERS', 'invalid');
  try {
    const { ImapService } = await import('../src/services/imap-service.js');
    const { WebUIServer } = await import('../src/web/server.js');
    const { UnavailableCredentialBackend } = await import('../src/credentials/windows-credential-backend.js');
    expect(() => new ImapService()).not.toThrow();
    // Stub the account store to avoid touching the user's local profile; the
    // server still constructs its own real IMAP service and does not listen.
    expect(() => new WebUIServer(0, { accountManager: {} as never, credentials: new UnavailableCredentialBackend() })).not.toThrow();
  } finally {
    vi.unstubAllEnvs();
  }
});
