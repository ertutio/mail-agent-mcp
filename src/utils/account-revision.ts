import { createHash } from 'node:crypto';
import type { ImapAccount } from '../types/index.js';

/**
 * Non-secret revision contract for an account record (T11 / SA-01 scope).
 *
 * The revision is a deterministic hash over the identity-relevant fields —
 * connection config (host/port/tls/user/loginMethod), send policy
 * (saveToSent/sentFolder), SMTP connection config, and the credential
 * REFERENCE (kind/provider/credentialTarget). It is derived, so records
 * stored before this contract existed need no migration: the revision is
 * computed on read.
 *
 * Contract:
 * - revision change  ⟹ the record's identity-relevant fields changed.
 * - revision unchanged ⟹ the record is unchanged — but this MUST NOT be
 *   read as "the vault secret is unchanged": a same-target credential
 *   rotation (e.g. via the repair flow) leaves the record untouched, and
 *   the revision intentionally carries no secret material (no password,
 *   no hash of any secret).
 *
 * Derived from the full account record minus the excluded fields, so any
 * future field addition automatically joins the revision unless explicitly
 * excluded (secrets and identity-irrelevant fields).
 */
const EXCLUDED_FIELDS = new Set([
  'id',            // the id IS the stable handle; revision detects CHANGES
  'password',      // secret
  'name',          // display label, not identity
  'keepalive',     // connection tuning, not identity
  'authTimeout',   // connection tuning, not identity
  'connTimeout',   // connection tuning, not identity
  'smtp.password', // handled via the nested exclusion below
]);

const SMTP_INCLUDED_FIELDS = ['host', 'port', 'secure', 'user', 'authMethod', 'tls'];

export function accountRevision(account: ImapAccount): string {
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(account).sort()) {
    if (EXCLUDED_FIELDS.has(key)) continue;
    if (key === 'smtp' && typeof value === 'object' && value !== null) {
      const smtp: Record<string, unknown> = {};
      for (const [sk, sv] of Object.entries(value as Record<string, unknown>).sort()) {
        if (SMTP_INCLUDED_FIELDS.includes(sk)) smtp[sk] = sv;
      }
      record[key] = smtp;
      continue;
    }
    record[key] = value;
  }
  return createHash('sha256')
    .update(JSON.stringify(record))
    .digest('hex')
    .slice(0, 16);
}
