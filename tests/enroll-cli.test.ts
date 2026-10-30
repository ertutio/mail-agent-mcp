import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { CredentialBackend } from '../src/credentials/credential-backend.js';
import { credentialTarget, gmailClientSecretTarget } from '../src/credentials/credential-backend.js';
import { CredentialRollbackError, type CredentialRotationOptions } from '../src/credentials/credential-rotation.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync, existsSync, readFileSync } from 'fs';
import { runEnrollmentCli, type EnrollmentCliDependencies } from '../src/enroll.js';
import type { ImapAccount } from '../src/types/index.js';

const SYNTHETIC_REFRESH_TOKEN_1 = ["dummy-new-r", "efresh-token"].join('');
const SYNTHETIC_CLIENT_SECRET_2 = ["dummy-cli", "ent-secret"].join('');

const account = (user = 'owner@qq.com'): ImapAccount => ({
  id: 'qq-account', name: 'QQ Mail', host: 'imap.qq.com', port: 993,
  user, password: '', tls: true,
  auth: { kind: 'credential', provider: 'qq', credentialTarget: credentialTarget('qq', user) },
});

function setup(accounts: ImapAccount[] = [account()]) {
  const output: string[] = [];
  const credentials = {} as CredentialBackend;
  const prompt = vi.fn(async () => 'dummy-new-authorization-code');
  const rotate = vi.fn(async (options: Parameters<NonNullable<EnrollmentCliDependencies['rotateCredential']>>[0]) => {
    await options.verify();
  });
  const authenticateOnly = vi.fn(async () => undefined);
  const deps: EnrollmentCliDependencies = {
    platform: 'win32', getAccounts: () => accounts, credentials, prompt,
    rotateCredential: rotate, authenticateOnly,
    writeOutput: (text) => { output.push(text); },
  };
  return { deps, credentials, prompt, rotate, authenticateOnly, output };
}

describe('qq-repair enrollment CLI', () => {
  it.each(['--help', '-h'])('prints usage for %s without platform or prompt requirements', async (flag) => {
    const output: string[] = [];
    const prompt = vi.fn(async () => 'should-not-be-used');
    await expect(runEnrollmentCli([flag], {
      platform: 'linux',
      stdinIsTTY: false,
      prompt,
      writeOutput: (text) => { output.push(text); },
    })).resolves.toBeUndefined();
    expect(prompt).not.toHaveBeenCalled();
    expect(output.join('')).toContain('Usage: mail-agent-enroll <qq|gmail|qq-repair [account-id-or-name]|gmail-repair [account-id-or-name]>');
  });

  it('rejects the default secret prompt on non-TTY stdin before rotation or authentication', async () => {
    const state = setup();
    const deps = { ...state.deps, prompt: undefined, stdinIsTTY: false };
    await expect(runEnrollmentCli(['qq-repair'], deps)).rejects.toThrow(
      'QQ credential repair requires an interactive terminal for secret input',
    );
    expect(state.rotate).not.toHaveBeenCalled();
    expect(state.authenticateOnly).not.toHaveBeenCalled();
  });

  it('allows an injected prompt when the process stdin is non-TTY', async () => {
    const state = setup();
    await runEnrollmentCli(['qq-repair'], { ...state.deps, stdinIsTTY: false });
    expect(state.prompt).toHaveBeenCalledOnce();
    expect(state.rotate).toHaveBeenCalledOnce();
  });

  it('repairs exactly one eligible account without account mutation', async () => {
    const state = setup();
    await runEnrollmentCli(['qq-repair'], state.deps);
    expect(state.prompt).toHaveBeenCalledWith('QQ Mail authorization code', { secret: true });
    expect(state.rotate).toHaveBeenCalledOnce();
    const options = state.rotate.mock.calls[0]![0];
    expect(options.target).toBe(credentialTarget('qq', 'owner@qq.com'));
    expect(options.expectedTarget).toBe(options.target);
    expect(options.credentials).toBe(state.credentials);
    expect(state.authenticateOnly).toHaveBeenCalledWith(expect.objectContaining({ id: 'qq-account' }), state.credentials);
    expect(state.output.join('')).toBe('QQ Mail credential repaired successfully.\n');
  });

  it.each([[[]], [[account(), account('second@qq.com')]]])(
    'rejects zero or multiple eligible accounts before prompting or credential I/O',
    async (accounts) => {
      const state = setup(accounts);
      await expect(runEnrollmentCli(['qq-repair'], state.deps)).rejects.toThrow(
        'QQ credential repair requires an account selector when zero or multiple eligible accounts exist',
      );
      expect(state.prompt).not.toHaveBeenCalled();
      expect(state.rotate).not.toHaveBeenCalled();
      expect(state.authenticateOnly).not.toHaveBeenCalled();
    },
  );

  it('rejects a non-canonical target before prompting or credential I/O', async () => {
    const mismatched = account();
    mismatched.auth = { kind: 'credential', provider: 'qq', credentialTarget: 'wrong-target' };
    const state = setup([mismatched]);
    await expect(runEnrollmentCli(['qq-repair'], state.deps)).rejects.toThrow('QQ credential target mismatch');
    expect(state.prompt).not.toHaveBeenCalled();
    expect(state.rotate).not.toHaveBeenCalled();
  });

  it('selects one QQ account by id without treating the selector as a secret', async () => {
    const first = account();
    const second = account('second@qq.com');
    second.id = 'second-account';
    const state = setup([first, second]);
    await runEnrollmentCli(['qq-repair', 'second-account'], state.deps);
    expect(state.rotate.mock.calls[0]![0].target).toBe(credentialTarget('qq', 'second@qq.com'));
    expect(state.prompt).toHaveBeenCalledWith('QQ Mail authorization code', { secret: true });
  });

  it('rejects extra argv without treating it as an authorization code', async () => {
    const state = setup();
    await expect(runEnrollmentCli(['qq-repair', 'qq-account', 'dummy-secret-from-argv'], state.deps)).rejects.toThrow(
      'QQ credential repair accepts at most one account selector',
    );
    expect(state.prompt).not.toHaveBeenCalled();
    expect(state.rotate).not.toHaveBeenCalled();
    expect(state.output.join('')).not.toContain('dummy-secret-from-argv');
  });

  it('sanitizes verification errors and never exposes prompt or cause secrets', async () => {
    const state = setup();
    state.authenticateOnly.mockRejectedValue(new Error('provider leaked dummy-old-secret and dummy-new-authorization-code'));
    let caught: unknown;
    try { await runEnrollmentCli(['qq-repair'], state.deps); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('QQ credential repair failed; the previous credential was restored');
    expect((caught as Error).message).not.toMatch(/dummy-old-secret|dummy-new-authorization-code/);
    expect(state.output.join('')).not.toMatch(/dummy-old-secret|dummy-new-authorization-code/);
  });

  it('reports rollback failure as a fixed inconsistent-state error without leaking its cause', async () => {
    const state = setup();
    state.rotate.mockRejectedValue(new CredentialRollbackError(
      new Error('verification leaked dummy-old-secret and dummy-new-authorization-code'),
    ));
    let caught: unknown;
    try { await runEnrollmentCli(['qq-repair'], state.deps); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      'QQ credential repair failed; credential state may be inconsistent and repair must be rerun',
    );
    expect((caught as Error).message).not.toMatch(/dummy-old-secret|dummy-new-authorization-code/);
    expect(state.output.join('')).not.toMatch(/dummy-old-secret|dummy-new-authorization-code/);
  });

  it('releases the repair lock after a failed attempt', async () => {
    const first = setup();
    first.authenticateOnly.mockRejectedValue(new Error('verification failed'));
    await expect(runEnrollmentCli(['qq-repair'], first.deps)).rejects.toThrow(
      'QQ credential repair failed; the previous credential was restored',
    );
    const second = setup();
    await expect(runEnrollmentCli(['qq-repair'], second.deps)).resolves.toBeUndefined();
    expect(second.rotate).toHaveBeenCalledOnce();
  });

  it('rejects concurrent repair for the same target', async () => {
    const first = setup();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    first.authenticateOnly.mockImplementation(() => blocked);
    const firstRun = runEnrollmentCli(['qq-repair'], first.deps);
    await vi.waitFor(() => expect(first.authenticateOnly).toHaveBeenCalledOnce());
    const second = setup();
    await expect(runEnrollmentCli(['qq-repair'], second.deps)).rejects.toThrow('QQ credential repair is already in progress');
    expect(second.prompt).not.toHaveBeenCalled();
    expect(second.rotate).not.toHaveBeenCalled();
    release();
    await firstRun;
  });
});


describe('gmail-repair enrollment CLI', () => {
  const gmailAccount = (user = 'owner@gmail.com'): ImapAccount => ({
    id: 'gmail-account', name: 'Gmail', host: 'imap.gmail.com', port: 993,
    user, password: '', tls: true,
    auth: {
      kind: 'oauth2',
      provider: 'gmail',
      credentialTarget: credentialTarget('gmail', user),
      clientId: 'desktop-client-id',
      clientSecretTarget: gmailClientSecretTarget(user),
    },
  });

  function gmailSetup(accounts: ImapAccount[] = [gmailAccount()]) {
    const disposed: boolean[] = [];
    const values = new Map<string, string>([
      [gmailClientSecretTarget('owner@gmail.com'), 'dummy-client-secret'],
    ]);
    const credentials: CredentialBackend = {
      read: (target) => {
        const value = values.get(target);
        if (value === undefined) return undefined;
        const index = disposed.push(false) - 1;
        return {
          read: () => value,
          dispose: () => { disposed[index] = true; },
        };
      },
      write: (target, secret) => { values.set(target, secret); },
      delete: (target) => values.delete(target),
    };
    const output: string[] = [];
    const runGmailOAuth = vi.fn(async () => ({
      refreshToken: SYNTHETIC_REFRESH_TOKEN_1,
      redirectUri: 'http://127.0.0.1:12345/oauth2/callback',
    }));
    const rotate = vi.fn(async (options: CredentialRotationOptions) => {
      await options.verify();
    });
    const authenticateOnly = vi.fn(async () => undefined);
    const deps: EnrollmentCliDependencies = {
      platform: 'win32',
      getAccounts: () => accounts,
      credentials,
      prompt: vi.fn(async () => 'unused'),
      runGmailOAuth,
      rotateCredential: rotate,
      authenticateOnly,
      writeOutput: (text) => { output.push(text); },
    };
    return { deps, disposed, runGmailOAuth, rotate, authenticateOnly, output };
  }

  it('reauthorizes Gmail with the bound client secret and verifies the replacement', async () => {
    const state = gmailSetup();
    await runEnrollmentCli(['gmail-repair'], state.deps);
    expect(state.runGmailOAuth).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'desktop-client-id',
      clientSecret: SYNTHETIC_CLIENT_SECRET_2,
      loginHint: 'owner@gmail.com',
    }));
    expect(state.disposed).toEqual([true]);
    expect(state.rotate.mock.calls[0]![0]).toEqual(expect.objectContaining({
      target: credentialTarget('gmail', 'owner@gmail.com'),
      expectedTarget: credentialTarget('gmail', 'owner@gmail.com'),
      replacement: 'dummy-new-refresh-token',
    }));
    expect(state.authenticateOnly).toHaveBeenCalledOnce();
    expect(state.output.join('')).not.toContain('dummy-client-secret');
    expect(state.output.join('')).not.toContain('dummy-new-refresh-token');
  });

  it('selects one Gmail account from multiple eligible accounts', async () => {
    const second = gmailAccount('second@gmail.com');
    second.id = 'second-gmail';
    delete (second.auth as { clientSecretTarget?: string }).clientSecretTarget;
    const state = gmailSetup([gmailAccount(), second]);
    await runEnrollmentCli(['gmail-repair', 'second-gmail'], state.deps);
    expect(state.rotate.mock.calls[0]![0].target).toBe(credentialTarget('gmail', 'second@gmail.com'));
  });
});

// T16 / BUG-SEC-04: CLI enrollment must verify the credentials with a real
// login before anything is committed — the same verify the web wizard injects
// (account => imapService.authenticateOnly). Case IDs:
//   T16-VERIFY-CALLED — the enroll path invokes the injected login verification
//   T16-VERIFY-FAIL-ROLLBACK — a failed verification rolls the vault write back
//     and never reports the account as enrolled
//   T16-VERIFY-PASS-COMMITS — a passed verification commits the account
describe('T16: CLI enrollment requires login verification', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = join(tmpdir(), 'imap-mcp-t16-' + process.pid + '-' + Math.random().toString(36).slice(2));
    process.env.IMAP_MCP_CONFIG_DIR = configDir;
  });
  afterEach(() => {
    delete process.env.IMAP_MCP_CONFIG_DIR;
    rmSync(configDir, { recursive: true, force: true });
  });

  const enrollSetup = (authenticateOnly: ReturnType<typeof vi.fn>) => {
    const output: string[] = [];
    const credentials = {
      read: vi.fn(() => null),
      write: vi.fn(() => true),
      delete: vi.fn(() => true),
    } as unknown as CredentialBackend;
    const prompt = vi.fn(async () => 'user@qq.synth.test');
    const deps: EnrollmentCliDependencies = {
      platform: 'win32',
      stdinIsTTY: true,
      credentials,
      prompt,
      authenticateOnly: authenticateOnly as any,
      writeOutput: (text) => { output.push(text); },
    };
    return { deps, credentials, authenticateOnly, output };
  };

  it('T16-VERIFY-CALLED: qq enrollment invokes the injected login verification', async () => {
    const state = enrollSetup(vi.fn(async () => undefined));
    await runEnrollmentCli(['qq'], state.deps);
    expect(state.authenticateOnly).toHaveBeenCalledTimes(1);
    expect(state.output.join('')).toContain('enrolled');
  });

  it('T16-VERIFY-FAIL-ROLLBACK: a failed verification rolls back and never reports enrolled', async () => {
    const state = enrollSetup(vi.fn(async () => { throw new Error('IMAP login failed'); }));
    await expect(runEnrollmentCli(['qq'], state.deps)).rejects.toThrow(/IMAP login failed/);
    expect(state.authenticateOnly).toHaveBeenCalledTimes(1);
    expect(state.output.join('')).not.toContain('enrolled');
    // The freshly written vault secret is rolled back (deleted).
    expect(state.credentials.delete).toHaveBeenCalled();
    const store = join(configDir, 'accounts.json');
    expect(existsSync(store)).toBe(false);
  });

  it('T16-VERIFY-PASS-COMMITS: a passed verification commits the account to the store', async () => {
    const state = enrollSetup(vi.fn(async () => undefined));
    await runEnrollmentCli(['qq'], state.deps);
    const store = join(configDir, 'accounts.json');
    expect(existsSync(store)).toBe(true);
    const stored = JSON.parse(readFileSync(store, 'utf8'));
    expect(stored).toHaveLength(1);
    expect(stored[0].host).toBe('imap.qq.com');
  });
});
  // T16 review: NetEase and Gmail enrollment failures must also roll the
  // vault back and never report the account as enrolled.
  it('T16R-NETEASE-FAIL-ROLLBACK: a failed NetEase verification rolls back and never reports enrolled', async () => {
    const configDir = join(tmpdir(), 'imap-mcp-t16r-n-' + Math.random().toString(36).slice(2));
    process.env.IMAP_MCP_CONFIG_DIR = configDir;
    const output: string[] = [];
    const credentials = {
      read: vi.fn(() => null),
      write: vi.fn(() => true),
      delete: vi.fn(() => true),
    } as unknown as CredentialBackend;
    const prompt = vi.fn(async (label: string) =>
      label === 'Email address' ? 'owner@163.synth.test' : label === 'Account name' ? 'T16R NetEase' : 'synthetic-auth-code');
    const authenticateOnly = vi.fn(async () => { throw new Error('IMAP login failed'); });
    try {
      await expect(runEnrollmentCli(['163'], {
        platform: 'win32', credentials, prompt, authenticateOnly,
        writeOutput: (text) => { output.push(text); },
      })).rejects.toThrow(/IMAP login failed/);
      expect(authenticateOnly).toHaveBeenCalledTimes(1);
      expect(output.join('')).not.toContain('enrolled');
      expect(credentials.delete).toHaveBeenCalled();
      expect(existsSync(join(configDir, 'accounts.json'))).toBe(false);
    } finally {
      delete process.env.IMAP_MCP_CONFIG_DIR;
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('T16R-GMAIL-FAIL-ROLLBACK: a failed Gmail verification rolls back and never reports enrolled', async () => {
    const configDir = join(tmpdir(), 'imap-mcp-t16r-g-' + Math.random().toString(36).slice(2));
    process.env.IMAP_MCP_CONFIG_DIR = configDir;
    const output: string[] = [];
    const credentials = {
      read: vi.fn(() => null),
      write: vi.fn(() => true),
      delete: vi.fn(() => true),
    } as unknown as CredentialBackend;
    const prompt = vi.fn(async (label: string) => label === 'Gmail OAuth desktop client ID' ? 'client-id' : 'owner@gmail.synth.test');
    const authenticateOnly = vi.fn(async () => { throw new Error('IMAP login failed'); });
    try {
      await expect(runEnrollmentCli(['gmail'], {
        platform: 'win32', credentials, prompt, authenticateOnly,
        runGmailOAuth: vi.fn(async () => ({ refreshToken: ['synthetic', '-refresh'].join('') })),
        openBrowser: vi.fn(async () => undefined),
        writeOutput: (text) => { output.push(text); },
      })).rejects.toThrow(/IMAP login failed/);
      expect(authenticateOnly).toHaveBeenCalledTimes(1);
      expect(output.join('')).not.toContain('enrolled');
      expect(credentials.delete).toHaveBeenCalled();
      expect(existsSync(join(configDir, 'accounts.json'))).toBe(false);
    } finally {
      delete process.env.IMAP_MCP_CONFIG_DIR;
      rmSync(configDir, { recursive: true, force: true });
    }
  });
