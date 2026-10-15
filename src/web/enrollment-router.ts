import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AccountManager } from '../services/account-manager.js';
import type { AccountEnrollmentService } from '../credentials/account-enrollment.js';
import { runGmailOAuthLoopback } from '../credentials/gmail-oauth-loopback.js';

const identity = z.object({
  email: z.string().trim().toLowerCase().max(320).email().refine(value => !/[:\x00-\x1f\x7f]/.test(value)),
  name: z.string().trim().min(1).max(80).optional(),
});
const providerInput = identity.extend({
  provider: z.enum(['qq', '163', '126', 'yeah', 'netease-enterprise']),
  authorizationCode: z.string().trim().min(1).max(4096),
}).strict();
const gmailInput = identity.extend({
  clientId: z.string().trim().min(1).max(512).regex(/^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/),
  clientSecret: z.string().trim().min(1).max(4096),
}).strict();
type Job = { id: string; status: 'pending' | 'success' | 'error'; message: string; expires: number };

/** All routes inherit the parent server's session and exact-origin protection. */
export function enrollmentRouter(deps: {
  accounts: AccountManager;
  enrollment: AccountEnrollmentService;
  available: boolean;
  runOAuth?: typeof runGmailOAuthLoopback;
  openBrowser: (url: string) => Promise<void> | void;
}): Router {
  const router = Router();
  let busy = false;
  const jobs = new Map<string, Job>();
  const prune = () => {
    for (const [id, job] of jobs) if (job.expires < Date.now()) jobs.delete(id);
    while (jobs.size >= 20) jobs.delete(jobs.keys().next().value!);
  };
  const reserve = (email: string, name: string): string | undefined => {
    if (!deps.available) return '此系统暂不支持安全凭据库注册，请在 Windows 上配置。';
    if (busy) return '另一个账号正在验证或授权，请完成后再添加。';
    if (deps.accounts.getAllAccounts().some(account => account.name.toLowerCase() === name.toLowerCase()
      || (account.email || account.user).toLowerCase() === email)) return '该邮箱或账号名称已存在，请勿重复添加。';
    busy = true;
    return undefined;
  };
  // Only fixed messages cross the HTTP boundary; provider errors may contain secrets.
  const failure = (gmail = false) => gmail
    ? 'Gmail 授权或登录验证失败。请检查桌面应用 OAuth 配置、所选账号及代理，再重试。'
    : '邮箱登录验证或保存失败。请确认已开启 IMAP、授权码正确，且没有其他配置进程正在运行。';

  router.get('/setup-info', (_req, res) => res.json({ secureEnrollmentAvailable: deps.available }));
  router.post('/enroll', async (req, res) => {
    const input = providerInput.safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: '请填写有效的邮箱、名称和客户端授权码。' }); return; }
    const name = input.data.name || input.data.email;
    const error = reserve(input.data.email, name);
    if (error) { res.status(409).json({ error }); return; }
    try {
      const data = { ...input.data, name };
      const account = data.provider === 'qq' ? await deps.enrollment.enrollQq(data) : await deps.enrollment.enrollNetease({ ...data, provider: data.provider });
      res.json({ success: true, account: { id: account.id, name: account.name, email: account.email || account.user } });
    } catch { res.status(400).json({ error: failure() }); }
    finally { busy = false; }
  });
  router.post('/enroll/gmail/start', (req, res) => {
    const input = gmailInput.safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: '请提供有效邮箱及 Google OAuth 桌面应用配置。' }); return; }
    const name = input.data.name || input.data.email;
    const error = reserve(input.data.email, name);
    if (error) { res.status(409).json({ error }); return; }
    prune();
    const job: Job = { id: randomUUID(), status: 'pending', message: '请在 Google 页面完成授权，然后返回此页等待验证。', expires: Date.now() + 10 * 60_000 };
    jobs.set(job.id, job);
    res.status(202).json({ id: job.id });
    void (async () => {
      try {
        const tokens = await (deps.runOAuth || runGmailOAuthLoopback)({
          clientId: input.data.clientId, clientSecret: input.data.clientSecret,
          loginHint: input.data.email, openBrowser: deps.openBrowser,
        });
        await deps.enrollment.enrollGmail({ ...input.data, name, refreshToken: tokens.refreshToken });
        job.status = 'success'; job.message = '邮箱已验证并添加。';
      } catch { job.status = 'error'; job.message = failure(true); }
      finally { busy = false; }
    })();
  });
  router.get('/enroll/gmail/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.expires < Date.now()) { res.status(404).json({ error: '授权会话已过期，请重新打开配置入口。' }); return; }
    res.json({ id: job.id, status: job.status, message: job.message });
  });
  return router;
}
