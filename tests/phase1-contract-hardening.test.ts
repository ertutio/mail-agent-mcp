import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { assertProviderAccountAuth } from '../src/services/account-manager.js';
import { SafeSendService, type SafeSendInput } from '../src/services/safe-send-service.js';
import type { ImapAccount } from '../src/types/index.js';

const SYNTHETIC_PASSWORD_1 = ["synthetic", "-password"].join('');

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const account = (overrides: Partial<ImapAccount>): ImapAccount => ({
  id: 'synthetic-id',
  name: 'Synthetic',
  host: 'imap.example.test',
  port: 993,
  user: 'person@example.test',
  password: SYNTHETIC_PASSWORD_1,
  tls: true,
  ...overrides,
});

const input = (): SafeSendInput => ({
  accountId: 'account-1',
  composer: {
    from: 'sender@example.test',
    to: ['recipient@example.test'],
    subject: 'Synthetic subject',
    text: 'sensitive synthetic body',
    attachments: [{ filename: 'fixture.txt', content: Buffer.from('synthetic attachment') }],
  },
});

const stored = (service: SafeSendService, draftId: string): Record<string, unknown> =>
  (service as unknown as { drafts: Map<string, Record<string, unknown>> }).drafts.get(draftId)!;

const expectTombstone = (service: SafeSendService, draftId: string, state: string) => {
  const entry = stored(service, draftId);
  if (state === 'expired') {
    expect(entry).toEqual({ state, expiresAt: expect.any(Number) });
    expect(JSON.stringify(entry)).not.toContain('recipient@example.test');
  } else {
    expect(entry).toMatchObject({ state, expiresAt: expect.any(Number), outcome: { status: state } });
    expect(Object.keys(entry).filter(key => entry[key] !== undefined).sort()).toEqual(['expiresAt', 'outcome', 'state']);
  }
  expect(entry.payload).toBeUndefined();
  expect(entry.inFlight).toBeUndefined();
  const retained = JSON.stringify(entry);
  expect(retained).not.toMatch(/"(?:composer|raw|rawMessage|body|text|html|attachments|content|password|token|auth|accountId|accountRevision)"\s*:/);
  expect(retained).not.toMatch(/account-1|sender@example\.test|Synthetic subject|sensitive synthetic body|fixture\.txt|synthetic attachment|synthetic raw/);
  expect(retained).not.toContain(SYNTHETIC_PASSWORD_1);
  return entry;
};

describe('provider-bound generic account boundary', () => {
  it.each([
    ['Gmail', account({ host: 'imap.gmail.com' }), /node dist\/enroll\.js gmail/i],
    ['QQ Mail', account({ smtp: { host: 'smtp.qq.com', port: 465, secure: true } }), /node dist\/enroll\.js qq/i],
  ])('rejects password fallback for %s hosts', (_provider, candidate, expected) => {
    expect(() => assertProviderAccountAuth(candidate)).toThrow(expected);
  });

  it('preserves generic IMAP password compatibility', () => {
    expect(() => assertProviderAccountAuth(account({}))).not.toThrow();
  });
});

describe('safe-send terminal privacy', () => {
  it('retains sanitized terminal receipts and warnings while removing message payloads', async () => {
    const receipt = { accepted: ['recipient@example.test'], rejected: [], unknown: [] };
    const warnings = [{ code: 'sent_copy_failed' as const, message: 'Saving a Sent-folder copy failed' }];
    const sentExecutor = vi.fn(async () => ({ receipt, warnings }));
    const sent = new SafeSendService({ executor: sentExecutor, id: () => 'sent-id' });
    sent.preview(input());
    const sentResult = await sent.confirm('sent-id', true);
    expect(sentResult).toEqual({ status: 'sent', receipt, warnings });
    expect(expectTombstone(sent, 'sent-id', 'sent').outcome).toEqual(sentResult);
    await expect(sent.confirm('sent-id', true)).resolves.toEqual({ ...sentResult, status: 'already_sent', alreadyConfirmed: true });
    expect(sentExecutor).toHaveBeenCalledOnce();

    const ambiguousExecutor = vi.fn(async () => { throw new Error(`synthetic raw: sensitive synthetic body; ${SYNTHETIC_PASSWORD_1}`); });
    const ambiguous = new SafeSendService({
      executor: ambiguousExecutor,
      id: () => 'ambiguous-id',
    });
    ambiguous.preview(input());
    const ambiguousResult = await ambiguous.confirm('ambiguous-id', true);
    expect(ambiguousResult).toEqual({ status: 'ambiguous', receipt: { accepted: [], rejected: [], unknown: ['recipient@example.test'] } });
    expect(expectTombstone(ambiguous, 'ambiguous-id', 'ambiguous').outcome).toEqual(ambiguousResult);
    await expect(ambiguous.confirm('ambiguous-id', true)).resolves.toEqual({ ...ambiguousResult, alreadyConfirmed: true });
    expect(ambiguousExecutor).toHaveBeenCalledOnce();

    let now = 1_000;
    const expired = new SafeSendService({
      executor: vi.fn(async () => undefined),
      id: () => 'expired-id',
      ttlMs: 10,
      clock: () => now,
    });
    expired.preview(input());
    now += 10;
    expect(expired.expireDrafts()).toBe(1);
    expectTombstone(expired, 'expired-id', 'expired');
    await expect(expired.confirm('expired-id', true)).rejects.toThrow(/expired/i);
  });
});

describe('public MCP contract', () => {
  it('points attachment upload to preview-confirm sending, not hidden direct send', () => {
    const source = read('src/tools/email-tools.ts');
    const upload = source.slice(
      source.indexOf("server.registerTool('imap_upload_file'"),
      source.indexOf("server.registerTool('imap_download_attachment'"),
    );
    expect(upload).not.toContain('imap_send_email');
    expect(upload).toContain('imap_preview_send_email');
    expect(upload).toContain('imap_confirm_send');
  });

  it('defines read-only mode as mailbox-read-only and discloses attachment file writes', () => {
    const guide = read('docs/agent-integration.md');
    expect(guide).toMatch(/mailbox-read-only/i);
    expect(guide).toMatch(/attachment[^\n]{0,180}(write|save)[^\n]{0,180}(file|disk)/i);
  });
});
