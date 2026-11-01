import { describe, it, expect, vi, beforeEach } from 'vitest';
import nodemailer from 'nodemailer';
import { SmtpService } from '../src/services/smtp-service.js';
import { SafeSendPreflightError } from '../src/services/safe-send-service.js';
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

  // T20 round-2: the REAL createTransporter is exercised end to end — only
  // the underlying transport (nodemailer.createTransport) and the credential
  // resolution are controlled. Proves per-send transport ownership, the
  // post-verify identity re-check, and failure cleanup with explicit
  // results and call counts (never a swallowed unknown as success evidence).
  describe('T20R: transporter lifecycle through the real createTransporter', () => {
    interface Deferred { promise: Promise<void>; release: (error?: Error) => void }
    const deferred = (): Deferred => {
      let release!: (error?: Error) => void;
      const promise = new Promise<void>((resolve, reject) => { release = (error) => error ? reject(error) : resolve(); });
      return { promise, release };
    };

    const ACCEPTED = ['a@synth.test', 'b@synth.test', 'hidden@synth.test'];
    const REV_B_ACCOUNT: ImapAccount = { ...account, host: 'other.smtp.synth.test' };

    const setup = (options: { gateAuthAttempt?: number; gateSendAttempt?: number } = {}) => {
      service = new SmtpService();
      const made: Array<{ verify: ReturnType<typeof vi.fn>; sendMail: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
      let authAttempts = 0;
      let sendAttempts = 0;
      const authGate = deferred();
      const sendGate = deferred();
      (service as any).authResolver = {
        resolve: vi.fn(async () => {
          authAttempts += 1;
          if (options.gateAuthAttempt === authAttempts) await authGate.promise;
          return { kind: 'password' as const, user: 'sender@synth.test', password: SYNTHETIC_PASSWORD };
        }),
      };
      vi.spyOn(nodemailer, 'createTransport').mockImplementation(() => {
        const t = {
          verify: vi.fn(async () => undefined),
          sendMail: vi.fn(async () => {
            sendAttempts += 1;
            if (options.gateSendAttempt === sendAttempts) await sendGate.promise;
            return { messageId: '<m@synth.test>', accepted: [...ACCEPTED], rejected: [], response: '250 OK' };
          }),
          close: vi.fn(),
        };
        made.push(t);
        return t as any;
      });
      return { made, authGate, sendGate, authAttempts: () => authAttempts };
    };

    afterEach(() => { vi.restoreAllMocks(); });

    it('T20R-INFLIGHT-NOT-CLOSED: a revision change while A is in flight does not close A and both sends land', async () => {
      const { made, sendGate } = setup({ gateSendAttempt: 1 });

      const sendA = service.sendEmail(account.id, account, composer as any);
      await vi.waitFor(() => expect(made.length).toBe(1));
      // A owns its transport and is submitting.
      const sendB = service.sendEmail(account.id, REV_B_ACCOUNT, composer as any);
      const resultB = await sendB;

      // B's revision change must not close A's in-flight transporter.
      expect(made[0]!.close).not.toHaveBeenCalled();
      expect(resultB.sent).toBe(true);
      expect(resultB.receipt.accepted).toEqual(ACCEPTED);

      sendGate.release();
      const resultA = await sendA;
      // A lands with its own explicit receipt — not a swallowed unknown.
      expect(resultA.sent).toBe(true);
      expect(resultA.receipt.accepted).toEqual(ACCEPTED);
      expect(made[0]!.sendMail).toHaveBeenCalledTimes(1);
      expect(made[1]!.sendMail).toHaveBeenCalledTimes(1);
      // Each owner released its own transport exactly once.
      expect(made[0]!.close).toHaveBeenCalledTimes(1);
      expect(made[1]!.close).toHaveBeenCalledTimes(1);
    });

    it('T20R-STALE-AUTH-ABORTS: an auth delayed behind a revision change re-checks and never submits', async () => {
      const { made, authGate } = setup({ gateAuthAttempt: 1 });

      const sendA = service.sendEmail(account.id, account, composer as any);
      // A's transporter is created only after its auth resolves, so while the
      // auth is parked nothing is registered for A.

      // B (new revision) starts and completes while A's auth is still parked.
      const resultB = await service.sendEmail(account.id, REV_B_ACCOUNT, composer as any);
      expect(resultB.sent).toBe(true);
      expect(made.length).toBe(1); // only B's transporter exists so far

      authGate.release();
      // A's auth lands late: the post-verify re-check aborts the stale
      // attempt instead of registering it into B's collection.
      await expect(sendA).rejects.toBeInstanceOf(SafeSendPreflightError);
      expect(made.length).toBe(2); // A's transporter was built, then closed
      expect(made[1]!.sendMail).not.toHaveBeenCalled();
      expect(made[1]!.close).toHaveBeenCalledTimes(1);
      // B released its own transport; nothing lingers registered.
      expect((service as any).transporters.size).toBe(0);
      expect(made[0]!.close).toHaveBeenCalledTimes(1);
    });

    it('T20R-CONCURRENT-SAME-REV: two same-revision sends each own a transport and both land', async () => {
      const { made, sendGate } = setup({ gateSendAttempt: 1 });

      const sendA = service.sendEmail(account.id, account, composer as any);
      const sendB = service.sendEmail(account.id, account, composer as any);
      await vi.waitFor(() => expect(made.length).toBe(2));
      sendGate.release();
      const [resultA, resultB] = await Promise.all([sendA, sendB]);

      expect(resultA.sent).toBe(true);
      expect(resultB.sent).toBe(true);
      expect(made[0]!.sendMail).toHaveBeenCalledTimes(1);
      expect(made[1]!.sendMail).toHaveBeenCalledTimes(1);
      expect(made[0]!.close).toHaveBeenCalledTimes(1);
      expect(made[1]!.close).toHaveBeenCalledTimes(1);
      expect((service as any).transporters.size).toBe(0);
    });

    it('T20R-STALE-SNAPSHOT-LATE-ENTRY: a stale snapshot entering after a fresher attempt cannot pass via the live record', async () => {
      const { made } = setup();
      // The live store holds the new identity; B carries it, A carries the
      // pre-change snapshot but ENTERS after B (worst case for attempt-order
      // detection alone).
      (service as any).accountManager = { getAccount: () => REV_B_ACCOUNT };

      const resultB = await service.sendEmail(account.id, REV_B_ACCOUNT, composer as any);
      expect(resultB.sent).toBe(true);
      expect(made.length).toBe(1);

      // A enters last with the stale snapshot: attempt-order comparison sees
      // its own record, but the live-record comparison rejects it.
      await expect(service.sendEmail(account.id, account, composer as any)).rejects.toBeInstanceOf(SafeSendPreflightError);
      expect(made[1]!.sendMail).not.toHaveBeenCalled();
      expect(made[1]!.close).toHaveBeenCalledTimes(1);
      expect((service as any).transporters.size).toBe(0);
    });

    it('T20R-VERIFY-FAIL-CLEANUP: a failed verify closes its own transport and registers nothing', async () => {
      service = new SmtpService();
      (service as any).authResolver = {
        resolve: vi.fn(async () => ({ kind: 'password' as const, user: 'sender@synth.test', password: SYNTHETIC_PASSWORD })),
      };
      const t = {
        verify: vi.fn(async () => { throw new Error('connection refused'); }),
        sendMail: vi.fn(async () => ({ messageId: '<m@synth.test>', accepted: [...ACCEPTED], rejected: [], response: '250 OK' })),
        close: vi.fn(),
      };
      vi.spyOn(nodemailer, 'createTransport').mockImplementation(() => t as any);

      await expect(service.sendEmail(account.id, account, composer as any)).rejects.toBeInstanceOf(SafeSendPreflightError);
      expect(t.close).toHaveBeenCalledTimes(1);
      expect(t.sendMail).not.toHaveBeenCalled();
      expect((service as any).transporters.size).toBe(0);
    });
  });
});
