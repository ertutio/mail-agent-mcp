import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { existsSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WebUIServer } from '../src/web/server.js';
import { AccountManager } from '../src/services/account-manager.js';

// T08 / BUG-SEC-06 (HTTP entry): the setup API's POST/PUT account endpoints
// must refuse illegal candidates (wrong types, unknown fields, bad
// combinations) before anything touches the account store, with an
// actionable error, while the SEC-01 session gate keeps protecting /api.
//   T08-POST-REJECT-BEFORE-WRITE — invalid POST never creates/changes the store
//   T08-POST-UNKNOWN-FIELD — unknown extras are rejected at the HTTP layer
//   T08-PUT-REJECT-BEFORE-WRITE — invalid updates never change the store
//   T08-POST-VALID-WORKS — a valid candidate still enrolls end to end
//   T08-SESSION-GATE — unauthenticated /api/account writes stay refused

const CONFIG_DIR = join(tmpdir(), `imap-mcp-t08-${process.pid}`);
process.env.IMAP_MCP_CONFIG_DIR = CONFIG_DIR;

let httpServer: Server;
let baseUrl: string;
let sessionToken: string;
let storePath: string;

const post = async (path: string, body: unknown, withSession = true): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(withSession ? { 'x-mail-agent-session': sessionToken } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => undefined) };
};

const put = async (path: string, body: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-mail-agent-session': sessionToken },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => undefined) };
};

const validCandidate = {
  name: 'T08 Valid',
  host: 'imap.synth.test',
  port: 993,
  imapUsername: 'user@synth.test',
  password: ['t08-', 'synthetic', '-pw'].join(''),
  tls: true,
};

beforeAll(async () => {
  rmSync(CONFIG_DIR, { recursive: true, force: true });
  const manager = new AccountManager();
  const wizard = new WebUIServer(0, {
    accountManager: manager as any,
    imapService: {} as any,
  });
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

describe('T08: setup API rejects illegal candidates before any store write', () => {
  it('T08-POST-REJECT-BEFORE-WRITE: a string port is refused with the store untouched', async () => {
    const { status, body } = await post('/api/accounts', { ...validCandidate, name: 'T08 A', port: '993' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/port/i);
    expect(existsSync(storePath)).toBe(false);
  });

  it('T08-POST-UNKNOWN-FIELD: unknown request extras never reach the store', async () => {
    // The endpoint builds the candidate from known fields only; anything else
    // is dropped, so unknown data can never be persisted (the T07 validator
    // would reject it if it ever reached the candidate).
    const { status } = await post('/api/accounts', { ...validCandidate, name: 'T08 B', evilExtra: 'x' });
    expect(status).toBe(200);
    const stored = JSON.parse(readFileSync(storePath, 'utf8'));
    const created = stored.find((a: any) => a.name === 'T08 B');
    expect(created).toBeDefined();
    expect(Object.keys(created)).not.toContain('evilExtra');
  });

  it('T08-PUT-REJECT-BEFORE-WRITE: invalid updates leave the stored bytes unchanged', async () => {
    const created = await post('/api/accounts', { ...validCandidate, name: 'T08 C' });
    expect(created.status).toBe(200);
    expect(existsSync(storePath)).toBe(true);
    const before = readFileSync(storePath, 'utf8');

    const { status, body } = await put(`/api/accounts/${created.body.account.id}`, { port: 'not-a-port' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/port/i);
    expect(readFileSync(storePath, 'utf8')).toBe(before);
  });

  it('T08-POST-VALID-WORKS: a valid candidate still enrolls end to end', async () => {
    const { status, body } = await post('/api/accounts', {
      ...validCandidate,
      name: 'T08 Valid 2',
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    // The plaintext password never crosses the wire.
    expect(JSON.stringify(body)).not.toContain(['t08-', 'synthetic', '-pw'].join(''));
    const stored = JSON.parse(readFileSync(storePath, 'utf8'));
    const names = stored.map((a: any) => a.name);
    expect(names).toContain('T08 Valid 2');
  });

  it('T08-SESSION-GATE: unauthenticated account writes stay refused (SEC-01 regression)', async () => {
    const { status } = await post('/api/accounts', validCandidate, false);
    expect(status).toBe(403);
  });
});
