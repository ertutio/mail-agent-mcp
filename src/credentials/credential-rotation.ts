import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { CredentialBackend } from './credential-backend.js';
import { accountStoreDirectory } from '../utils/account-store-lock.js';

export interface CredentialRotationOptions {
  credentials: CredentialBackend;
  target: string;
  expectedTarget: string;
  replacement: string;
  verify: () => Promise<void>;
  /**
   * T17: identity re-check (id / target / revision). Runs inside the write
   * guard immediately before the vault write, and again in the rollback —
   * a failure there voids the rotation's lease instead of restoring. Throw
   * a CredentialGateRejection when the identity gate rejects ownership;
   * any other error is treated as a rollback failure, not as ownership.
   */
  reverify?: () => Promise<void>;
  /**
   * T17: exclusive guard (the account-store cross-process lock) around the
   * identity re-check, the vault write AND the rollback, so every vault
   * mutation of this target is serialized against concurrent removes and
   * repairs. REQUIRED for correct ownership attribution: the generation
   * journal's read-modify-write is only serialized under this guard — a
   * caller omitting it gets degraded (best-effort) attribution.
   */
  writeGuard?: (action: () => Promise<void>) => Promise<void>;
  /**
   * T17: directory for the cross-process rotation generation journal.
   * Defaults to the account store directory; tests inject a temp directory.
   */
  generationDir?: string;
}

export class CredentialRollbackError extends Error {
  constructor(cause: unknown) {
    super('Credential verification failed and rollback failed', { cause });
    this.name = 'CredentialRollbackError';
  }
}

/** T17: thrown by identity gates when ownership is rejected. The rollback
 * treats this as "a newer operation owns the target" (skip the restore);
 * any other error from a gate is a failure, not an ownership answer. */
export class CredentialGateRejection extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialGateRejection';
  }
}

interface CredentialSnapshot {
  exists: boolean;
  value?: string;
}

const GENERATION_FILE = '.credential-rotation-generations.json';

function generationKey(target: string): string {
  return createHash('sha256').update(target).digest('hex').slice(0, 16);
}

function readGenerations(dir: string): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, GENERATION_FILE), 'utf8'));
    if (parsed && typeof parsed === 'object' && (parsed as { targets?: unknown }).targets instanceof Object) {
      return (parsed as { targets: Record<string, number> }).targets;
    }
    return {};
  } catch {
    // Missing or unreadable journal: generation 0 — a rotation that recorded
    // a higher generation therefore reads as superseded and skips restoring.
    return {};
  }
}

function bumpGeneration(dir: string, target: string): number {
  const key = generationKey(target);
  const targets = readGenerations(dir);
  const next = (targets[key] ?? 0) + 1;
  targets[key] = next;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // T17 audit M1/M2: atomic replace — a torn write must never reset the
  // counters and re-issue a stale generation to a concurrent rotation.
  const file = join(dir, GENERATION_FILE);
  const temp = join(dir, GENERATION_FILE + '.' + process.pid + '.tmp');
  writeFileSync(temp, JSON.stringify({ v: 1, targets }), { encoding: 'utf8', mode: 0o600 });
  renameSync(temp, file);
  return next;
}

export async function rotateCredential(options: CredentialRotationOptions): Promise<void> {
  if (options.target !== options.expectedTarget) {
    throw new Error('Credential target mismatch');
  }

  const replacement = options.replacement.trim();
  if (!replacement) {
    throw new Error('Credential replacement is required');
  }

  const generationDir = options.generationDir ?? accountStoreDirectory();

  // T17 audit H1: the previous-secret snapshot happens INSIDE the guard, so
  // a newer repair completing while this attempt waits on (or inside) the
  // lock is captured as `previous` instead of being destroyed by this
  // attempt's later rollback.
  let previous: CredentialSnapshot | undefined;
  let myGeneration: number | undefined;
  const writeReplacement = async (): Promise<void> => {
    if (options.reverify) {
      await options.reverify();
    }
    previous = snapshot(options.credentials, options.target);
    options.credentials.write(options.target, replacement);
    // T17: only a mutation that LANDED owns a generation — the bump happens
    // after the write. A rotation whose credential write fails (backend
    // error) must not move the counter, or a concurrent older attempt would
    // wrongly lose ownership and skip its legitimate rollback.
    try {
      myGeneration = bumpGeneration(generationDir, options.target);
    } catch (cause) {
      // Still inside the guard: nothing else could have mutated the vault
      // between our write and this failure. Compensate inline so an
      // unverified replacement never lingers (audit M3a), then surface the
      // journal failure.
      try {
        if (previous!.exists) {
          options.credentials.write(options.target, previous!.value!);
        } else {
          options.credentials.delete(options.target);
        }
      } catch {
        // The compensation itself failed: the vault may keep the unverified
        // replacement. That is a rollback failure, not an ownership answer —
        // surface it so the caller reports an inconsistent state instead of
        // a restored credential.
        throw new CredentialRollbackError(cause);
      }
      throw cause;
    }
  };
  if (options.writeGuard) {
    await options.writeGuard(writeReplacement);
  } else {
    await writeReplacement();
  }

  const rollback = async (): Promise<void> => {
    const restore = async (): Promise<void> => {
      // Ownership rules — only restore a state this rotation still owns.
      // 1. Identity gate rejects → a concurrent remove/replace owns the
      //    target; preserving the newer state also means never resurrecting
      //    a removed secret. Any OTHER gate error is a rollback failure
      //    (audit H4): an unreadable store is not an ownership answer.
      if (options.reverify) {
        try {
          await options.reverify();
        } catch (cause) {
          if (cause instanceof CredentialGateRejection) {
            return;
          }
          throw cause;
        }
      }
      const current = snapshot(options.credentials, options.target);
      // 2. The secret is gone → a concurrent remove deleted it; keep it deleted.
      if (!current.exists) {
        return;
      }
      // 3. A different value → a newer successful operation owns the target.
      if (current.value !== replacement) {
        return;
      }
      // 4. T17: value equality is NOT ownership — a newer rotation may have
      //    written the identical value while this attempt was verifying. The
      //    generation journal (bumped under the same exclusive guard by every
      //    rotation mutation) tells the two apart: only the latest generation
      //    may roll back. Rules 2 and 3 above are unaffected (remove keeps
      //    secrets deleted; different values are never overwritten).
      if (myGeneration !== undefined && readGenerations(generationDir)[generationKey(options.target)] !== myGeneration) {
        return;
      }
      if (previous!.exists) {
        options.credentials.write(options.target, previous!.value!);
      } else if (!options.credentials.delete(options.target)) {
        throw new Error('Credential deletion failed');
      }
      bumpGeneration(generationDir, options.target);
    };
    // T17 audit H2: the restore mutates the vault, so it runs under the same
    // exclusive guard as the write — a concurrent remove/repair cannot land
    // between the ownership check and the restore.
    if (options.writeGuard) {
      await options.writeGuard(restore);
    } else {
      await restore();
    }
  };

  try {
    await options.verify();
  } catch (cause) {
    try {
      await rollback();
    } catch {
      // The rollback failure may name secret material; surface the fixed
      // message with the original verification cause (established contract).
      throw new CredentialRollbackError(cause);
    }
    throw cause;
  }
}

function snapshot(credentials: CredentialBackend, target: string): CredentialSnapshot {
  const handle = credentials.read(target);
  if (!handle) return { exists: false };

  try {
    const value = handle.read();
    if (typeof value !== 'string') {
      throw new Error('Stored credential has an invalid value');
    }
    return { exists: true, value };
  } finally {
    handle.dispose();
  }
}
