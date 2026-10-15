import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { AccountManager } from '../src/services/account-manager.js';
import { AccountEnrollmentService } from '../src/credentials/account-enrollment.js';
import { WebUIServer } from '../src/web/server.js';
let server: Server;
let root: string;
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  if (root) await rm(root, { recursive: true, force: true });
});
async function setup() {
  root = await mkdtemp(join(tmpdir(), 'browser-removal-fixture-'));
  const values = new Map<string, string>();
  const credentials = {
    read: (target: string) => values.has(target) ? { read: () => values.get(target), dispose() {} } : undefined,
    write: (target: string, value: string) => { values.set(target, value); },
    delete: vi.fn((target: string) => values.delete(target)),
  };
  const previous = process.env.IMAP_MCP_CONFIG_DIR;
  process.env.IMAP_MCP_CONFIG_DIR = root;
  let accounts: AccountManager;
  try { accounts = new AccountManager(credentials); }
  finally { if (previous === undefined) delete process.env.IMAP_MCP_CONFIG_DIR; else process.env.IMAP_MCP_CONFIG_DIR = previous; }
  const enroll = new AccountEnrollmentService(credentials, accounts);
  const secret = ['synthetic', '-only'].join('');
  const gmail = await enroll.enrollGmail({ email: 'fixture@gmail.com', name: 'Gmail fixture', clientId: 'fixture.apps.googleusercontent.com', clientSecret: secret, refreshToken: secret });
  const qq = await enroll.enrollQq({ email: 'fixture@qq.com', name: 'QQ fixture', authorizationCode: secret });
  const imap = { abortConnection: vi.fn() };
  const wizard = new WebUIServer(0, { accountManager: accounts, credentials, imapService: imap as any });
  server = wizard.getApp().listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const token = new URL(wizard.getSetupUrl()).hash.slice('#session='.length);
  const request = (body?: unknown, session = token, id = gmail.id) => fetch(`${base}/api/accounts/${encodeURIComponent(id)}`, {
    method: 'DELETE', headers: { 'content-type': 'application/json', 'x-mail-agent-session': session },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const confirmation = { confirmed: true, name: gmail.name, email: gmail.email };
  return { accounts, values, credentials, gmail, qq, imap, request, confirmation, secret };
}
describe('browser-only account removal', () => {
  it.each([undefined, false, 'true', 1])('rejects missing or non-literal confirmation: %j', async confirmed => {
    const f = await setup();
    const response = await f.request(confirmed === undefined ? undefined : { ...f.confirmation, confirmed });
    expect(response.status).toBe(400);
    expect(f.accounts.getAccount(f.gmail.id)).toBeDefined();
    expect(f.credentials.delete).not.toHaveBeenCalled();
  });
  it('requires the private session and the exact account identity shown in the dialog', async () => {
    const f = await setup();
    expect((await f.request(f.confirmation, '')).status).toBe(403);
    expect((await f.request({ ...f.confirmation, email: 'different@gmail.com' })).status).toBe(409);
    expect((await f.request({ ...f.confirmation, name: 'stale name' })).status).toBe(409);
    expect((await f.request(f.confirmation, undefined, 'missing')).status).toBe(404);
    expect(f.credentials.delete).not.toHaveBeenCalled();
  });
  it('removes only the selected local account and its two OAuth vault entries without touching mail', async () => {
    const f = await setup();
    const response = await f.request(f.confirmation);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(f.secret);
    expect(f.accounts.getAccount(f.gmail.id)).toBeUndefined();
    expect(f.accounts.getAccount(f.qq.id)).toBeDefined();
    expect(f.values.size).toBe(1);
    expect(f.imap.abortConnection).toHaveBeenCalledWith(f.gmail.id);
    expect(f.credentials.delete).toHaveBeenCalledTimes(2);
  });
  it('preserves account and vault contents when credential cleanup fails', async () => {
    const f = await setup();
    f.credentials.delete.mockImplementationOnce(() => { throw new Error(f.secret); });
    const response = await f.request(f.confirmation);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(f.secret);
    expect(f.accounts.getAccount(f.gmail.id)).toBeDefined();
    expect(f.values.size).toBe(3);
    expect(f.imap.abortConnection).not.toHaveBeenCalled();
  });
});
