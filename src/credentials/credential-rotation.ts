import type { CredentialBackend } from './credential-backend.js';

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
   * repairs.
   */
  writeGuard?: (action: () => Promise<void>) => Promise<void>;
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

export async function rotateCredential(options: CredentialRotationOptions): Promise<void> {
  if (options.target !== options.expectedTarget) {
    throw new Error('Credential target mismatch');
  }

  const replacement = options.replacement.trim();
  if (!replacement) {
    throw new Error('Credential replacement is required');
  }

  // T17 audit H1: the previous-secret snapshot happens INSIDE the guard, so
  // a newer repair completing while this attempt waits on (or inside) the
  // lock is captured as `previous` instead of being destroyed by this
  // attempt's later rollback.
  let previous: CredentialSnapshot | undefined;
  const writeReplacement = async (): Promise<void> => {
    if (options.reverify) {
      await options.reverify();
    }
    previous = snapshot(options.credentials, options.target);
    options.credentials.write(options.target, replacement);
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
      //    Equal values are covered by lock serialization (audit H3): every
      //    vault mutation — including this restore — runs under the same
      //    exclusive guard, so a newer operation can only land before this
      //    attempt's guarded snapshot or after its guarded restore, never in
      //    between.
      if (current.value !== replacement) {
        return;
      }
      if (previous!.exists) {
        options.credentials.write(options.target, previous!.value!);
      } else if (!options.credentials.delete(options.target)) {
        throw new Error('Credential deletion failed');
      }
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
