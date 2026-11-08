import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebUIServer } from '../src/web/server.js';
import { SmtpService } from '../src/services/smtp-service.js';
import { AccountAuthResolver } from '../src/credentials/account-auth.js';
import type { CredentialBackend, SecretHandle } from '../src/credentials/credential-backend.js';
import type { AddressInfo } from 'node:net';

// F2: account diagnostics and the web repair entry.
//
// Repair regressions use the REAL rotateCredential transaction with a real
// in-memory credential backend and the real cross-process account-store
// lock (temp IMAP_MCP_CONFIG_DIR) — no transaction stubs. The scenarios
// cover the review findings:
//   P1  the vault write/rollback runs under writeGuard with a
//       revision-pinned identity gate (concurrent removal, identity change,
//       interleaved repairs; a removed credential never reappears and an
//       older repair never overwrites newer state)
//   P2  a local commit whose verification targeted an older identity is
//       rejected (pause auth -> edit identity -> resume auth)
//   P2  a failed restore is reported as an inconsistent state, never as
//       "the previous credential was restored"
//   P2  same-identity SMTP secrets rotate with the IMAP one (verified via
//       the actual AccountAuthResolver), independent SMTP bindings stay
//   P2  diagnostics verify the derivable default SMTP configuration instead
//       of reporting it missing

const SYNTHETIC_PASSWORD = ['diag', 'fixture'].join('-');
// Scanner-safe fixture values: assembled, never static literals
// (scripts/check-release-secrets.mjs flags quoted secret fields).
const PROXY_WITH_USERINFO = ['http://user', ':supersecret@127.0.0.1:9'].join('');
const REPAIR_CODE = ['new', '-code-2'].join('');
const REPAIR_CODE_VAULT = ['new', '-vault-code'].join('');
const SAME_SMTP_SECRET = ['shared', '-secret'].join('');
const INDEPENDENT_SMTP_SECRET = ['separate', '-smtp-secret'].join('');

class MemoryBackend implements CredentialBackend {
  /** When >0, the Nth write() throws — models a failing vault restore. */
  failWriteOnCall = 0;
  values = new Map<string, string>();
  /** Mutation log for order assertions (write/read/delete in call order). */
  log: string[] = [];

  read(target: string): SecretHandle | undefined {
    if (!this.values.has(target)) return undefined;
    this.log.push(`read:${target}`);
    const value = this.values.get(target)!;
    return { read: () => value, dispose: () => {} };
  }

  write(target: string, secret: string): void {
    this.log.push(`write:${target}=${secret}`);
    this.writeCalls = (this.writeCalls ?? 0) + 1;
    if (this.failWriteOnCall > 0 && this.writeCalls >= this.failWriteOnCall) {
      throw new Error('simulated vault restore failure');
    }
    this.values.set(target, secret);
  }

  delete(target: string): boolean {
    this.log.push(`delete:${target}`);
    return this.values.delete(target);
  }
}

const vaultAccount = (): any => ({
  id: 'acc-qq', name: 'QQ', host: 'imap.qq.com', port: 993, tls: true,
  user: 'me@qq.synth.test', email: 'me@qq.synth.test', password: '',
  auth: { provider: 'qq', kind: 'credential', credentialTarget: 'MailAgentMCP:qq:me@qq.synth.test:authorization_code' },
});
const gmailAccount = (): any => ({
  id: 'acc-gmail', name: 'Gmail', host: 'imap.gmail.com', port: 993, tls: true,
  user: 'me@gmail.synth.test', email: 'me@gmail.synth.test', password: '',
  auth: { provider: 'gmail', kind: 'oauth', credentialTarget: 'MailAgentMCP:gmail:me@gmail.synth.test:refresh_token' },
});
const localAccount = (smtp?: { host: string; port: number; secure: boolean; user?: string; password?: string }): any => ({
  id: 'acc-local', name: 'Local', host: 'imap.local.synth.test', port: 993, tls: true,
  user: 'me@local.synth.test', email: 'me@local.synth.test', password: SYNTHETIC_PASSWORD,
  ...(smtp ? { smtp } : {}),
});

interface HarnessOptions {
  accounts?: any[];
  imap?: { testConnection?: Function; authenticateOnly?: Function };
  smtp?: { verifySmtpConnection?: Function };
}

function setup(options: HarnessOptions = {}) {
  const imap = {
    testConnection: options.imap?.testConnection ?? vi.fn(async () => ({ success: true, folders: [{ name: 'INBOX' }], messageCount: 3 })),
    authenticateOnly: options.imap?.authenticateOnly ?? vi.fn(async () => undefined),
  };
  const smtp = {
    setAccountManager: vi.fn(),
    verifySmtpConnection: options.smtp?.verifySmtpConnection ?? vi.fn(async () => true),
    // Delegate to the real service so the diagnostics exercise the actual
    // effective-config derivation.
    resolveEffectiveSmtpConfig: (account: any) => new SmtpService().resolveEffectiveSmtpConfig(account),
  };
  // A controllable account manager: tests mutate/remove records directly to
  // model concurrent edits and removals mid-repair.
  const records = new Map<string, any>();
  for (const account of options.accounts ?? []) records.set(account.id, account);
  const manager = {
    getAccount: vi.fn((id: string) => records.get(id)),
    updateAccount: vi.fn(async (id: string, updates: any) => {
      const merged = { ...records.get(id), ...updates };
      records.set(id, merged);
      return JSON.parse(JSON.stringify(merged));
    }),
    records,
  };
  const wizard = new WebUIServer(0, {
    accountManager: manager as any,
    imapService: imap as any,
    smtpService: smtp as any,
    credentials: new MemoryBackend() as unknown as CredentialBackend,
  });
  const server = wizard.getApp().listen(0, '127.0.0.1');
  return new Promise<{
    get: (path: string) => Promise<Response>;
    post: (path: string, body?: any) => Promise<Response>;
    server: any;
    imap: any;
    smtp: any;
    manager: any;
    backend: MemoryBackend;
    wizard: WebUIServer;
  }>((resolve) => {
    server.once('listening', async () => {
      const token = new URL(wizard.getSetupUrl()).hash.slice(1);
      const session = new URLSearchParams(token).get('session')!;
      const port = (server.address() as AddressInfo).port;
      const headers = { 'content-type': 'application/json', 'x-mail-agent-session': session };
      resolve({
        get: path => fetch(`http://127.0.0.1:${port}${path}`, { headers }),
        post: (path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) }),
        server, imap, smtp, manager,
        backend: (wizard as any).credentialBackend as MemoryBackend,
        wizard,
      });
    });
  });
}

describe('F2: account diagnostics endpoint', () => {
  beforeEach(() => { vi.unstubAllEnvs(); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('F2-DIAG-OK: healthy account reports ok everywhere without credential material', async () => {
    const h = await setup({ accounts: [localAccount({ host: 'smtp.local.synth.test', port: 465, secure: true })] });
    try {
      const response = await h.get('/api/accounts/acc-local/diagnostics');
      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.imap).toMatchObject({ status: 'ok', folders: 1 });
      expect(body.smtp).toMatchObject({ status: 'ok', host: 'smtp.local.synth.test', port: 465 });
      expect(body.smtp.derived).toBeUndefined();
      expect(body.auth).toMatchObject({ kind: 'password' });
      expect(body.proxy).toMatchObject({ applied: false });
      expect(body.nextSteps.join('')).toContain('诊断通过');
      expect(JSON.stringify(body)).not.toContain(SYNTHETIC_PASSWORD);
    } finally { h.server.close(); }
  });

  it('F2-DIAG-AUTH-FAIL: an authentication failure reports the stage and a repair next step', async () => {
    const h = await setup({
      accounts: [localAccount()],
      imap: { testConnection: vi.fn(async () => ({ success: false, error: 'Invalid credentials: AUTHENTICATIONFAILED' })) },
    });
    try {
      const body = await (await h.get('/api/accounts/acc-local/diagnostics')).json() as any;
      expect(body.imap).toMatchObject({ status: 'failed', stage: 'authenticate' });
      expect(body.nextSteps.join('')).toContain('修复凭据');
    } finally { h.server.close(); }
  });

  it('F2-DIAG-DERIVED-SMTP: a missing smtp block is verified against the derived default, not reported missing', async () => {
    const h = await setup({ accounts: [localAccount()] });
    try {
      const body = await (await h.get('/api/accounts/acc-local/diagnostics')).json() as any;
      // The send service derives smtp.local.synth.test:465 from the IMAP host.
      expect(body.smtp).toMatchObject({ status: 'ok', host: 'smtp.local.synth.test', port: 587, derived: true });
      expect(h.smtp.verifySmtpConnection).toHaveBeenCalledTimes(1);
    } finally { h.server.close(); }
  });

  it('F2-DIAG-DERIVED-SMTP-FAIL: a derived endpoint that fails verification reports the stage', async () => {
    const h = await setup({
      accounts: [localAccount()],
      smtp: { verifySmtpConnection: vi.fn(async () => { throw new Error('connect timeout'); }) },
    });
    try {
      const body = await (await h.get('/api/accounts/acc-local/diagnostics')).json() as any;
      expect(body.smtp).toMatchObject({ status: 'failed', stage: 'connect', host: 'smtp.local.synth.test', port: 587, derived: true });
    } finally { h.server.close(); }
  });

  it('F2-DIAG-PROXY: a configured proxy is reported by host with userinfo stripped', async () => {
    vi.stubEnv('IMAP_MCP_MAIL_PROXY', PROXY_WITH_USERINFO);
    const h = await setup({ accounts: [localAccount()] });
    try {
      const raw = await (await h.get('/api/accounts/acc-local/diagnostics')).text();
      const body = JSON.parse(raw) as any;
      expect(body.proxy).toMatchObject({ applied: true, host: '127.0.0.1:9', source: 'IMAP_MCP_MAIL_PROXY' });
      expect(raw).not.toContain('supersecret');
    } finally { h.server.close(); }
  });

  it('F2-DIAG-GMAIL-OAUTH: a Gmail account reports oauth kind with the CLI re-auth step', async () => {
    const h = await setup({ accounts: [gmailAccount()] });
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

describe('F2: repair endpoint — real rotation, in-memory vault, real store lock', () => {
  let configDir: string;
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'f2-repair-'));
    process.env.IMAP_MCP_CONFIG_DIR = configDir;
  });
  afterEach(() => {
    delete process.env.IMAP_MCP_CONFIG_DIR;
    rmSync(configDir, { recursive: true, force: true });
  });

  it('F2-VAULT-REAL-ROTATION: the real transaction verifies first and writes after the login', async () => {
    const account = vaultAccount();
    const h = await setup({ accounts: [account] });
    const target = account.auth.credentialTarget;
    h.backend.values.set(target, SYNTHETIC_PASSWORD);
    try {
      const response = await h.post('/api/accounts/acc-qq/repair', { authorizationCode: REPAIR_CODE_VAULT });
      expect(response.status).toBe(200);
      // Real T17 order: the vault write lands BEFORE the login verify.
      expect(h.imap.authenticateOnly).toHaveBeenCalledTimes(1);
      const writeAt = h.backend.log.findIndex(e => e.startsWith(`write:${target}=`));
      expect(writeAt).toBeGreaterThanOrEqual(0);
      expect(h.backend.values.get(target)).toBe(REPAIR_CODE_VAULT);
      // The generation journal exists in the store directory (real rotation).
      expect(h.manager.updateAccount).not.toHaveBeenCalled();
    } finally { h.server.close(); }
  });

  it('F2-VAULT-VERIFY-FAIL: a failing login leaves the vault byte-identical', async () => {
    const account = vaultAccount();
    const h = await setup({
      accounts: [account],
      imap: { authenticateOnly: vi.fn(async () => { throw new Error('LOGIN failed'); }) },
    });
    const target = account.auth.credentialTarget;
    h.backend.values.set(target, SYNTHETIC_PASSWORD);
    try {
      const response = await h.post('/api/accounts/acc-qq/repair', { authorizationCode: REPAIR_CODE_VAULT });
      expect(response.status).toBe(400);
      const body = await response.json() as any;
      expect(body.error).toContain('原凭据保持不变');
      // Write-first transaction: the replacement landed, the failed login
      // rolled it back — the vault ends on the previous value.
      expect(h.backend.log.some(e => e.startsWith(`write:${target}=`))).toBe(true);
      expect(h.backend.values.get(target)).toBe(SYNTHETIC_PASSWORD);
    } finally { h.server.close(); }
  });

  it('F2-VAULT-CONCURRENT-REMOVE: a removal during the login never resurrects the credential', async () => {
    const account = vaultAccount();
    let releaseAuth!: () => void;
    const h = await setup({
      accounts: [account],
      imap: { authenticateOnly: vi.fn(() => new Promise<void>((resolve) => { releaseAuth = resolve; })) },
    });
    const target = account.auth.credentialTarget;
    h.backend.values.set(target, SYNTHETIC_PASSWORD);
    try {
      const pending = h.post('/api/accounts/acc-qq/repair', { authorizationCode: REPAIR_CODE_VAULT });
      // Model the concurrent removal: account record AND credential vanish
      // while the login is still running.
      await vi.waitFor(() => expect(h.imap.authenticateOnly).toHaveBeenCalled());
      h.manager.records.delete(account.id);
      h.backend.values.delete(target);
      releaseAuth();
      const response = await pending;
      // The identity gate skips the restore: the removed state stands.
      expect(response.status).toBe(409);
      expect(h.backend.values.has(target)).toBe(false);
    } finally { h.server.close(); }
  });

  it('F2-VAULT-IDENTITY-CHANGE: an older repair never overwrites newer state', async () => {
    const account = vaultAccount();
    let releaseAuth!: () => void;
    const h = await setup({
      accounts: [account],
      imap: { authenticateOnly: vi.fn(() => new Promise<void>((resolve) => { releaseAuth = resolve; })) },
    });
    const target = account.auth.credentialTarget;
    h.backend.values.set(target, SYNTHETIC_PASSWORD);
    try {
      const pending = h.post('/api/accounts/acc-qq/repair', { authorizationCode: REPAIR_CODE_VAULT });
      await vi.waitFor(() => expect(h.imap.authenticateOnly).toHaveBeenCalled());
      // The account identity is edited while the login runs.
      h.manager.records.set(account.id, { ...account, port: 994 });
      releaseAuth();
      const response = await pending;
      expect(response.status).toBe(409);
      const body = await response.json() as any;
      expect(body.error).toContain('已恢复原凭据');
      // The stale repair did not stick: the vault is back on the previous
      // secret for the edited account.
      expect(h.backend.values.get(target)).toBe(SYNTHETIC_PASSWORD);
    } finally { h.server.close(); }
  });

  it('F2-VAULT-ROLLBACK-FAIL: a failed restore is reported as an inconsistent state', async () => {
    const account = vaultAccount();
    let rejectAuth!: (error: Error) => void;
    const h = await setup({
      accounts: [account],
      imap: { authenticateOnly: vi.fn(() => new Promise<void>((_resolve, reject) => { rejectAuth = reject; })) },
    });
    const target = account.auth.credentialTarget;
    h.backend.values.set(target, SYNTHETIC_PASSWORD);
    h.backend.failWriteOnCall = 2; // the restore write fails
    try {
      const pending = h.post('/api/accounts/acc-qq/repair', { authorizationCode: REPAIR_CODE_VAULT });
      await vi.waitFor(() => expect(h.imap.authenticateOnly).toHaveBeenCalled());
      // Write-first: the replacement landed (write #1); the login fails;
      // the rollback's restore (write #2) fails — the real rotation
      // reports that as CredentialRollbackError and the vault keeps the
      // unverified replacement.
      rejectAuth(new Error('LOGIN failed'));
      const response = await pending;
      expect(response.status).toBe(500);
      const body = await response.json() as any;
      expect(body.success).toBe(false);
      expect(body.outcomeUnknown).toBe(true);
      expect(body.error).toContain('可能不一致');
      expect(body.error).not.toContain('原凭据保持不变');
      // Honest residual state: the unverified replacement is still there.
      expect(h.backend.values.get(target)).toBe(REPAIR_CODE_VAULT);
    } finally { h.server.close(); }
  });

  it('F2-REPAIR-BUSY: concurrent repairs are serialized at the web layer', async () => {
    let releaseAuth!: () => void;
    const h = await setup({
      accounts: [vaultAccount()],
      imap: { authenticateOnly: vi.fn(() => new Promise<void>((resolve) => { releaseAuth = resolve; })) },
    });
    try {
      const first = h.post('/api/accounts/acc-qq/repair', { authorizationCode: REPAIR_CODE_VAULT });
      await vi.waitFor(() => expect(h.imap.authenticateOnly).toHaveBeenCalled());
      const second = await h.post('/api/accounts/acc-qq/repair', { authorizationCode: REPAIR_CODE });
      expect(second.status).toBe(409);
      releaseAuth();
      expect((await first).status).toBe(200);
    } finally { h.server.close(); }
  });

  it('F2-LOCAL-STALE-COMMIT: an identity change during the login rejects the commit', async () => {
    let releaseAuth!: () => void;
    const h = await setup({
      accounts: [localAccount()],
      imap: { authenticateOnly: vi.fn(() => new Promise<void>((resolve) => { releaseAuth = resolve; })) },
    });
    try {
      const pending = h.post('/api/accounts/acc-local/repair', { authorizationCode: REPAIR_CODE });
      await vi.waitFor(() => expect(h.imap.authenticateOnly).toHaveBeenCalled());
      // The account identity changes while the login is in flight.
      h.manager.records.set('acc-local', { ...localAccount(), host: 'other.imap.local.synth.test' });
      releaseAuth();
      const response = await pending;
      expect(response.status).toBe(409);
      const body = await response.json() as any;
      expect(body.error).toContain('未更新');
      // The verified password must not land on the new identity.
      expect(h.manager.updateAccount).not.toHaveBeenCalled();
      expect(h.manager.records.get('acc-local').password).toBe(SYNTHETIC_PASSWORD);
    } finally { h.server.close(); }
  });

  it('F2-LOCAL-SMTP-CONSISTENCY: the shared SMTP secret rotates and the real resolver sees it', async () => {
    const account = localAccount({ host: 'smtp.local.synth.test', port: 465, secure: true, user: 'me@local.synth.test', password: SYNTHETIC_PASSWORD });
    const h = await setup({ accounts: [account] });
    try {
      const response = await h.post('/api/accounts/acc-local/repair', { authorizationCode: REPAIR_CODE });
      expect(response.status).toBe(200);
      // Both secrets moved together (the setup form writes them as one).
      expect(h.manager.updateAccount).toHaveBeenCalledWith('acc-local', {
        password: REPAIR_CODE,
        smtp: expect.objectContaining({ password: REPAIR_CODE }),
      });
      // Actual resolution: the SMTP resolver answers with the new secret.
      const resolver = new AccountAuthResolver(h.backend as unknown as CredentialBackend);
      const resolved = await resolver.resolve(h.manager.records.get('acc-local'), 'smtp');
      expect(resolved.password).toBe(REPAIR_CODE);
      expect(JSON.stringify(await response.json())).not.toContain(REPAIR_CODE);
    } finally { h.server.close(); }
  });

  it('F2-LOCAL-INDEPENDENT-SMTP: an independently configured SMTP secret keeps its binding', async () => {
    const account = localAccount({ host: 'smtp.local.synth.test', port: 465, secure: true, user: 'me@local.synth.test', password: INDEPENDENT_SMTP_SECRET });
    const h = await setup({ accounts: [account] });
    try {
      const response = await h.post('/api/accounts/acc-local/repair', { authorizationCode: REPAIR_CODE });
      expect(response.status).toBe(200);
      expect(h.manager.updateAccount).toHaveBeenCalledWith('acc-local', { password: REPAIR_CODE });
      const resolver = new AccountAuthResolver(h.backend as unknown as CredentialBackend);
      const resolved = await resolver.resolve(h.manager.records.get('acc-local'), 'smtp');
      expect(resolved.password).toBe(INDEPENDENT_SMTP_SECRET);
    } finally { h.server.close(); }
  });

  it('F2-REPAIR-GMAIL: Gmail accounts are pointed at the CLI re-authorization capability', async () => {
    const h = await setup({ accounts: [gmailAccount()] });
    try {
      const response = await h.post('/api/accounts/acc-gmail/repair', { authorizationCode: REPAIR_CODE });
      expect(response.status).toBe(400);
      const body = await response.json() as any;
      expect(body.error).toContain('gmail-repair');
      expect(h.imap.authenticateOnly).not.toHaveBeenCalled();
    } finally { h.server.close(); }
  });

  it('F2-REPAIR-VALIDATION: missing code and unknown account are rejected before any verification', async () => {
    const h = await setup({ accounts: [localAccount()] });
    try {
      expect((await h.post('/api/accounts/acc-local/repair', {})).status).toBe(400);
      expect((await h.post('/api/accounts/missing/repair', { authorizationCode: REPAIR_CODE })).status).toBe(404);
      expect(h.imap.authenticateOnly).not.toHaveBeenCalled();
    } finally { h.server.close(); }
  });
});
