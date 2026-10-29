import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { WebUIServer } from '../src/web/server.js';

// getAllAccounts() returns DECRYPTED credentials by design (the manager's job).
// The wizard's HTTP API is unauthenticated and CORS-open, so the API layer must
// never let those credentials cross the wire. Inject a fake manager holding
// obvious secrets and assert the /api/accounts response is scrubbed.
const SECRET = 'imap-plaintext-secret';
const SMTP_SECRET = 'smtp-plaintext-secret';

const fakeAccountManager = {
  getAllAccounts: () => [
    {
      id: 'a1',
      name: 'Work',
      host: 'imap.example.com',
      port: 993,
      user: 'user@example.com',
      password: SECRET,
      tls: true,
      smtp: { host: 'smtp.example.com', port: 587, secure: false, password: SMTP_SECRET },
    },
  ],
  getAccount: (id: string) =>
    id === 'a1'
      ? {
          id: 'a1',
          name: 'Work',
          host: 'imap.example.com',
          port: 993,
          user: 'user@example.com',
          password: SECRET,
          tls: true,
          smtp: { host: 'smtp.example.com', port: 587, secure: false, password: SMTP_SECRET },
        }
      : undefined,
};

// T18 / BUG-SEC-A1: the temp connection the setup API opens for a connection
// test is owned by the endpoint — a failing folder LIST must still disconnect
// it, otherwise the synthetic test-<id> connection leaks in the service map.
const imapMock = {
  connect: vi.fn(async () => undefined),
  listFolders: vi.fn(async () => { throw new Error('LIST failed'); }),
  disconnect: vi.fn(async () => undefined),
};

let httpServer: Server;
let baseUrl: string;
let sessionToken: string;

beforeAll(async () => {
  const wizard = new WebUIServer(0, {
    accountManager: fakeAccountManager as any,
    imapService: imapMock as any,
  });
  await new Promise<void>((resolve) => {
    httpServer = wizard.getApp().listen(0, () => resolve());
  });
  const { port } = httpServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  sessionToken=new URLSearchParams(new URL(wizard.getSetupUrl()).hash.slice(1)).get('session')!;
});

afterAll(() => {
  httpServer?.close();
});

describe('Web wizard credential exposure', () => {
  it('GET /api/accounts never returns passwords', async () => {
    const res = await fetch(`${baseUrl}/api/accounts`,{headers:{'x-mail-agent-session':sessionToken}});
    expect(res.ok).toBe(true);
    const raw = await res.text();

    // Belt: the plaintext secrets must not appear anywhere in the payload.
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain(SMTP_SECRET);

    // Braces: the fields must be absent, and the rest of the account intact.
    const accounts = JSON.parse(raw);
    expect(Array.isArray(accounts)).toBe(true);
    expect(accounts[0].password).toBeUndefined();
    expect(accounts[0].smtp?.password).toBeUndefined();
    expect(accounts[0].user).toBe('user@example.com');
    expect(accounts[0].smtp?.host).toBe('smtp.example.com');
  });

  it('GET /api/accounts/:id also stays password-free', async () => {
    const res = await fetch(`${baseUrl}/api/accounts/a1`,{headers:{'x-mail-agent-session':sessionToken}});
    const raw = await res.text();
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain(SMTP_SECRET);
    const body = JSON.parse(raw);
    expect(body.account.password).toBeUndefined();
    expect(body.account.smtp?.password).toBeUndefined();
  });
});

describe('T18: setup API temp connection cleanup', () => {
  it('T18-WEB-LIST-FAIL-CLEANUP: a failing LIST still disconnects the temp connection', async () => {
    imapMock.disconnect.mockClear();
    const res = await fetch(`${baseUrl}/api/test-connection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mail-agent-session': sessionToken },
      body: JSON.stringify({ email: 'user@synth.test', password: 'unused', host: 'imap.synth.test', port: 993, tls: true }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/LIST failed/);
    expect(imapMock.connect).toHaveBeenCalledWith(expect.objectContaining({ id: expect.stringMatching(/^test-/) }));
    expect(imapMock.disconnect).toHaveBeenCalledWith(expect.stringMatching(/^test-/));
  });
});
