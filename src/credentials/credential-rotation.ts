import type { CredentialBackend } from './credential-backend.js';

export interface CredentialRotationOptions {
  credentials: CredentialBackend;
  target: string;
  expectedTarget: string;
  replacement: string;
  verify: () => Promise<void>;
  /** T17: called between the write and the verify — the write boundary. */
  reverify?: () => Promise<void>;
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
  options.credentials.write(options.target, replacement);

  // T17: re-verify at the write boundary — the account may have been
  // removed or its identity changed between the outer recheck and the
  // actual vault write. A failure here rolls back (nothing to preserve).
  if (options.reverify) {
    try {
      await options.reverify();
    } catch (cause) {
      try {
        if (previous.exists) {
          options.credentials.write(options.target, previous.value!);
        } else if (!options.credentials.delete(options.target)) {
          throw new Error('Credential deletion failed');
        }
      } catch {
        throw new CredentialRollbackError(cause);
      }
      throw cause;
    }
  }

  try {
    await options.verify();
  } catch (cause) {
    try {
      if (previous.exists) {
        options.credentials.write(options.target, previous.value!);
      } else if (!options.credentials.delete(options.target)) {
        throw new Error('Credential deletion failed');
      }
    } catch {
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
