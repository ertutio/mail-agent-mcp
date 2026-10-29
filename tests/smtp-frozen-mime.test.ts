import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SmtpService } from '../src/services/smtp-service.js';
import type { ImapAccount } from '../src/types/index.js';

// T22 / MAIL-03: one frozen MIME. The exact bytes composeRaw builds are what
// SMTP submits AND what the Sent copy appends — Message-ID and Date cannot
// drift between the delivered message and its copy. BCC stays envelope-only.
//   T22-SINGLE-COMPILE — the submitted transport input IS the compiled raw
//   T22-BCC-ENVELOPE — envelope covers to+cc+bcc; the raw carries no Bcc
//   T22-MESSAGE-ID-CONSISTENT — the returned messageId is the raw's own
//   T22-COMPOSE-FAIL-NO-SILENT-SKIP — a compose failure fails the send

const SYNTHETIC_PASSWORD = ['t22-', 'synthetic', '-pw'].join('');

const account: ImapAccount = {
  id: 'acc-t22',
  name: 'T22',
  host: 'smtp.synth.test',
  port: 465,
  user: 'sender@synth.test',
  password: SYNTHETIC_PASSWORD,
  tls: true,
  email: 'sender@synth.test',
};

const composer = {
  from: 'sender@synth.test',
  to: 'visible@synth.test',
  cc: 'cc@synth.test',
  bcc: ['hidden1@synth.test', 'hidden2@synth.test'],
  subject: 'T22 frozen MIME',
  text: 'synthetic body',
};

const messageIdOf = (raw: string): string => {
  const match = raw.match(/^Message-ID:\s*<(.+)>/mi);
  return match ? `<${match[1]}>` : '';
};

describe('T22: single frozen MIME for submission and Sent copy', () => {
  let service: SmtpService;
  let sendMail: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    service = new SmtpService();
    sendMail = vi.fn(async (opts: any) => ({
      messageId: messageIdOf(String(opts.raw ?? '')) || '<generated@synth.test>',
      response: '250 ok',
    }));
    vi.spyOn(service as any, 'createTransporter').mockResolvedValue({ sendMail });
  });

  it('T22-SINGLE-COMPILE: the transport receives the compiled raw, not mail options', async () => {
    const result = await service.sendEmail(account.id, account, composer as any);

    expect(sendMail).toHaveBeenCalledOnce();
    const submitted = sendMail.mock.calls[0]![0];
    expect(Buffer.isBuffer(submitted.raw)).toBe(true);
    expect(submitted.raw.toString()).toContain('T22 frozen MIME');
    expect(submitted.raw.toString()).toMatch(/^Message-ID:/mi);
    expect(submitted.raw.toString()).toMatch(/^Date:/mi);
    // The frozen raw is exactly what the Sent copy will append.
    expect(result.rawMessage!.toString()).toBe(submitted.raw.toString());
    // The result is anchored to the frozen MIME's own Message-ID.
    expect(result.messageId).toBe(messageIdOf(submitted.raw.toString()));
  });

  it('T22-BCC-ENVELOPE: the envelope covers to+cc+bcc while the raw stays Bcc-free', async () => {
    await service.sendEmail(account.id, account, composer as any);

    const submitted = sendMail.mock.calls[0]![0];
    expect(submitted.envelope.from).toBe('sender@synth.test');
    for (const recipient of ['visible@synth.test', 'cc@synth.test', 'hidden1@synth.test', 'hidden2@synth.test']) {
      expect(submitted.envelope.to).toContain(recipient);
    }
    const rawText = submitted.raw.toString();
    expect(rawText).not.toMatch(/^Bcc:/mi);
    expect(rawText).not.toContain('hidden1@synth.test');
    expect(rawText).not.toContain('hidden2@synth.test');
  });

  it('T22-COMPOSE-FAIL-NO-SILENT-SKIP: a compose failure fails the whole send', async () => {
    const oversized = {
      ...composer,
      text: 'x'.repeat(100001), // beyond MAX_BODY_CHARS
    };
    await expect(service.sendEmail(account.id, account, oversized as any))
      .rejects.toThrow(/Failed to send email/i);
    expect(sendMail).not.toHaveBeenCalled();
  });
});
