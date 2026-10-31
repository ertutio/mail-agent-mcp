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
   * a failure there voids the rotation's lease instead of restoring.
   */
  reverify?: () => Promise<void>;
  /**
   * T17: exclusive guard (the account-store cross-process lock) around the
   * identity re-check and the vault write, so a concurrent remove or repair
   * cannot interleave between the check and the write.
   */
  writeGuard?: (action: () => Promise<void>) => Promise<void>;
}

export class CredentialRollbackError extends Error {
  constructor(cause: unknown) {
    super('Credential verification failed and rollback failed', { cause });
    this.name = 'CredentialRollbackError';
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

  const previous = snapshot(options.credentials, options.target);

  // T17: the identity re-check and the vault write form one critical section.
  // Under the write guard a concurrent remove/repair cannot slip between the
  // check and the write, so the lease on `previous` cannot be stolen.
  const writeReplacement = async (): Promise<void> => {
    if (options.reverify) {
      await options.reverify();
    }
    options.credentials.write(options.target, replacement);
  };
  if (options.writeGuard) {
    await options.writeGuard(writeReplacement);
  } else {
    await writeReplacement();
  }

  const rollback = async (): Promise<void> => {
    // Ownership rules — only restore a state this rotation still owns.
    // 1. Identity gate fails → a concurrent remove/replace owns the target;
    //    preserving the newer state also means never resurrecting a removed
    //    secret. The original error is rethrown by the caller either way.
    if (options.reverify) {
      try {
        await options.reverify();
      } catch {
        return;
      }
    }
    const current = snapshot(options.credentials, options.target);
    // 2. The secret is gone → a concurrent remove deleted it; keep it deleted.
    if (!current.exists) {
      return;
    }
    // 3. A different value → a newer successful operation owns the target
    //    (an equal value from a newer operation is covered by rule 1's
    //    revision gate, not by value comparison).
    if (current.value !== replacement) {
      return;
    }
    if (previous.exists) {
      options.credentials.write(options.target, previous.value!);
    } else if (!options.credentials.delete(options.target)) {
      throw new Error('Credential deletion failed');
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
