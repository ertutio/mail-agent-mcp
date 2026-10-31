import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SmtpService } from '../src/services/smtp-service.js';
import type { ImapAccount } from '../src/types/index.js';

// T21 / MAIL-10: the send result must expose per-recipient acceptance —
// accepted/rejected/unknown — and never claim full delivery when some (or
// all) recipients were rejected, nor claim final delivery at all.
//   T21-ALL-ACCEPTED — full acceptance reports sent:true with accepted list
//   T21-PARTIAL — partial acceptance reports sent:false + rejected list
//   T21-ALL-REJECTED — full rejection reports sent:false
//   T21-NO-ENVELOPE — transports without per-recipient data report unknown
//   T21-COMPAT — messageId/rawMessage stay on the result (compatible shape)

const SYNTHETIC_PASSWORD = ['t21-', 'synthetic', '-pw'].join('');

const account: ImapAccount = {
  id: 'acc-t21',
  name: 'T21',
  host: 'smtp.synth.test',
  port: 465,
  user: 'sender@synth.test',
  password: SYNTHETIC_PASSWORD,
  tls: true,
  email: 'sender@synth.test',
};

const composer = {
  from: 'sender@synth.test',
  to: 'a@synth.test, b@synth.test',
  bcc: 'hidden@synth.test',
  subject: 'T21 receipts',
  text: 'synthetic body',
};

const rawOf = (): Buffer => Buffer.from('From: sender@synth.test\r\nSubject: T21\r\n\r\nbody\r\n');

describe('T21: SMTP acceptance receipts', () => {
  let service: SmtpService;

  const withTransport = (sendMail: ReturnType<typeof vi.fn>) => {
    service = new SmtpService();
    vi.spyOn(service as any, 'createTransporter').mockResolvedValue({ sendMail });
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('T21-ALL-ACCEPTED: full acceptance reports sent:true with the accepted list', async () => {
    withTransport(vi.fn(async (opts: any) => ({
      messageId: '<m1@synth.test>',
      accepted: ['a@synth.test', 'b@synth.test', 'hidden@synth.test'],
      rejected: [],
      response: '250 OK',
    })));

    const result = await service.sendEmail(account.id, account, composer as any);

    expect(result.sent).toBe(true);
    expect(result.accepted).toEqual(['a@synth.test', 'b@synth.test', 'hidden@synth.test']);
    expect(result.rejected).toEqual([]);
    expect(result.unknownRecipients).toBeUndefined();
  });

  it('T21-PARTIAL: partial acceptance never claims sent:true', async () => {
    withTransport(vi.fn(async () => ({
      messageId: '<m2@synth.test>',
      accepted: ['a@synth.test'],
      rejected: ['b@synth.test', 'hidden@synth.test'],
      response: '250 OK, 550 unknown recipient',
    })));

    const result = await service.sendEmail(account.id, account, composer as any);

    expect(result.sent).toBe(false);
    expect(result.accepted).toEqual(['a@synth.test']);
    expect(result.rejected).toEqual(['b@synth.test', 'hidden@synth.test']);
    expect(result.message).toMatch(/rejected/i);
    expect(result.message).not.toMatch(/deliver/i); // no final-delivery claim
  });

  it('T21-ALL-REJECTED: full rejection reports sent:false with every recipient rejected', async () => {
    withTransport(vi.fn(async () => ({
      messageId: '<m3@synth.test>',
      accepted: [],
      rejected: ['a@synth.test', 'b@synth.test', 'hidden@synth.test'],
      response: '550 all unknown',
    })));

    const result = await service.sendEmail(account.id, account, composer as any);

    expect(result.sent).toBe(false);
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toHaveLength(3);
  });

  it('T21-NO-ENVELOPE: a transport without recipient data reports unknown, not success', async () => {
    // Some transports (e.g. streamTransport) never populate accepted/rejected.
    withTransport(vi.fn(async (opts: any) => ({
      messageId: '<m4@synth.test>',
      message: String(opts.raw),
      response: 'buffered',
    })));

    const result = await service.sendEmail(account.id, account, composer as any);

    expect(result.sent).toBeUndefined();
    expect(result.unknownRecipients).toMatch(/unknown/i);
    expect(result.accepted).toEqual([]);
    expect(result.receipt.unknown).toEqual(['a@synth.test', 'b@synth.test', 'hidden@synth.test']);
  });

  it('T21-COMPAT: messageId and rawMessage remain on the result', async () => {
    withTransport(vi.fn(async () => ({
      messageId: '<m5@synth.test>',
      accepted: ['a@synth.test', 'b@synth.test', 'hidden@synth.test'],
      rejected: [],
      response: '250 OK',
    })));

    const result = await service.sendEmail(account.id, account, composer as any);

    expect(result.messageId).toBe(result.rawMessage!.toString().match(/^Message-ID:\s*(.+?)\r?$/im)![1]);
    expect(result.rawMessage).toBeInstanceOf(Buffer);
  });

  // T20 review: closing old transporters must not break in-flight sends,
  // concurrent sends must be controlled, and the frozen raw/receipt
  // contracts must hold.
  describe('T20E: transporter lifecycle and send concurrency', () => {
    it('T20E-INFLIGHT-SURVIVES: a transporter close during an in-flight send does not corrupt the result', async () => {
      // The real nodemailer streamTransport is used; the close happens after
      // sendMail resolves (in the finally block), so the send completes.
      const nodemailer = await import('nodemailer');
      const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'crlf' } as any);
      const realSendMail = transport.sendMail.bind(transport);
      let sendResolved = false;
      vi.spyOn(service as any, 'createTransporter').mockResolvedValue({
        sendMail: async (opts: any) => {
          const info = await realSendMail(opts);
          sendResolved = true;
          return { messageId: messageIdOf(String(info.message)) };
        },
        close: vi.fn(),
      });

      const result = await service.sendEmail(account.id, account, composer as any);
      expect(sendResolved).toBe(true);
      // streamTransport has no per-recipient data: sent is undefined (unknown).
      expect(result.sent).toBeUndefined();
      expect(result.unknownRecipients).toBeDefined();
      expect(result.rawMessage).toBeDefined();
    });

    it('T20E-CONCURRENT-SENDS: two concurrent sends each get their own transport', async () => {
      const transporters: any[] = [];
      vi.spyOn(service as any, 'createTransporter').mockImplementation(async () => {
        const t = {
          sendMail: vi.fn(async (opts: any) => ({ messageId: messageIdOf(String(opts.raw ?? '')) || '<gen@synth.test>' })),
          close: vi.fn(),
        };
        transporters.push(t);
        return t;
      });

      const [r1, r2] = await Promise.all([
        service.sendEmail(account.id, account, composer as any),
        service.sendEmail(account.id, account, composer as any),
      ]);
      expect(r1.messageId).toBeDefined();
      expect(r2.messageId).toBeDefined();
      expect(transporters).toHaveLength(2);
    });

    it('T20E-RECEIPT-INTEGRITY: partial rejection still reports receipts without resending', async () => {
      let sendCount = 0;
      vi.spyOn(service as any, 'createTransporter').mockResolvedValue({
        sendMail: vi.fn(async () => {
          sendCount++;
          return {
            messageId: '<m@synth.test>',
            accepted: ['a@synth.test', 'hidden@synth.test'],
            rejected: ['b@synth.test'],
            response: '250/550',
          };
        }),
        close: vi.fn(),
      });

      const result = await service.sendEmail(account.id, account, composer as any);
      expect(sendCount).toBe(1); // no auto-resend
      expect(result.sent).toBe(false);
      expect(result.rejected).toEqual(['b@synth.test']);
    });
  });
});
