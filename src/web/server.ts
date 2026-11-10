import express from 'express';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import bodyParser from 'body-parser';
import path from 'path';
import fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import open from 'open';
import { AccountManager } from '../services/account-manager.js';
import { ImapService } from '../services/imap-service.js';
import { SmtpService } from '../services/smtp-service.js';
import { resolveMailProxy } from '../utils/mail-proxy.js';
import { rotateCredential, CredentialGateRejection, CredentialRollbackError } from '../credentials/credential-rotation.js';
import { accountRevision } from '../utils/account-revision.js';
import { AccountRevisionMismatchError } from '../services/account-manager.js';
import { withAccountStoreLock, accountStoreDirectory } from '../utils/account-store-lock.js';
import { emailProviders, getProviderByEmail } from '../providers/email-providers.js';
import { AccountAuthResolver } from '../credentials/account-auth.js';
import { createGmailAccessTokenExchange } from '../credentials/gmail-token-exchange.js';
import { UnavailableCredentialBackend, WindowsCredentialBackend } from '../credentials/windows-credential-backend.js';
import { ImapAccount } from '../types/index.js';
import type { CredentialBackend } from '../credentials/credential-backend.js';
import { AccountEnrollmentService } from '../credentials/account-enrollment.js';
import { runGmailOAuthLoopback } from '../credentials/gmail-oauth-loopback.js';
import { enrollmentRouter } from './enrollment-router.js';
import { resolvePackageVersion } from '../utils/package-version.js';
import type { Server } from 'node:http';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Strip credentials before an account crosses the wizard's HTTP boundary. The
// API uses a private local session. It still must never return credentials.
// Returns a shallow copy with
// `password` and `smtp.password` removed.
function stripAccountSecrets<T extends Record<string, any>>(account: T): Omit<T, 'password'> {
  const { password: _password, ...rest } = account;
  const safe: Record<string, any> = { ...rest };
  if (safe.smtp && typeof safe.smtp === 'object' && 'password' in safe.smtp) {
    safe.smtp = { ...safe.smtp };
    delete safe.smtp.password;
  }
  return safe as Omit<T, 'password'>;
}

// F2: raised when the login verified against an identity that changed
// mid-flight — the rotation has already restored the previous secret.
class StaleIdentityError extends Error {}

// F2 diagnostics helpers — fixed guidance crosses the boundary; provider
// details are reduced to a stage plus a sanitized excerpt.
function sanitizeDetail(message: string): string {
  return message.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 300);
}

function classifyConnectionStage(message: string): 'proxy' | 'tls' | 'authenticate' | 'connect' | 'session' {
  const m = message.toLowerCase();
  if (m.includes('imap_mcp_mail_proxy') || m.includes('imap_mcp_gmail_proxy')) return 'proxy';
  if (/(tls|ssl|certificate|self[- ]signed|handshake|starttls)/.test(m)) return 'tls';
  if (/(auth|login|credential|password|authorization|invalid.*grant)/.test(m)) return 'authenticate';
  if (/(econnrefused|enotfound|etimedout|timeout|econnreset|ehostunreach|enetunreach|eai_again|getaddrinfo|dns|socket)/.test(m)) return 'connect';
  return 'session';
}

function proxyDiagnostics(account: ImapAccount): { applied: boolean; host?: string; source?: string } {
  try {
    const configured = resolveMailProxy(process.env, account.host, account.auth?.provider);
    if (!configured) return { applied: false };
    let host: string | undefined;
    try {
      const parsed = new URL(configured);
      if (parsed.hostname) host = parsed.hostname + (parsed.port ? `:${parsed.port}` : '');
    } catch { /* unparseable — report applied without host */ }
    const source = account.auth?.provider === 'gmail'
      ? 'gmail-policy'
      : process.env.IMAP_MCP_MAIL_PROXY?.trim() ? 'IMAP_MCP_MAIL_PROXY'
        : 'system-http-proxy';
    return { applied: true, ...(host ? { host } : {}), source };
  } catch {
    // An invalid proxy configuration is itself a diagnostic finding; the
    // IMAP check below will fail with it and the stage mapping reports it.
    return { applied: true, source: 'invalid-config' };
  }
}

function diagnosticsNextSteps(state: {
  authKind: string;
  imap: { status: string; stage?: string };
  smtp: { status: string; stage?: string };
  proxy: { applied: boolean; source?: string };
}): string[] {
  const steps: string[] = [];
  if (state.imap.status === 'ok' && state.smtp.status === 'ok') {
    return [
      '诊断通过，收发状态正常。',
      ...(state.authKind === 'oauth' ? ['Gmail 授权失效时，使用 mail-agent-enroll gmail-repair 重新授权。'] : []),
    ];
  }
  switch (state.imap.stage) {
    case 'authenticate':
      steps.push('登录验证失败：请在邮箱设置中重新生成客户端授权码，然后使用本页的“修复凭据”更新。');
      break;
    case 'tls':
      steps.push('TLS/证书验证失败：请确认服务器证书有效；使用代理时检查代理是否拦截了 TLS。');
      break;
    case 'proxy':
      steps.push('代理配置无效：请检查 IMAP_MCP_MAIL_PROXY / IMAP_MCP_GMAIL_PROXY 环境变量的代理地址。');
      break;
    case 'connect':
      steps.push('无法连接服务器：请检查网络、服务器地址和端口；使用代理时确认代理可用。');
      break;
    case 'session':
      if (state.imap.status === 'failed') steps.push('登录成功但读取邮箱失败：请稍后重试；持续失败时检查账号的文件夹权限。');
      break;
  }
  if (state.smtp.status === 'failed') steps.push('SMTP 验证失败：发送功能暂不可用；请核对 SMTP 服务器与凭据后重试。');
  if (state.smtp.status === 'failed') steps.push('SMTP 验证失败：发送功能暂不可用；请核对 SMTP 服务器与凭据后重试。');
  if (state.authKind === 'oauth') steps.push('Gmail 授权失效时，使用 mail-agent-enroll gmail-repair 重新授权。');
  if (state.authKind === 'missing') steps.push('账号缺少凭据：请使用“修复凭据”更新，或移除后重新添加。');
  if (!steps.length) steps.push('部分检查未通过，请按上方各状态项处理后重试诊断。');
  return steps;
}

export class WebUIServer {
  private readonly sessionToken = randomBytes(32).toString('hex');
  private app: express.Application;
  private accountManager: AccountManager;
  private imapService: ImapService;
  private smtpService: SmtpService;
  private credentialBackend: CredentialBackend;
  private port: number;
  private httpServer?: Server;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private readonly onInterrupt = () => { void this.stop(); };
  // F2: one repair at a time — credential rotation serializes against other
  // repairs the same way the enrollment router serializes enrollments.
  private repairBusy = false;

  constructor(
    port: number = 3000,
    deps: { accountManager?: AccountManager; imapService?: ImapService; smtpService?: SmtpService; credentials?: CredentialBackend;
      runGmailOAuth?: typeof runGmailOAuthLoopback; openBrowser?: (url: string) => Promise<void> | void } = {},
  ) {
    this.app = express();
    this.port = port;
    const credentialBackend = deps.credentials ?? (process.platform === 'win32'
      ? new WindowsCredentialBackend()
      : new UnavailableCredentialBackend());
    this.credentialBackend = credentialBackend;
    const authResolver = new AccountAuthResolver(
      credentialBackend,
      createGmailAccessTokenExchange({ credentials: credentialBackend }),
    );
    this.accountManager = deps.accountManager ?? new AccountManager(credentialBackend);
    this.imapService = deps.imapService ?? new ImapService(authResolver);
    // F2: SMTP diagnostics reuse the same auth resolution and the T20
    // identity guards through the account manager wiring.
    this.smtpService = deps.smtpService ?? new SmtpService(authResolver);
    this.smtpService.setAccountManager(this.accountManager);

    this.setupMiddleware();
    this.app.use('/api', enrollmentRouter({
      accounts: this.accountManager,
      enrollment: new AccountEnrollmentService(credentialBackend, this.accountManager, account => this.imapService.authenticateOnly(account)),
      available: !!deps.credentials || process.platform === 'win32',
      runOAuth: deps.runGmailOAuth,
      openBrowser: deps.openBrowser || (async url => { await open(url); }),
    }));
    this.setupRoutes();
  }

  /** The configured Express application. Exposed for tests. */
  getApp(): express.Application {
    return this.app;
  }

  private setupMiddleware(): void {
    // The setup wizard must only be reachable by the local user's browser. Reject
    // any request whose Host is not a loopback name (blocks DNS-rebinding, where
    // a malicious site points its own domain at 127.0.0.1) and any cross-origin
    // browser request (Origin set to a non-loopback origin). Together with
    // stripAccountSecrets this closes the "any open page can read/modify the
    // local accounts API" vector.
    this.app.use('/api', (_req, res, next) => {
      res.setHeader('cache-control', 'no-store');
      next();
    });
    this.app.use(this.loopbackOnly());
    this.app.use((_req, res, next) => {
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      next();
    });
    this.app.use('/api', (req, res, next) => {
      const token=req.headers['x-mail-agent-session'];
      if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token)||!timingSafeEqual(Buffer.from(token),Buffer.from(this.sessionToken))) {
        res.status(403).json({error:'Forbidden: invalid setup session'});return;
      }
      if (this.httpServer) this.resetIdleTimer();
      next();
    });
    this.app.use(bodyParser.json({ limit: '32kb' }));
    this.app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (error) { res.status(400).json({ error: '请求格式无效或内容过大。' }); return; }
      next();
    });
    this.app.use(express.static(this.resolvePublicDir()));
  }

  getSetupUrl():string {return `http://localhost:${this.port}/#session=${this.sessionToken}`;}

  private static isLoopbackName(name: string): boolean {
    const n = name.toLowerCase();
    return n === 'localhost' || n === '127.0.0.1' || n === '::1';
  }

  // Guard: allow only loopback Host + (when present) loopback Origin. Non-browser
  // clients (curl, tests) send no Origin and are allowed if the Host is loopback.
  private loopbackOnly(): express.RequestHandler {
    const hostname = (hostHeader: string): string =>
      hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');

    return (req, res, next) => {
      const host = req.headers.host;
      if (!host || !WebUIServer.isLoopbackName(hostname(host))) {
        res.status(403).json({ error: 'Forbidden: the setup API is reachable on loopback only.' });
        return;
      }

      const origin = req.headers.origin;
      if (origin) {
        let originHost: string;
        try {
          originHost = new URL(origin).hostname;
        } catch {
          res.status(403).json({ error: 'Forbidden: invalid Origin.' });
          return;
        }
        if (!WebUIServer.isLoopbackName(originHost) || new URL(origin).origin !== new URL('http://' + host).origin) {
          res.status(403).json({ error: 'Forbidden: cross-origin requests are not allowed.' });
          return;
        }
      }

      const site=req.headers['sec-fetch-site'];
      if(site&&site!=='same-origin'&&site!=='none') {res.status(403).json({error:'Forbidden: cross-site setup access'});return;}

      next();
    };
  }

  // The bundled entrypoint may live at dist/web/server.js (npm run web) or be
  // inlined into dist/setup.js, so __dirname differs. Probe the likely
  // locations and fall back to the current working directory.
  private resolvePublicDir(): string {
    const candidates = [
      path.join(__dirname, '../../public'),
      path.join(__dirname, '../public'),
      path.join(process.cwd(), 'public'),
    ];
    const found = candidates.find(dir => fs.existsSync(path.join(dir, 'index.html')));
    return found ?? candidates[0];
  }

  private setupRoutes(): void {
    // Get all providers
    this.app.get('/api/providers', (req, res) => {
      res.json(emailProviders);
    });

    // Get all accounts
    this.app.get('/api/accounts', (req, res) => {
      try {
        const accounts = this.accountManager.getAllAccounts();
        // Never send credentials to the client — see stripAccountSecrets.
        res.json(accounts.map(stripAccountSecrets));
      } catch (error) {
        res.status(500).json({ error: 'Failed to fetch accounts' });
      }
    });

    // Add new account
    this.app.post('/api/accounts', async (req, res) => {
      try {
        const {
          name, email, password, host, port, tls, smtp, imapUsername, sentFolder, defaultBcc,
          imapUsernameFromEnv, imapPasswordFromEnv,
          smtpUsernameFromEnv, smtpPasswordFromEnv,
        } = req.body;

        // Auto-detect provider if not specified
        let imapHost = host;
        let imapPort = port;
        let useTls = tls;

        if (!host && email) {
          const provider = getProviderByEmail(email);
          if (provider) {
            imapHost = provider.imapHost;
            imapPort = provider.imapPort;
            useTls = provider.imapSecurity !== 'STARTTLS';
          }
        }

        // Credentials flagged as env-managed are stored as empty placeholders;
        // the corresponding IMAP_MCP_ACCOUNT_* env var supplies them at runtime.
        const account = await this.accountManager.addAccount({
          name: name || email,
          host: imapHost,
          port: imapPort || 993,
          user: imapUsernameFromEnv ? '' : (imapUsername || email),
          password: imapPasswordFromEnv ? '' : password,
          tls: useTls !== false,
          ...(imapUsername || imapUsernameFromEnv ? { email } : {}),
          smtp: smtp
            ? {
                ...smtp,
                ...(smtpUsernameFromEnv ? { user: '' } : {}),
                ...(smtpPasswordFromEnv ? { password: '' } : {}),
              }
            : undefined,
          ...(typeof sentFolder === 'string' && sentFolder ? { sentFolder } : {}),
          ...(defaultBcc !== undefined && defaultBcc !== '' && !(Array.isArray(defaultBcc) && defaultBcc.length === 0)
            ? { defaultBcc }
            : {}),
        });

        // addAccount returns the plaintext password back; never echo it.
        res.json({ success: true, account: stripAccountSecrets(account) });
      } catch (error) {
        res.status(400).json({ 
          success: false, 
          error: error instanceof Error ? error.message : 'Failed to add account' 
        });
      }
    });

    // Test connection
    this.app.post('/api/test-connection', async (req, res) => {
      try {
        const { email, password, host, port, tls, imapUsername } = req.body;

        // Create temporary account for testing
        const testAccount: ImapAccount = {
          id: 'test-' + randomUUID(),
          name: 'Test',
          host: host || 'imap.gmail.com',
          port: port || 993,
          user: imapUsername || email,
          password,
          tls: tls !== false,
        };
        
        // Try to connect
        await this.imapService.connect(testAccount);

        // Owner cleanup (T18 / BUG-SEC-A1): the temp connection is owned by
        // this endpoint — a failing folder LIST must still disconnect it, or
        // the synthetic test-<id> connection leaks in the service map.
        let listFailure:unknown;
        try {
          const folders = await this.imapService.listFolders(testAccount.id);
          res.json({
            success: true,
            folders: folders.map(f => f.name)
          });
        } catch(error) {
          listFailure=error;
          throw error;
        } finally {
          try{await this.imapService.disconnect(testAccount.id);}catch(error){if(listFailure===undefined)throw error;}
        }
      } catch (error) {
        res.status(400).json({ 
          success: false, 
          error: error instanceof Error ? error.message : 'Connection test failed' 
        });
      }
    });

    // Browser-only removal: bind explicit confirmation to the displayed identity.
    this.app.delete('/api/accounts/:id', async (req, res) => {
      const confirmation = z.object({ confirmed: z.literal(true), name: z.string().max(320), email: z.string().max(320) }).strict().safeParse(req.body);
      if (!confirmation.success) { res.status(400).json({ success: false, error: '请在浏览器中确认要移除的邮箱。' }); return; }
      try {
        const remove = async () => {
          const account = this.accountManager.getAccount(req.params.id);
          if (!account) return { status: 404, error: '该邮箱连接不存在，请刷新账号列表。' };
          if (account.name !== confirmation.data.name || (account.email || account.user) !== confirmation.data.email) {
            return { status: 409, error: '账号信息已变化，请刷新列表后重新确认。' };
          }
          await this.accountManager.removeAccount(account.id);
          return { status: 200 };
        };
        const result = this.accountManager.withStoreTransaction
          ? await this.accountManager.withStoreTransaction(remove) : await remove();
        if (result.status !== 200) { res.status(result.status).json({ success: false, error: result.error }); return; }
        this.imapService.abortConnection(req.params.id);
        res.json({ success: true });
      } catch {
        res.status(400).json({ 
          success: false, 
          error: '移除失败。请确认系统凭据库可用，且没有其他账号配置进程正在运行；原有配置会尽可能回滚。'
        });
      }
    });

    // Update account
    this.app.put('/api/accounts/:id', async (req, res) => {
      try {
        const {
          name, email, password, host, port, tls, smtp, saveToSent, imapUsername, sentFolder, defaultBcc,
          imapUsernameFromEnv, imapPasswordFromEnv,
          smtpUsernameFromEnv, smtpPasswordFromEnv,
        } = req.body;

        const updates: any = {};
        if (name !== undefined) updates.name = name;
        // Env-managed username → store an empty placeholder for it.
        if (imapUsernameFromEnv) {
          updates.user = '';
          if (email !== undefined) updates.email = email;
        } else if (imapUsername) {
          updates.user = imapUsername;
          if (email !== undefined) updates.email = email;
        } else if (email !== undefined) {
          updates.user = email;
          updates.email = undefined;
        }
        // Env-managed password → empty placeholder; otherwise only update when sent.
        if (imapPasswordFromEnv) {
          updates.password = '';
        } else if (password !== undefined) {
          updates.password = password;
        }
        if (host !== undefined) updates.host = host;
        if (port !== undefined) updates.port = port;
        if (tls !== undefined) updates.tls = tls;
        if (smtp !== undefined) {
          updates.smtp = {
            ...smtp,
            ...(smtpUsernameFromEnv ? { user: '' } : {}),
            ...(smtpPasswordFromEnv ? { password: '' } : {}),
          };
        }
        if (saveToSent !== undefined) updates.saveToSent = saveToSent;
        // Empty string clears the override (falls back to auto-detection).
        if (typeof sentFolder === 'string') updates.sentFolder = sentFolder === '' ? undefined : sentFolder;
        if (defaultBcc !== undefined) {
          if (defaultBcc === '' || (Array.isArray(defaultBcc) && defaultBcc.length === 0)) {
            updates.defaultBcc = undefined;
          } else {
            updates.defaultBcc = defaultBcc;
          }
        }

        // updateAccount returns a DECRYPTED account (plaintext IMAP + SMTP
        // passwords). A no-op update (e.g. a rename with no password supplied)
        // would otherwise hand every stored secret back over the wire — strip.
        const account = await this.accountManager.updateAccount(req.params.id, updates);
        res.json({ success: true, account: stripAccountSecrets(account) });
      } catch (error) {
        res.status(400).json({ 
          success: false, 
          error: error instanceof Error ? error.message : 'Failed to update account' 
        });
      }
    });

    // Get single account
    this.app.get('/api/accounts/:id', async (req, res) => {
      try {
        const account = this.accountManager.getAccount(req.params.id);
        if (!account) {
          res.status(404).json({ success: false, error: 'Account not found' });
        } else {
          // Don't send passwords to client — see stripAccountSecrets.
          res.json({ success: true, account: stripAccountSecrets(account) });
        }
      } catch (error) {
        res.status(400).json({ 
          success: false, 
          error: error instanceof Error ? error.message : 'Failed to get account' 
        });
      }
    });

    // Test existing account connection (without re-entering password)
    this.app.post('/api/accounts/:id/test', async (req, res) => {
      try {
        const account = this.accountManager.getAccount(req.params.id);
        if (!account) {
          res.status(404).json({ success: false, error: 'Account not found' });
          return;
        }

        const result = await this.imapService.testConnection(account);

        res.json({
          success: result.success,
          accountId: account.id,
          accountName: account.name,
          host: account.host,
          folders: result.folders,
          messageCount: result.messageCount,
          error: result.error,
        });
      } catch (error) {
        res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : 'Test failed',
        });
      }
    });

    // F2: per-account diagnostics — IMAP, SMTP, proxy and authorization
    // status with the failing stage and an actionable next step. The
    // response carries no credentials: fixed guidance text plus a sanitized
    // error excerpt at most.
    this.app.get('/api/accounts/:id/diagnostics', async (req, res) => {
      const account = this.accountManager.getAccount(req.params.id);
      if (!account) {
        res.status(404).json({ success: false, error: 'Account not found' });
        return;
      }
      const auth = account.auth;
      const authKind = auth?.provider === 'gmail' ? 'oauth' : auth ? 'vault' : account.password ? 'password' : 'missing';
      const diagnostics: Record<string, unknown> = {
        success: true,
        accountId: account.id,
        accountName: account.name,
        host: account.host,
        checkedAt: new Date().toISOString(),
        auth: {
          kind: authKind,
          ...(auth?.provider ? { provider: auth.provider } : {}),
          ...(auth?.credentialTarget ? { credentialTarget: auth.credentialTarget } : {}),
        },
        proxy: proxyDiagnostics(account),
      };

      let imapStage: string | undefined;
      try {
        const result = await this.imapService.testConnection(account);
        if (result.success) {
          diagnostics.imap = { status: 'ok', ...(result.folders ? { folders: result.folders.length } : {}), ...(result.messageCount !== undefined ? { messageCount: result.messageCount } : {}) };
        } else {
          imapStage = classifyConnectionStage(result.error ?? '');
          diagnostics.imap = { status: 'failed', stage: imapStage, ...(result.error ? { detail: sanitizeDetail(result.error) } : {}) };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        imapStage = classifyConnectionStage(message);
        diagnostics.imap = { status: 'failed', stage: imapStage, detail: sanitizeDetail(message) };
      }

      // P2: reuse the send service's effective config resolution — a valid
      // account without an explicit smtp block still has a derivable
      // endpoint, so diagnostics verify it instead of reporting not_configured.
      const effectiveSmtp = this.smtpService.resolveEffectiveSmtpConfig(account);
      const smtpEndpoint = { host: effectiveSmtp.host, port: effectiveSmtp.port };
      let smtpStage: string | undefined;
      try {
        const verification = await this.smtpService.verifySmtpConnectionDetailed(account);
        if (verification.ok) {
          diagnostics.smtp = { status: 'ok', ...smtpEndpoint, ...(account.smtp ? {} : { derived: true }) };
        } else {
          // R3: classify the REAL verification failure — connect/auth/tls/proxy.
          const failure = verification.error ?? '';
          smtpStage = classifyConnectionStage(failure);
          diagnostics.smtp = { status: 'failed', stage: smtpStage, ...smtpEndpoint, ...(account.smtp ? {} : { derived: true }), ...(failure ? { detail: sanitizeDetail(failure) } : {}) };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        smtpStage = classifyConnectionStage(message);
        diagnostics.smtp = { status: 'failed', stage: smtpStage, ...smtpEndpoint, ...(account.smtp ? {} : { derived: true }), ...(message ? { detail: sanitizeDetail(message) } : {}) };
      }

      diagnostics.nextSteps = diagnosticsNextSteps({
        authKind,
        imap: diagnostics.imap as { status: string; stage?: string },
        smtp: diagnostics.smtp as { status: string; stage?: string },
        proxy: diagnostics.proxy as { applied: boolean; source?: string },
      });
      res.json(diagnostics);
    });

    // F2: repair entry for password/vault accounts, carrying the CLI's T17
    // transaction semantics (review P1): the vault write and rollback run
    // under the cross-process account-store lock, the identity gate pins
    // the account revision at the write boundary, a failed restore is
    // reported as an inconsistent state instead of "restored", and a
    // commit whose verification targeted an older identity is rejected.
    // Gmail re-authorization stays a separate capability (CLI).
    this.app.post('/api/accounts/:id/repair', async (req, res) => {
      const input = z.object({ authorizationCode: z.string().trim().min(1).max(4096) }).strict().safeParse(req.body);
      if (!input.success) {
        res.status(400).json({ success: false, error: '请提供新的客户端授权码。' });
        return;
      }
      if (this.repairBusy) {
        res.status(409).json({ success: false, error: '另一个账号正在修复，请完成后再试。' });
        return;
      }
      const account = this.accountManager.getAccount(req.params.id);
      if (!account) {
        res.status(404).json({ success: false, error: 'Account not found' });
        return;
      }
      if (account.auth?.provider === 'gmail') {
        res.status(400).json({ success: false, error: 'Gmail 账号请使用 mail-agent-enroll gmail-repair 重新授权；本页修复入口适用于授权码登录的邮箱。' });
        return;
      }
      this.repairBusy = true;
      try {
        // P2: pin the identity the verification targets — an account edit
        // landing during the authenticate await must not inherit the
        // verified secret (the commit re-checks this revision).
        const expectedRevision = accountRevision(account);
        const candidate = { ...account, password: input.data.authorizationCode };
        const credentialTarget = account.auth?.credentialTarget;
        if (credentialTarget) {
          // T17 pre-check outside the transaction: a removal or identity
          // change before the rotation is not a rollback scenario.
          const recheck = this.accountManager.getAccount(account.id);
          if (!recheck || recheck.auth?.credentialTarget !== credentialTarget) {
            throw new CredentialGateRejection('账号在修复开始前被移除或凭据目标变化');
          }
          if (accountRevision(recheck) !== expectedRevision) {
            throw new CredentialGateRejection('账号身份在修复开始前变化');
          }
          await rotateCredential({
            credentials: this.credentialBackend,
            target: credentialTarget,
            expectedTarget: credentialTarget,
            replacement: input.data.authorizationCode,
            verify: async () => {
              await this.imapService.authenticateOnly(candidate);
              // R1: ownership is decided by the transaction (generation
              // journal + gate), never by value-matching cleanup — a
              // remove+re-add with the same authorization code owns its
              // credential, and an older repair deleting "its" value would
              // destroy the newer account's valid secret. The gate alone
              // leaves whatever the newer operation wrote untouched.
              const live = this.accountManager.getAccount(account.id);
              if (!live || live.auth?.credentialTarget !== credentialTarget) {
                throw new CredentialGateRejection('账号在验证期间被移除；凭据保持当前状态');
              }
              if (accountRevision(live) !== expectedRevision) {
                throw new StaleIdentityError('账号身份在验证期间变化');
              }
            },
            // P1: exclusive guard around the identity re-check, the vault
            // write AND the rollback — same as the CLI repair.
            writeGuard: (action: () => Promise<void>) => withAccountStoreLock(accountStoreDirectory(), action),
            reverify: async () => {
              // Write/rollback boundary: gate only on removal — an existing
              // account metadata edit must still let the rollback undo
              // our write so the stale repair never overwrites new state.
              const live = this.accountManager.getAccount(account.id);
              if (!live || live.auth?.credentialTarget !== credentialTarget) {
                throw new CredentialGateRejection('账号在修复期间被移除；保留删除状态');
              }
            },
          });
          // R1: the rotation may complete after a concurrent remove+re-add —
          // the vault then holds whatever the newer operation wrote. Report
          // the situation instead of claiming a repair of a gone account.
          const postCheck = this.accountManager.getAccount(account.id);
          if (!postCheck || postCheck.auth?.credentialTarget !== credentialTarget) {
            res.status(409).json({ success: false, error: "账号在修复期间被移除或重建，凭据保持当前状态（本次修复未改动它）。" });
            return;
          }
          res.json({ success: true, accountId: account.id });
          return;
        }
        // Local-encrypted account: verify the login BEFORE the update so a
        // failing credential writes nothing (T16 shape).
        await this.imapService.authenticateOnly(candidate);
        // P2 stale-commit gate: the verified secret belongs to the pinned
        // identity; a concurrent edit (host/user change) must re-repair.
        const live = this.accountManager.getAccount(account.id);
        if (!live) {
          throw new CredentialGateRejection('账号在验证期间被移除');
        }
        if (accountRevision(live) !== expectedRevision) {
          throw new CredentialGateRejection('账号身份在验证期间变化；请基于新身份重新修复');
        }
        // P2 SMTP consistency: when SMTP shares the IMAP identity (its
        // stored secret equals the IMAP one, as the setup form writes it),
        // rotate both — the SMTP resolver would otherwise keep answering
        // with the retired code. Independently configured SMTP secrets
        // keep their existing binding.
        // R2b: the SMTP linkage decision moved INSIDE the transaction —
        // the live record (post-gate) decides whether smtp.password is
        // shared with the IMAP secret, so a concurrent smtp-only change
        // between the snapshot and the commit is never overwritten.
        const updated = await this.accountManager.updateAccount(account.id, { password: input.data.authorizationCode }, { expectedRevision, rotateSharedSmtpSecret: true });
        res.json({ success: true, accountId: account.id, account: stripAccountSecrets(updated) });
      } catch (error) {
        if (error instanceof CredentialRollbackError) {
          // P2 honesty: the restore failed — the backend may hold neither
          // the old nor the new secret. Never claim "restored".
          res.status(500).json({
            success: false,
            outcomeUnknown: true,
            error: '凭据验证失败且旧凭据恢复失败：凭据库当前状态可能不一致。请核对凭据库中的实际值，并重新执行修复。',
          });
          return;
        }
        if (error instanceof AccountRevisionMismatchError || (error as { name?: string }).name === 'AccountRevisionMismatchError') {
          // R2: the transactional gate rejected a stale commit — nothing was
          // written; the caller must re-repair against the new identity.
          res.status(409).json({ success: false, error: '账号身份在验证期间变化，已拒绝本次提交（未写入任何内容）；请基于新身份重新修复。' });
          return;
        }
        if (error instanceof StaleIdentityError) {
          // The rollback already restored the previous secret.
          res.status(409).json({ success: false, error: '账号身份在验证期间变化，已恢复原凭据；请基于新身份重新修复。' });
          return;
        }
        if (error instanceof CredentialGateRejection) {
          res.status(409).json({ success: false, error: '账号在修复期间被移除或身份变化，凭据未更新。' });
          return;
        }
        res.status(400).json({ success: false, error: '凭据验证失败，原凭据保持不变。请确认已在邮箱设置中开启 IMAP 且授权码正确后再试。' });
      } finally {
        this.repairBusy = false;
      }
    });

    // Health check
    this.app.get('/api/health', (req, res) => {
      // B6: report the version of the installed package (module-relative
      // manifest read) instead of a hardcoded string that drifts from
      // package.json on release.
      res.json({ status: 'ok', version: resolvePackageVersion(import.meta.url) });
    });
  }

  private resetIdleTimer(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { void this.stop(); }, 15 * 60_000);
    this.idleTimer.unref();
  }

  async stop(): Promise<void> {
    clearTimeout(this.idleTimer);
    const server = this.httpServer;
    this.httpServer = undefined;
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    process.removeListener('SIGINT', this.onInterrupt);
  }

  async start(autoOpen: boolean = true): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = this.app.listen(this.port, '127.0.0.1', () => {
        const address = this.httpServer?.address();
        if (address && typeof address !== 'string') this.port = address.port;
        console.log(`🌐 Open this private local setup session: ${this.getSetupUrl()}`);
        this.resetIdleTimer();
        
        if (autoOpen) {
          // Open browser after a short delay
          setTimeout(() => {
            void open(this.getSetupUrl()).catch(() => console.error('Could not open the default browser. Open the private setup URL manually.'));
          }, 1000);
        }
        
        resolve();
      });
      this.httpServer = server;
      server.on('error', reject);

      // Handle graceful shutdown
      process.once('SIGINT', this.onInterrupt);
    });
  }
}

// CLI entry point
// pathToFileURL, not `file://${argv[1]}`: on Windows the latter yields
// "file://C:\...\server.ts" while import.meta.url is "file:///C:/.../server.ts",
// so the two could never match and `npm run web` exited silently (#136).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = parseInt(process.env.PORT || '3000');
  const server = new WebUIServer(port);
  server.start();
}
