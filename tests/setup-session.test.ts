import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { request as httpRequest, type Server } from 'node:http';
import { WebUIServer } from '../src/web/server.js';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

const fixtureAccount = {
  id: 'fixture',
  name: 'fixture',
  email: 'fixture@example.test',
  user: 'fixture@example.test',
  host: 'imap.example.test',
  port: 993,
  tls: true,
};

const getAllAccounts = vi.fn(() => [fixtureAccount]);
const addAccount = vi.fn(async (input: Record<string, unknown>) => ({ ...fixtureAccount, ...input }));
const updateAccount = vi.fn(async (_id: string, updates: Record<string, unknown>) => ({ ...fixtureAccount, ...updates }));
const getAccount = vi.fn(() => fixtureAccount);
const removeAccount = vi.fn(async () => undefined);
const abortConnection = vi.fn();
const routeHandlers = [getAllAccounts, addAccount, updateAccount, getAccount, removeAccount, abortConnection];

const wizard = new WebUIServer(0, {
  accountManager: { getAllAccounts, addAccount, updateAccount, getAccount, removeAccount } as any,
  imapService: { abortConnection } as any,
  credentials: {} as any,
});

let server: Server;
let base: string;
let port: number;
let sessionToken: string;
let invalidToken: string;

const requestBodies: Partial<Record<Method, string>> = {
  POST: JSON.stringify({ name: 'fixture', email: 'fixture@example.test', host: 'imap.example.test' }),
  PUT: JSON.stringify({ name: 'updated fixture' }),
  DELETE: JSON.stringify({ confirmed: true, name: 'fixture', email: 'fixture@example.test' }),
};

function request(
  path: string,
  method: Method,
  token?: string,
  extraHeaders: Record<string, string> = {},
  bodyOverride?: string,
) {
  const headers = new Headers(extraHeaders);
  if (token) headers.set('x-mail-agent-session', token);
  const body = bodyOverride ?? requestBodies[method];
  if (body) headers.set('content-type', 'application/json');
  return fetch(`${base}${path}`, { method, headers, ...(body ? { body } : {}) });
}

function requestWithHostHeader(path: string, method: Method, token: string, host: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const body = requestBodies[method];
    const headers: Record<string, string> = {
      host,
      'x-mail-agent-session': token,
    };
    if (body) headers['content-type'] = 'application/json';
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (typeof value === 'string') responseHeaders.set(name, value);
        }
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode ?? 500, headers: responseHeaders }));
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

beforeAll(async () => {
  server = wizard.getApp().listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a loopback TCP listener');
  port = address.port;
  base = `http://127.0.0.1:${port}`;
  sessionToken = new URLSearchParams(new URL(wizard.getSetupUrl()).hash.slice(1)).get('session')!;
  invalidToken = sessionToken === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
});

beforeEach(() => {
  for (const handler of routeHandlers) handler.mockClear();
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

const protectedRoutes: Array<{ method: Method; resource: string }> = [
  { method: 'GET', resource: '/accounts' },
  { method: 'POST', resource: '/accounts' },
  { method: 'PUT', resource: '/accounts/fixture' },
  { method: 'DELETE', resource: '/accounts/fixture' },
];

describe('setup session boundary', () => {
  it.each(['GET', 'POST', 'PUT', 'DELETE'] as const)(
    'protects the API mount root and trailing slash for %s',
    async method => {
      const results: Array<{ path: string; token: string; status: number }> = [];
      for (const prefix of ['/api', '/API', '/Api']) {
        for (const suffix of ['', '/']) {
          for (const [label, token] of [['missing', undefined], ['invalid', invalidToken]] as const) {
            const path = `${prefix}${suffix}`;
            const response = await request(path, method, token);
            results.push({ path, token: label, status: response.status });
            expect(response.headers.get('cache-control')).toBe('no-store');
          }
        }
      }
      expect(results.filter(result => result.status !== 403)).toEqual([]);
      expect(routeHandlers.every(handler => handler.mock.calls.length === 0)).toBe(true);
    },
  );

  it.each(protectedRoutes)(
    'rejects missing and invalid tokens for $method $resource across API casing and trailing slashes',
    async ({ method, resource }) => {
      const results: Array<{ path: string; token: string; status: number }> = [];
      for (const prefix of ['/api', '/API', '/Api']) {
        for (const suffix of ['', '/']) {
          const path = `${prefix}${resource}${suffix}`;
          for (const [label, token] of [['missing', undefined], ['invalid', invalidToken]] as const) {
            const response = await request(path, method, token);
            results.push({ path, token: label, status: response.status });
            expect(response.headers.get('cache-control')).toBe('no-store');
          }
        }
      }
      expect(results.filter(result => result.status !== 403)).toEqual([]);
      expect(routeHandlers.every(handler => handler.mock.calls.length === 0)).toBe(true);
    },
  );

  it('allows the valid session through account routes and the enrollment sub-router', async () => {
    const responses = await Promise.all([
      request('/API/accounts/', 'GET', sessionToken, { origin: base }),
      request('/Api/accounts/', 'POST', sessionToken, { origin: base }),
      request('/API/accounts/fixture/', 'PUT', sessionToken, { origin: base }),
      request('/Api/accounts/fixture/', 'DELETE', sessionToken, { origin: base }),
      request('/API/setup-info', 'GET', sessionToken, { origin: base }),
    ]);

    expect(responses.map(response => response.status)).toEqual([200, 200, 200, 200, 200]);
    expect(getAllAccounts).toHaveBeenCalledOnce();
    expect(addAccount).toHaveBeenCalledOnce();
    expect(updateAccount).toHaveBeenCalledOnce();
    expect(getAccount).toHaveBeenCalledOnce();
    expect(removeAccount).toHaveBeenCalledOnce();
    expect(abortConnection).toHaveBeenCalledOnce();
  });

  it('protects read and write routes inside the provider enrollment sub-router', async () => {
    const enrollmentBody = JSON.stringify({
      provider: 'qq',
      email: 'fixture@example.test',
      name: 'fixture',
      authorizationCode: ['synthetic', '-fixture-code'].join(''),
    });
    const results: Array<{ path: string; token: string; status: number }> = [];
    for (const [path, method] of [['/API/setup-info', 'GET'], ['/Api/enroll', 'POST']] as const) {
      for (const [label, token] of [['missing', undefined], ['invalid', invalidToken]] as const) {
        const response = await request(path, method, token, {}, method === 'POST' ? enrollmentBody : undefined);
        results.push({ path, token: label, status: response.status });
        expect(response.headers.get('cache-control')).toBe('no-store');
      }
    }

    expect(results.filter(result => result.status !== 403)).toEqual([]);
    expect(getAllAccounts).not.toHaveBeenCalled();
    expect(addAccount).not.toHaveBeenCalled();
  });

  it('keeps exact-origin, loopback Host, and Sec-Fetch-Site checks with no-store errors', async () => {
    const path = '/api/accounts/fixture';
    const wrongOrigin = base.replace('127.0.0.1', 'localhost');
    const cases = [
      request(path, 'PUT', sessionToken, { origin: wrongOrigin }),
      requestWithHostHeader(path, 'PUT', sessionToken, 'evil.example.test'),
      request(path, 'PUT', sessionToken, { origin: base, 'sec-fetch-site': 'cross-site' }),
    ];
    const responses = await Promise.all(cases);

    expect(responses.map(response => response.status)).toEqual([403, 403, 403]);
    expect(responses.map(response => response.headers.get('cache-control'))).toEqual(['no-store', 'no-store', 'no-store']);
    expect(updateAccount).not.toHaveBeenCalled();
  });

  it('keeps the setup page reachable without an API session', async () => {
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
  });
});
