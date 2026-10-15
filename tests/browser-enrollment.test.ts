import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { WebUIServer } from '../src/web/server.js';
import { AccountEnrollmentService } from '../src/credentials/account-enrollment.js';
import type { CredentialBackend } from '../src/credentials/credential-backend.js';

const fixtureSecret = ['fixture', '-authorization'].join('');
function backend() {
  const values = new Map<string, string>();
  const store: CredentialBackend = {
    read: target => values.has(target) ? { read: () => values.get(target), dispose() {} } : undefined,
    write: (target, value) => { values.set(target, value); },
    delete: target => values.delete(target),
  };
  return { store, values };
}
let server: Server;
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
async function setup(extra: Record<string, unknown> = {}) {
  const credentials = backend();
  const accounts: any[] = [];
  const manager = { getAllAccounts: () => accounts, addAccount: vi.fn(async account => {
    const result = { ...account, id: 'fixture-account' }; accounts.push(result); return result;
  }) };
  const imap = { authenticateOnly: vi.fn(async () => {}) };
  const wizard = new WebUIServer(0, { accountManager: manager as any, imapService: imap as any,
    credentials: credentials.store, ...extra });
  server = wizard.getApp().listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const token = new URL(wizard.getSetupUrl()).hash.slice('#session='.length);
  const request = (url: string, body?: unknown, session = token) => fetch(base + url, {
    method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-mail-agent-session': session },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { ...credentials, manager, imap, request };
}
describe('browser provider enrollment', () => {
  it('chooses a real loopback port and closes its private listener cleanly', async () => {
    const wizard = new WebUIServer(0, { accountManager: { getAllAccounts: () => [] } as any, imapService: {} as any });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await wizard.start(false);
      const url = new URL(wizard.getSetupUrl());
      expect(Number(url.port)).toBeGreaterThan(0);
      const response = await fetch(url.origin);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(await response.text()).not.toContain('cdn.jsdelivr.net');
      await wizard.stop();
      await expect(fetch(url.origin)).rejects.toThrow();
    } finally { await wizard.stop(); output.mockRestore(); }
  });
  it('verifies a provider account and saves vault references without echoing its secret', async () => {
    const fixture = await setup();
    const response = await fixture.request('/api/enroll', { provider: '163', email: 'fixture@163.com', authorizationCode: fixtureSecret });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(fixtureSecret);
    expect(fixture.imap.authenticateOnly).toHaveBeenCalledOnce();
    expect(fixture.manager.addAccount).toHaveBeenCalledOnce();
    expect(fixture.manager.addAccount.mock.calls[0][0].password).toBe('');
    expect(fixture.manager.addAccount.mock.calls[0][0].host).toBe('imap.163.com');
  });
  it('rejects duplicate identities, malformed fields, missing sessions and unsafe providers before writing', async () => {
    const fixture = await setup();
    const body = { provider: 'qq', email: 'fixture@qq.com', authorizationCode: fixtureSecret };
    expect((await fixture.request('/api/enroll', body, '')).status).toBe(403);
    expect((await fixture.request('/api/enroll', { ...body, provider: 'unknown' })).status).toBe(400);
    expect((await fixture.request('/api/enroll', { ...body, email: 'bad:account' })).status).toBe(400);
    expect(fixture.values.size).toBe(0);
    expect((await fixture.request('/api/enroll', body)).status).toBe(200);
    expect((await fixture.request('/api/enroll', { ...body, name: 'another name' })).status).toBe(409);
    expect(fixture.manager.addAccount).toHaveBeenCalledOnce();
  });
  it('rolls back vault credentials when authentication fails, without exposing a provider error', async () => {
    const fixture = await setup({ imapService: { authenticateOnly: async () => { throw new Error(fixtureSecret); } } });
    const response = await fixture.request('/api/enroll', { provider: '126', email: 'fixture@126.com', authorizationCode: fixtureSecret });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(fixtureSecret);
    expect(fixture.values.size).toBe(0);
    expect(fixture.manager.addAccount).not.toHaveBeenCalled();
  });
  it('keeps Gmail pending until OAuth and verification finish, and blocks parallel enrollments', async () => {
    let complete!: (value: any) => void;
    const oauth = vi.fn(() => new Promise<any>(resolve => { complete = resolve; }));
    const fixture = await setup({ runGmailOAuth: oauth, openBrowser: vi.fn() });
    const response = await fixture.request('/api/enroll/gmail/start', {
      email: 'fixture@gmail.com', clientId: 'fixture.apps.googleusercontent.com', clientSecret: fixtureSecret,
    });
    expect(response.status).toBe(202);
    const job = await response.json();
    expect((await (await fixture.request(`/api/enroll/gmail/${job.id}`)).json()).status).toBe('pending');
    expect((await fixture.request('/api/enroll', { provider: 'qq', email: 'fixture@qq.com', authorizationCode: fixtureSecret })).status).toBe(409);
    expect(fixture.manager.addAccount).not.toHaveBeenCalled();
    complete({ refreshToken: fixtureSecret, redirectUri: 'http://127.0.0.1:12345/oauth2/callback' });
    await vi.waitFor(() => expect(fixture.manager.addAccount).toHaveBeenCalledOnce());
    const result = await (await fixture.request(`/api/enroll/gmail/${job.id}`)).json();
    expect(result.status).toBe('success');
    expect(JSON.stringify(result)).not.toContain(fixtureSecret);
    expect(fixture.imap.authenticateOnly).toHaveBeenCalledOnce();
  });
  it('restores a prior vault value on verification failure', async () => {
    const fixture = backend();
    const target = 'MailAgentMCP:qq:fixture@qq.com:authorization_code';
    fixture.values.set(target, 'previous fixture');
    const addAccount = vi.fn();
    const enrollment = new AccountEnrollmentService(fixture.store, { addAccount }, async () => { throw new Error('fixture failure'); });
    await expect(enrollment.enrollQq({ email: 'fixture@qq.com', name: 'fixture', authorizationCode: fixtureSecret })).rejects.toThrow('fixture failure');
    expect(fixture.values.get(target)).toBe('previous fixture');
    expect(addAccount).not.toHaveBeenCalled();
  });
});
