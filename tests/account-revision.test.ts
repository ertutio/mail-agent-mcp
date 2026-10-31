import { describe, it, expect } from 'vitest';
import { accountRevision } from '../src/utils/account-revision.js';
import type { ImapAccount } from '../src/types/index.js';

// T11 / SA-01 scope: a non-secret revision over the identity-relevant fields.
//   T11R-SENSITIVE — every connection/send-policy field change bumps it
//   T11R-STABLE — identity-irrelevant fields and secrets do NOT bump it
//   T11R-NO-SECRET — the revision carries no secret material
//   T11R-OLD-RECORDS — derivable from records with no stored revision field

const base: ImapAccount = {
  id: 'acc-1',
  name: 'Work',
  host: 'imap.synth.test',
  port: 993,
  user: 'user@synth.test',
  password: ['stored', '-encrypted'].join(''),
  tls: true,
  smtp: { host: 'smtp.synth.test', port: 465, secure: true, user: 'user@synth.test', password: ['smtp', '-enc'].join('') },
};

const change = (field: keyof ImapAccount, value: unknown): ImapAccount =>
  ({ ...base, [field]: value } as ImapAccount);

describe('T11: account revision contract', () => {
  it('T11R-SENSITIVE: connection and send-policy changes bump the revision', () => {
    const baseRev = accountRevision(base);
    for (const [field, value] of [
      ['host', 'other.synth.test'],
      ['port', 994],
      ['tls', false],
      ['user', 'new@synth.test'],
      ['loginMethod', 'XOAUTH2'],
      ['saveToSent', false],
      ['sentFolder', 'Gesendet'],
      ['auth', { kind: 'credential', provider: 'qq', credentialTarget: 'MailAgentMCP:qq:other' }],
      ['smtp', { ...base.smtp, host: 'other-smtp.synth.test' }],
    ] as Array<[keyof ImapAccount, unknown]>) {
      expect(accountRevision(change(field, value))).not.toBe(baseRev);
    }
  });

  it('T11R-STABLE: display name, tuning and secrets do NOT bump the revision', () => {
    const baseRev = accountRevision(base);
    expect(accountRevision(change('name', 'Renamed'))).toBe(baseRev);
    expect(accountRevision(change('keepalive', false))).toBe(baseRev);
    expect(accountRevision(change('authTimeout', 60_000))).toBe(baseRev);
    expect(accountRevision(change('password', ['different', '-encrypted'].join('')))).toBe(baseRev);
  });

  it('T11R-NO-SECRET: the revision is short hex without secret material', () => {
    const rev = accountRevision(base);
    expect(rev).toMatch(/^[0-9a-f]{16}$/);
    expect(rev).not.toContain('stored-encrypted-value');
    expect(rev).not.toContain(['smtp', '-enc'].join(''));
    // Deterministic across calls.
    expect(accountRevision(base)).toBe(rev);
  });

  it('T11R-OLD-RECORDS: derivable from records without a revision field', () => {
    // Old records (pre-contract) have no revision field; the function is
    // derived, so the same record always yields the same revision.
    const old = { ...base } as ImapAccount & { revision?: never };
    expect((old as any).revision).toBeUndefined();
    expect(accountRevision(old)).toBe(accountRevision({ ...base }));
  });
});
