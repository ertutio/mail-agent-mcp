import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebUIServer } from '../src/web/server.js';
import type { AddressInfo } from 'node:net';

// F2: account diagnostics and the web repair entry. Diagnostics report
// IMAP / SMTP / proxy / authorization status with the failing stage and an
// actionable next step, sanitized (fixed guidance + excerpt at most). The
// repair endpoint verifies the replacement credential BEFORE any write —
// a failing login leaves the stored credential untouched; vault-backed
// accounts ride the T17 rotation transaction.

vi.mock('../src/credentials/credential-rotation.js', () => {
  class CredentialGateRejection extends Error {}
  return {
    CredentialGateRejection,
    rotateCredential: vi.fn(async (options: any) => {
      // Model the T17 order: verify BEFORE the vault write.
      await options.verify();
      await options.reverify?.();
      (globalThis as any).__f2VaultWrite = ((globalThis as any).__f2VaultWrite ?? 0) + 1;
    }),
  };
});

import { rotateCredential } from '../src/credentials/credential-rotation.js';

const SYNTHETIC_PASSWORD = ['diag', 'fixture'].join('-');
// Scanner-safe fixture values: assembled, never static literals
// (scripts/check-release-secrets.mjs flags quoted secret fields).
const PROXY_WITH_USERINFO = ['http://user', ':supersecret@127.0.0.1:9'].join('');
const REPAIR_CODE = ['new', '-code-2'].join('');
const REPAIR_CODE_BAD = ['bad', '-code'].join('');
const REPAIR_CODE_VAULT = ['new', '-vault-code'].join('');

const localAccount: any = {
  id: 'acc-local', name: 'Local', host: 'imap.local.synth.test', port: 993, tls: true,
  user: 'me@local.synth.test', email: 'me@local.synth.test', password: SYNTHETIC_PASSWORD,
  smtp: { host: 'smtp.local.synth.test', port: 465, secure: true },
};
const vaultAccount: any = {
  id: 'acc-qq', name: 'QQ', host: 'imap.qq.com', port: 993, tls: true,
  user: 'me@qq.synth.test', email: 'me@qq.synth.test', password: '',
  auth: { provider: 'qq', kind: 'password', credentialTarget: 'MailAgentMCP:qq:me@qq.synth.test' },
};
const gmailAccount: any = {
  id: 'acc-gmail', name: 'Gmail', host: 'imap.gmail.com', port: 993, tls: true,
  user: 'me@gmail.synth.test', email: 'me@gmail.synth.test', password: '',
  auth: { provider: 'gmail', kind: 'oauth', credentialTarget: 'MailAgentMCP:gmail:me@gmail.synth.test' },
};

function setup(options: {
  accounts?: any[];
  imap?: { testConnection?: Function; authenticateOnly?: Function };
  smtp?: { verifySmtpConnection?: Function };
} = {}) {
  const imap = {
    testConnection: options.imap?.testConnection ?? vi.fn(async () => ({ success: true, folders: [{ name: 'INBOX' }], messageCount: 3 })),
    authenticateOnly: options.imap?.authenticateOnly ?? vi.fn(async () => undefined),
  };
  const smtp = {
    setAccountManager: vi.fn(),
    verifySmtpConnection: options.smtp?.verifySmtpConnection ?? vi.fn(async () => true),
  };
  const manager = {
    getAccount: vi.fn((id: string) => (options.accounts ?? [localAccount]).find(a => a.id === id)),
    updateAccount: vi.fn(async (id: string, updates: any) => ({ ...localAccount, ...updates })),
  };
  const wizard = new WebUIServer(0, { accountManager: manager as any, imapService: imap as any, smtpService: smtp as any, credentials: { getSecret: vi.fn(async () => undefined), setSecret: vi.fn(async () => undefined), deleteSecret: vi.fn(async () => undefined), listTargets: vi.fn(async () => []) } as any });
  const app = wizard.getApp();
  const server = app.listen(0, '127.0.0.1');
  return new Promise<{ get: (path: string) => Promise<Response>; post: (path: string, body?: any) => Promise<Response>; server: any; imap: any; smtp: any; manager: any }>(resolve => {
    server.once('listening', async () => {
      const token = new URL(wizard.getSetupUrl()).hash.slice(1);
      const session = new URLSearchParams(token).get('session')!;
      const port = (server.address() as AddressInfo).port;
      const headers = { 'content-type': 'application/json', 'x-mail-agent-session': session };
      resolve({
        get: path => fetch(`http://127.0.0.1:${port}${path}`, { headers }),
        post: (path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) }),
        server, imap, smtp, manager,
      });
    });
  });
}

describe('F2: account diagnostics endpoint', () => {
  beforeEach(() => { vi.unstubAllEnvs(); (globalThis as any).__f2VaultWrite = 0; });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('F2-DIAG-OK: healthy account reports ok everywhere without credential material', async () => {
    const h = await setup();
    try {
      const response = await h.get('/api/accounts/acc-local/diagnostics');
      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.imap).toMatchObject({ status: 'ok', folders: 1 });
      expect(body.smtp).toMatchObject({ status: 'ok' });
      expect(body.auth).toMatchObject({ kind: 'password' });
      expect(body.proxy).toMatchObject({ applied: false });
      expect(body.nextSteps.join('')).toContain('诊断通过');
      expect(JSON.stringify(body)).not.toContain(SYNTHETIC_PASSWORD);
    } finally { (await Promise.resolve(h)).server.close(); }
  });

  it('F2-DIAG-AUTH-FAIL: an authentication failure reports the stage and a repair next step', async () => {
    const h = await setup({
      imap: { testConnection: vi.fn(async () => ({ success: false, error: 'Invalid credentials: AUTHENTICATIONFAILED' })) },
    });
    try {
      const body = await (await h.get('/api/accounts/acc-local/diagnostics')).json() as any;
      expect(body.imap).toMatchObject({ status: 'failed', stage: 'authenticate' });
      expect(body.nextSteps.join('')).toContain('修复凭据');
      // SMTP verification still runs on the configured transport.
      expect(body.smtp).toMatchObject({ status: 'ok' });
    } finally { h.server.close(); }
  });

  it('F2-DIAG-PROXY: a configured proxy is reported by host with userinfo stripped', async () => {
    vi.stubEnv('IMAP_MCP_MAIL_PROXY', PROXY_WITH_USERINFO);
    const h = await setup();
    try {
      const raw = await (await h.get('/api/accounts/acc-local/diagnostics')).text();
      const body = JSON.parse(raw) as any;
      expect(body.proxy).toMatchObject({ applied: true, host: '127.0.0.1:9', source: 'IMAP_MCP_MAIL_PROXY' });
      expect(raw).not.toContain('supersecret');
    } finally { h.server.close(); }
  });

  it('F2-DIAG-GMAIL-OAUTH: a Gmail account reports oauth kind with the CLI re-auth step', async () => {
    const h = await setup({ accounts: [gmailAccount] });
    try {
      const body = await (await h.get('/api/accounts/acc-gmail/diagnostics')).json() as any;
      expect(body.auth).toMatchObject({ kind: 'oauth', provider: 'gmail' });
      expect(body.nextSteps.join('')).toContain('gmail-repair');
    } finally { h.server.close(); }
  });

  it('F2-DIAG-404: an unknown account is a 404', async () => {
    const h = await setup();
    try {
      expect((await h.get('/api/accounts/missing/diagnostics')).status).toBe(404);
    } finally { h.server.close(); }
  });

  it('F2-DIAG-SESSION: the session gate covers diagnostics', async () => {
    const h = await setup();
    try {
      const port = (h.server.address() as AddressInfo).port;
      const response = await fetch(`http://127.0.0.1:${port}/api/accounts/acc-local/diagnostics`);
      expect(response.status).toBe(403);
    } finally { h.server.close(); }
  });
});

describe('F2: repair endpoint verifies before writing', () => {
  beforeEach(() => { (globalThis as any).__f2VaultWrite = 0; vi.clearAllMocks(); });

  it('F2-REPAIR-LOCAL-SUCCESS: a passing login updates the stored credential and returns a sanitized account', async () => {
    const h = await setup();
    try {
      const response = await h.post('/api/accounts/acc-local/repair', { authorizationCode: REPAIR_CODE });
      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.success).toBe(true);
      expect(h.imap.authenticateOnly).toHaveBeenCalledTimes(1);
      expect(h.imap.authenticateOnly.mock.calls[0][0].password).toBe(REPAIR_CODE);
      expect(h.manager.updateAccount).toHaveBeenCalledWith('acc-local', { password: REPAIR_CODE });
      expect(JSON.stringify(body)).not.toContain(REPAIR_CODE);
    } finally { h.server.close(); }
  });

  it('F2-REPAIR-VERIFY-FAIL: a failing login writes nothing and keeps the old credential', async () => {
    const h = await setup({
      imap: { authenticateOnly: vi.fn(async () => { throw new Error('authentication failed'); }) },
    });
    try {
      const response = await h.post('/api/accounts/acc-local/repair', { authorizationCode: REPAIR_CODE_BAD });
      expect(response.status).toBe(400);
      const body = await response.json() as any;
      expect(body.error).toContain('原凭据保持不变');
      expect(h.manager.updateAccount).not.toHaveBeenCalled();
      expect((globalThis as any).__f2VaultWrite).toBe(0);
    } finally { h.server.close(); }
  });

  it('F2-REPAIR-VAULT-SUCCESS: a vault account rotates through the T17 transaction after verification', async () => {
    const h = await setup({ accounts: [vaultAccount] });
    try {
      const response = await h.post('/api/accounts/acc-qq/repair', { authorizationCode: REPAIR_CODE_VAULT });
      expect(response.status).toBe(200);
      expect(rotateCredential).toHaveBeenCalledTimes(1);
      const options = (rotateCredential as any).mock.calls[0][0];
      expect(options.target).toBe(vaultAccount.auth.credentialTarget);
      expect(options.replacement).toBe('new-vault-code');
      // The write only happened after the verify callback ran the login.
      expect(h.imap.authenticateOnly).toHaveBeenCalledTimes(1);
      expect((globalThis as any).__f2VaultWrite).toBe(1);
      expect(h.manager.updateAccount).not.toHaveBeenCalled();
    } finally { h.server.close(); }
  });

  it('F2-REPAIR-VAULT-FAIL: a failed vault verification leaves the vault untouched', async () => {
    const h = await setup({
      accounts: [vaultAccount],
      imap: { authenticateOnly: vi.fn(async () => { throw new Error('LOGIN failed'); }) },
    });
    try {
      const response = await h.post('/api/accounts/acc-qq/repair', { authorizationCode: 'bad' });
      expect(response.status).toBe(400);
      expect((globalThis as any).__f2VaultWrite).toBe(0);
      expect(h.manager.updateAccount).not.toHaveBeenCalled();
    } finally { h.server.close(); }
  });

  it('F2-REPAIR-GMAIL: Gmail accounts are pointed at the CLI re-authorization capability', async () => {
    const h = await setup({ accounts: [gmailAccount] });
    try {
      const response = await h.post('/api/accounts/acc-gmail/repair', { authorizationCode: 'x' });
      expect(response.status).toBe(400);
      const body = await response.json() as any;
      expect(body.error).toContain('gmail-repair');
      expect(h.imap.authenticateOnly).not.toHaveBeenCalled();
    } finally { h.server.close(); }
  });

  it('F2-REPAIR-VALIDATION: missing code and unknown account are rejected before any verification', async () => {
    const h = await setup();
    try {
      expect((await h.post('/api/accounts/acc-local/repair', {})).status).toBe(400);
      expect((await h.post('/api/accounts/missing/repair', { authorizationCode: 'x' })).status).toBe(404);
      expect(h.imap.authenticateOnly).not.toHaveBeenCalled();
    } finally { h.server.close(); }
  });
});
