import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEnrollmentCli, type EnrollmentCliDependencies } from '../src/enroll.js';
import { rotateCredential } from '../src/credentials/credential-rotation.js';
import { credentialTarget } from '../src/credentials/credential-backend.js';
import type { CredentialBackend, SecretHandle } from '../src/credentials/credential-backend.js';
import { withAccountStoreLock } from '../src/utils/account-store-lock.js';
import { AccountManager } from '../src/services/account-manager.js';
import type { ImapAccount } from '../src/types/index.js';

// T17 round-2: repair/remove coordination and rollback ownership. The vault is
// a fake backend with an operation journal; the account store, the cross-
// process lock and the rotation itself are REAL — the acceptance target
// (the repair transaction and its rollback) is not mocked away.
class JournalBackend implements CredentialBackend {
  readonly values = new Map<string, string>();
  readonly writes: Array<{ target: string; secret: string; op: number }> = [];
  readonly deletes: Array<{ target: string; op: number }> = [];
  private sequence = 0;

  private handle(value: string): SecretHandle {
    return { read: () => value, dispose: () => {} };
  }
  read(target: string): SecretHandle | undefined {
    const value = this.values.get(target);
    return value === undefined ? undefined : this.handle(value);
  }
  write(target: string, secret: string): void {
    this.writes.push({ target, secret, op: ++this.sequence });
    this.values.set(target, secret);
  }
  delete(target: string): boolean {
    this.deletes.push({ target, op: ++this.sequence });
    return this.values.delete(target);
  }
}

describe('T17L: repair/remove coordination and rollback ownership', () => {
  let dir: string;
  let previousEnv: string | undefined;
  let backend: JournalBackend;
  let manager: AccountManager;
  const target = credentialTarget('qq', 'owner@qq.com');

  const account = (): ImapAccount => ({
    id: 'qq-account', name: 'QQ Mail', host: 'imap.qq.com', port: 993,
    user: 'owner@qq.com', password: '', tls: true,
    auth: { kind: 'credential', provider: 'qq', credentialTarget: target },
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 't17-lease-'));
    previousEnv = process.env.IMAP_MCP_CONFIG_DIR;
    process.env.IMAP_MCP_CONFIG_DIR = dir;
    backend = new JournalBackend();
    manager = new AccountManager(backend);
  });
  afterEach(() => {
    if (previousEnv === undefined) delete process.env.IMAP_MCP_CONFIG_DIR;
    else process.env.IMAP_MCP_CONFIG_DIR = previousEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  const enrollAccount = async (): Promise<ImapAccount> => {
    const created = await manager.addAccount({ ...account(), password: ['store', 'd-pw'].join('') });
    backend.values.set(target, 'old-secret');
    backend.writes.length = 0;
    backend.deletes.length = 0;
    return created;
  };

  const repairDeps = (id: string, verifyGate: { promise: Promise<void>; release: (error?: Error) => void }): EnrollmentCliDependencies => ({
    platform: 'win32',
    getAccounts: () => manager.getAllAccounts(),
    credentials: backend,
    prompt: vi.fn(async () => 'replacement-A'),
    // The real rotation is used — no rotateCredential injection.
    authenticateOnly: async () => {
      await verifyGate.promise;
      throw new Error('IMAP login failed');
    },
    withStoreLock: (action) => withAccountStoreLock(dir, action),
    writeOutput: () => {},
  });

  const deferred = () => {
    let release!: (error?: Error) => void;
    const promise = new Promise<void>((resolve, reject) => { release = (error) => error ? reject(error) : resolve(); });
    return { promise, release };
  };

  const startRepair = (id: string, deps: EnrollmentCliDependencies) =>
    runEnrollmentCli(['qq-repair', id], deps).then(
      () => undefined,
      (error) => error instanceof Error ? error : new Error(String(error)),
    );

  it('T17L-REMOVE-WINS: remove completes while repair A waits; A fails late and the secret stays deleted', async () => {
    const created = await enrollAccount();
    const gate = deferred();
    const repair = startRepair(created.id, repairDeps(created.id, gate));

    // A wrote its replacement and is now waiting in verification.
    await vi.waitFor(() => expect(backend.writes).toHaveLength(1));
    expect(backend.writes[0]).toMatchObject({ target, secret: 'replacement-A' });

    // Remove completes fully under the store lock: vault delete + account gone + disk saved.
    await manager.removeAccount(created.id);
    expect(backend.values.has(target)).toBe(false);
    expect(manager.getAllAccounts()).toHaveLength(0);
    const reloaded = new AccountManager(backend);
    expect(reloaded.getAllAccounts()).toHaveLength(0);

    // A fails late: its rollback must not resurrect the removed secret.
    gate.release();
    const error = await repair;
    expect(error?.message).toMatch(/repair failed/);
    expect(backend.values.has(target)).toBe(false);
    expect(backend.writes).toHaveLength(1);
    expect(backend.deletes).toEqual([{ target, op: expect.any(Number) }]);
  });

  it('T17L-NEWER-REPAIR-WINS: B repair succeeds while A waits; A fails late and B stays', async () => {
    const created = await enrollAccount();
    const gate = deferred();
    const repair = startRepair(created.id, repairDeps(created.id, gate));
    await vi.waitFor(() => expect(backend.writes).toHaveLength(1));

    // B (another process model) completes its own rotation while A is gated.
    await rotateCredential({
      credentials: backend, target, expectedTarget: target,
      replacement: 'replacement-B', verify: async () => undefined,
    });

    gate.release();
    const error = await repair;
    expect(error?.message).toMatch(/repair failed/);
    expect(backend.values.get(target)).toBe('replacement-B');
    expect(backend.writes.map((w) => w.secret)).toEqual(['replacement-A', 'replacement-B']);
  });

  it('T17L-STALE-REVISION: a revision change under the same target rejects the stale repair before writing', async () => {
    const created = await enrollAccount();
    let reads = 0;
    const gate = deferred();
    const deps = repairDeps(created.id, gate);
    // Calls: 1 selection, 2 outer recheck — then the account is edited, so
    // the guarded identity re-check sees a different revision.
    const original = deps.getAccounts!;
    deps.getAccounts = () => {
      reads += 1;
      const accounts = original();
      return reads <= 2 ? accounts : accounts.map((a) => ({ ...a, host: 'other.imap.qq.com' }));
    };
    const repair = startRepair(created.id, deps);

    // Safety: if the stale repair reached the gated verification (pre-fix
    // behavior), release it so the module-level repair guard does not leak.
    const safety = setTimeout(() => gate.release(), 2_000);
    const error = await repair;
    clearTimeout(safety);
    expect(error?.message).toMatch(/repair failed/);
    // The stale repair never wrote: the vault still holds the previous secret.
    expect(backend.writes).toHaveLength(0);
    expect(backend.values.get(target)).toBe('old-secret');
  });

  it('T17L-NORMAL-FAILURE: a plain verification failure restores exactly the previous secret', async () => {
    const created = await enrollAccount();
    const gate = deferred();
    const repair = startRepair(created.id, repairDeps(created.id, gate));
    await vi.waitFor(() => expect(backend.writes).toHaveLength(1));

    gate.release();
    const error = await repair;
    expect(error?.message).toMatch(/repair failed/);
    expect(backend.values.get(target)).toBe('old-secret');
    expect(backend.writes.map((w) => w.secret)).toEqual(['replacement-A', 'old-secret']);
    expect(manager.getAllAccounts()).toHaveLength(1);
    expect(existsSync(join(dir, 'accounts.json'))).toBe(true);
  });

  it('T17L-NEWER-REPAIR-BEFORE-GUARD: a repair completing while A waits on the lock is captured, not destroyed', async () => {
    const created = await enrollAccount();
    const gate = deferred();
    const guardEntered = deferred();
    const guardWait = deferred();
    const deps = repairDeps(created.id, gate);
    deps.withStoreLock = (action) => withAccountStoreLock(dir, async () => {
      guardEntered.release();
      await guardWait.promise;
      await action();
    });
    const repair = startRepair(created.id, deps);
    await guardEntered.promise;

    // B completes its own rotation here — the audit's H1 window: B lands
    // after A captured its view of the world but before A's guarded write.
    await rotateCredential({
      credentials: backend, target, expectedTarget: target,
      replacement: 'replacement-B', verify: async () => undefined,
    });

    guardWait.release();
    await vi.waitFor(() => expect(backend.writes.map((w) => w.secret)).toContain('replacement-A'));
    gate.release();
    const error = await repair;
    expect(error?.message).toMatch(/repair failed/);
    // A's guarded snapshot saw B's value, so A's rollback restores B.
    expect(backend.values.get(target)).toBe('replacement-B');
    expect(backend.writes.map((w) => w.secret)).toEqual(['replacement-B', 'replacement-A', 'replacement-B']);
  });

  it('T17L-EQUAL-VALUE-NEWER-REPAIR: an identical replacement from a newer repair survives A', async () => {
    const created = await enrollAccount();
    const gate = deferred();
    const guardEntered = deferred();
    const guardWait = deferred();
    const deps = repairDeps(created.id, gate);
    deps.withStoreLock = (action) => withAccountStoreLock(dir, async () => {
      guardEntered.release();
      await guardWait.promise;
      await action();
    });
    const repair = startRepair(created.id, deps);
    await guardEntered.promise;

    // B writes the SAME replacement string A will write — value comparison
    // alone cannot attribute ownership; the guarded snapshot order must.
    await rotateCredential({
      credentials: backend, target, expectedTarget: target,
      replacement: 'replacement-A', verify: async () => undefined,
    });

    guardWait.release();
    await vi.waitFor(() => expect(backend.writes).toHaveLength(2));
    gate.release();
    const error = await repair;
    expect(error?.message).toMatch(/repair failed/);
    expect(backend.values.get(target)).toBe('replacement-A');
    expect(backend.writes.map((w) => w.secret)).toEqual(['replacement-A', 'replacement-A', 'replacement-A']);
  });

  it('T17L-GMAIL-REMOVE-WINS: the gmail repair path honors the same remove-wins ownership', async () => {
    const gmailTarget = credentialTarget('gmail', 'owner@gmail.com');
    const created = await manager.addAccount({
      name: 'Gmail', host: 'imap.gmail.com', port: 993,
      user: 'owner@gmail.com', password: '', tls: true,
      auth: { kind: 'oauth2', provider: 'gmail', credentialTarget: gmailTarget, clientId: 'synth-client-id.apps.googleusercontent.com' },
    } as never);
    backend.values.set(gmailTarget, 'old-refresh-token');
    backend.writes.length = 0;
    backend.deletes.length = 0;

    const gate = deferred();
    const deps: EnrollmentCliDependencies = {
      platform: 'win32',
      getAccounts: () => manager.getAllAccounts(),
      credentials: backend,
      runGmailOAuth: async () => ({ refreshToken: ['replacement', '-A'].join('') }),
      authenticateOnly: async () => {
        await gate.promise;
        throw new Error('IMAP login failed');
      },
      withStoreLock: (action) => withAccountStoreLock(dir, action),
      writeOutput: () => {},
    };
    const repair = runEnrollmentCli(['gmail-repair', created.id], deps).then(
      () => undefined,
      (error) => error instanceof Error ? error : new Error(String(error)),
    );

    await vi.waitFor(() => expect(backend.writes).toHaveLength(1));
    await manager.removeAccount(created.id);
    expect(backend.values.has(gmailTarget)).toBe(false);

    gate.release();
    const error = await repair;
    expect(error?.message).toMatch(/repair failed/);
    expect(backend.values.has(gmailTarget)).toBe(false);
    expect(backend.writes).toHaveLength(1);
    expect(backend.deletes).toEqual([{ target: gmailTarget, op: expect.any(Number) }]);
  });

  it('T17L-LOCK-EXCLUSIVE: the removal waits for the guarded write and cannot interleave', async () => {
    const created = await enrollAccount();
    const gate = deferred();
    const guardEntered = deferred();
    const guardRelease = deferred();
    const deps = repairDeps(created.id, gate);
    deps.withStoreLock = (action) => withAccountStoreLock(dir, async () => {
      guardEntered.release();
      await guardRelease.promise;
      await action();
    });
    const repair = startRepair(created.id, deps);
    await guardEntered.promise;

    // R starts while A owns the lock: it must not complete concurrently.
    let removed = false;
    const removal = manager.removeAccount(created.id).then(() => { removed = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(removed).toBe(false);

    guardRelease.release();
    await vi.waitFor(() => expect(backend.writes).toHaveLength(1));
    await removal;
    expect(removed).toBe(true);
    expect(backend.values.has(target)).toBe(false);

    gate.release();
    const error = await repair;
    expect(error?.message).toMatch(/repair failed/);
    expect(backend.values.has(target)).toBe(false);
    expect(backend.writes).toHaveLength(1);
  });
});
