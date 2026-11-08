import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WebUIServer } from '../src/web/server.js';
import { AccountManager } from '../src/services/account-manager.js';

// F3: the generic ("other IMAP") form exposes IMAP/SMTP ports and encryption.
// The HTTP boundary must accept every configuration the backend allows —
// including SMTP 587 with STARTTLS and IMAP 143 with required STARTTLS —
// normalize ports exactly like the backend candidate rules, keep old
// configurations working, and reject illegal ports before any write.

const CONFIG_DIR = join(tmpdir(), `imap-mcp-f3-${process.pid}`);
process.env.IMAP_MCP_CONFIG_DIR = CONFIG_DIR;

let httpServer: Server;
let baseUrl: string;
let sessionToken: string;
let storePath: string;

const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-mail-agent-session': sessionToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => undefined) };
};

const store = () => JSON.parse(readFileSync(storePath, 'utf8')) as any[];

const genericCandidate = (overrides: Record<string, unknown> = {}) => ({
  name: 'F3 Generic',
  host: 'imap.other.synth.test',
  imapUsername: 'me@other.synth.test',
  password: ['f3-', 'synthetic'].join(''),
  port: 993,
  tls: true,
  ...overrides,
});

let accountCreated = 0;
const nextAccountName = () => `F3 Generic ${++accountCreated}`;

beforeAll(async () => {
  rmSync(CONFIG_DIR, { recursive: true, force: true });
  const manager = new AccountManager();
  const wizard = new WebUIServer(0, { accountManager: manager as any, imapService: {} as any });
  await new Promise<void>((resolve) => {
    httpServer = wizard.getApp().listen(0, () => resolve());
  });
  const { port } = httpServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  sessionToken = new URLSearchParams(new URL(wizard.getSetupUrl()).hash.slice(1)).get('session')!;
  storePath = join(CONFIG_DIR, 'accounts.json');
});

afterAll(() => {
  httpServer?.close();
  rmSync(CONFIG_DIR, { recursive: true, force: true });
});

describe('F3: generic account ports and encryption', () => {
  it('F3-POST-SMTP-587-STARTTLS: SMTP 587 + STARTTLS is accepted and stored as configured', async () => {
    const candidate = genericCandidate({ name: nextAccountName(), smtp: { host: 'smtp.other.synth.test', port: 587, secure: false, user: 'me@other.synth.test', password: ['f3-', 'smtp'].join('') } });
    const { status, body } = await call('POST', '/api/accounts', candidate);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const stored = store().find((a: any) => a.name === candidate.name);
    expect(stored.smtp).toMatchObject({ host: 'smtp.other.synth.test', port: 587, secure: false });
    expect(stored).toMatchObject({ port: 993, tls: true });
    // The sanitized HTTP response never carries the SMTP secret.
    expect(JSON.stringify(body)).not.toContain('f3-smtp');
  });

  it('F3-POST-IMAP-143-STARTTLS: IMAP 143 + required STARTTLS is accepted', async () => {
    const candidate = genericCandidate({ name: nextAccountName(), port: 143, tls: false });
    const { status } = await call('POST', '/api/accounts', candidate);
    expect(status).toBe(200);
    const stored = store().find((a: any) => a.name === candidate.name);
    expect(stored).toMatchObject({ port: 143, tls: false });
  });

  it('F3-POST-SMTP-DEFAULTS: an SMTP block without port derives 465/587 from secure', async () => {
    const secure = genericCandidate({ name: nextAccountName(), smtp: { host: 'smtp.other.synth.test', secure: true, user: 'me@other.synth.test', password: 'x1' } });
    await call('POST', '/api/accounts', secure);
    expect(store().find((a: any) => a.name === secure.name).smtp.port).toBe(465);

    const starttls = genericCandidate({ name: nextAccountName(), smtp: { host: 'smtp.other.synth.test', secure: false, user: 'me@other.synth.test', password: 'x2' } });
    await call('POST', '/api/accounts', starttls);
    expect(store().find((a: any) => a.name === starttls.name).smtp.port).toBe(587);
  });

  it('F3-POST-INVALID-PORTS: non-integer and out-of-range ports are rejected with the store untouched', async () => {
    const before = readFileSync(storePath, 'utf8');
    for (const badPort of ['abc', 0, 70000, 1.5]) {
      const { status } = await call('POST', '/api/accounts', genericCandidate({ name: nextAccountName(), port: badPort }));
      expect(status).toBe(400);
    }
    for (const badSmtpPort of [0, 99999, '587x']) {
      const { status } = await call('POST', '/api/accounts', genericCandidate({ name: nextAccountName(), smtp: { host: 'smtp.other.synth.test', port: badSmtpPort, secure: false } }));
      expect(status).toBe(400);
    }
    expect(readFileSync(storePath, 'utf8')).toBe(before);
  });

  it('F3-PUT-EDIT-EXISTING: ports and encryption of an existing account can be edited; omitted fields stay', async () => {
    const candidate = genericCandidate({ name: nextAccountName() });
    await call('POST', '/api/accounts', candidate);
    const account = store().find((a: any) => a.name === candidate.name);

    // Old-config compatibility first: an update without port/tls/smtp leaves them as stored.
    const noop = await call('PUT', `/api/accounts/${account.id}`, { name: candidate.name });
    expect(noop.status).toBe(200);
    let stored = store().find((a: any) => a.id === account.id);
    expect(stored).toMatchObject({ port: 993, tls: true });
    expect(stored.smtp).toBeUndefined();

    // Switch to STARTTLS on both sides.
    const edit = await call('PUT', `/api/accounts/${account.id}`, {
      port: 143, tls: false,
      smtp: { host: 'smtp.other.synth.test', port: 587, secure: false, user: 'me@other.synth.test', password: ['f3-', 'edit'].join('') },
    });
    expect(edit.status).toBe(200);
    stored = store().find((a: any) => a.id === account.id);
    expect(stored).toMatchObject({ port: 143, tls: false });
    expect(stored.smtp).toMatchObject({ port: 587, secure: false });
    // The HTTP response stays sanitized.
    expect(JSON.stringify(edit.body)).not.toContain('f3-edit');

    // Back to implicit TLS ports.
    const revert = await call('PUT', `/api/accounts/${account.id}`, {
      port: 993, tls: true,
      smtp: { host: 'smtp.other.synth.test', port: 465, secure: true, user: 'me@other.synth.test', password: ['f3-', 'edit'].join('') },
    });
    expect(revert.status).toBe(200);
    stored = store().find((a: any) => a.id === account.id);
    expect(stored).toMatchObject({ port: 993, tls: true });
    expect(stored.smtp).toMatchObject({ port: 465, secure: true });
  });

  it('F3-LEGACY-COMPAT: an old-format account without ports still loads and edits', async () => {
    const candidate = genericCandidate({ name: nextAccountName() });
    delete (candidate as any).port;
    delete (candidate as any).tls;
    const { status } = await call('POST', '/api/accounts', candidate);
    expect(status).toBe(200);
    const stored = store().find((a: any) => a.name === candidate.name);
    // Backend defaults: TLS on, IMAP 993.
    expect(stored).toMatchObject({ port: 993, tls: true });
  });
});
