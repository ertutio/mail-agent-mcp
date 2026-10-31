import { describe, expect, it, vi } from 'vitest';
import { SmtpService } from '../src/services/smtp-service.js';
import { SafeSendService } from '../src/services/safe-send-service.js';
import { safeSendTools } from '../src/tools/safe-send-tools.js';
import nodemailer from 'nodemailer';

const SYNTHETIC_PASSWORD = ['synthetic', 'password'].join('-');
const SYNTHETIC_ACCESS_TOKEN_A = ['synthetic', 'access', 'one'].join('-');
const SYNTHETIC_ACCESS_TOKEN_B = ['synthetic', 'access', 'two'].join('-');

const account = { id: 'delivery-fixture', name: 'Synthetic', host: 'imap.example.test', port: 993, tls: true, user: 'sender@example.test', password: '', saveToSent: true };
const recipients = ['accepted@example.test', 'rejected@example.test'];

function harness(outcome: () => Promise<unknown>) {
  const currentAccount = { ...account, smtp: { host: 'smtp.example.test', port: 465, secure: true } };
  const smtp = new SmtpService();
  const sendMail = vi.fn(outcome);
  vi.spyOn(smtp, 'createTransporter').mockResolvedValue({ sendMail } as any);
  const handlers = new Map<string, Function>();
  const imap = { appendToSentFolder: vi.fn(async () => ({ saved: true })) };
  safeSendTools({ registerTool: (name: string, _schema: unknown, handler: Function) => handlers.set(name, handler) } as any,
    imap as any, { resolveAccountId: () => account.id, getAccount: async () => currentAccount } as any, smtp);
  const call = async (name: string, input: unknown) => JSON.parse((await handlers.get(name)!(input)).content[0].text);
  return { smtp, sendMail, imap, call, account: currentAccount };
}

describe('T21 production preview/confirm receipts', () => {
  it.each([
    ['sent', { accepted: recipients, rejected: [] }, { accepted: recipients, rejected: [], unknown: [] }],
    ['partial', { accepted: [recipients[0]], rejected: [recipients[1]] }, { accepted: [recipients[0]], rejected: [recipients[1]], unknown: [] }],
    ['rejected', { accepted: [], rejected: recipients }, { accepted: [], rejected: recipients, unknown: [] }],
    ['ambiguous', {}, { accepted: [], rejected: [], unknown: recipients }],
    ['ambiguous', { accepted: [recipients[0]], rejected: [] }, { accepted: [recipients[0]], rejected: [], unknown: [recipients[1]] }],
  ])('T21-RECEIPT-%s retains per-recipient outcomes and concurrent dedup', async (status, info, receipt) => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const h = harness(async () => { await gate; return { messageId: '<transport@example.test>', ...info }; });
    const preview = await h.call('imap_preview_send_email', { to: recipients, subject: 'Synthetic receipt', text: 'Synthetic body' });
    const first = h.call('imap_confirm_send', { draftId: preview.draftId, confirmed: true });
    const concurrent = h.call('imap_confirm_send', { draftId: preview.draftId, confirmed: true });
    release();
    const result = await first;
    const duplicate = await concurrent;
    expect(result).toMatchObject({ status, receipt });
    expect(duplicate).toMatchObject({ status: status === 'sent' ? 'already_sent' : status, receipt });
    expect(await h.call('imap_confirm_send', { draftId: preview.draftId, confirmed: true })).toMatchObject({ status: status === 'sent' ? 'already_sent' : status, receipt });
    expect(h.sendMail).toHaveBeenCalledTimes(1);
    if (status === 'rejected') expect(h.imap.appendToSentFolder).not.toHaveBeenCalled();
  });

  it('T21-THROWN-RCPT recognizes explicit all-recipient rejection without exposing provider response', async () => {
    const h = harness(async () => { throw Object.assign(new Error('PRIVATE provider body'), { code: 'EENVELOPE', command: 'RCPT TO', rejected: recipients, responseCode: 550 }); });
    const preview = await h.call('imap_preview_send_email', { to: recipients, subject: 'Synthetic', text: 'body' });
    const result = await h.call('imap_confirm_send', { draftId: preview.draftId, confirmed: true });
    expect(result).toMatchObject({ status: 'rejected', receipt: { accepted: [], rejected: recipients, unknown: [] } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    await h.call('imap_confirm_send', { draftId: preview.draftId, confirmed: true });
    expect(h.sendMail).toHaveBeenCalledTimes(1);
  });

  it('T21-VOID never treats a missing executor receipt as acceptance', async () => {
    const executor = vi.fn(async () => undefined);
    const service = new SafeSendService({ executor });
    const { draftId } = service.preview({ accountId: account.id, composer: { from: account.user, to: recipients, subject: 'Synthetic' } });
    expect(await service.confirm(draftId, true)).toMatchObject({ status: 'ambiguous', receipt: { accepted: [], rejected: [], unknown: recipients } });
    expect(await service.confirm(draftId, true)).toMatchObject({ status: 'ambiguous' });
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('T21-CASE-DISTINCT never accepts an unreported case-distinct localpart', async () => {
    const h = harness(async () => ({ accepted: ['Case@example.test'], rejected: [] }));
    const preview = await h.call('imap_preview_send_email', { to: ['Case@EXAMPLE.test', 'case@example.test', 'Case@example.test'], subject: 'Synthetic case-distinct receipt', text: 'body' });
    const result = await h.call('imap_confirm_send', { draftId: preview.draftId, confirmed: true });
    expect(result).toMatchObject({ status: 'ambiguous', receipt: { accepted: ['Case@EXAMPLE.test'], rejected: [], unknown: ['case@example.test'] } });
    expect(h.sendMail).toHaveBeenCalledWith(expect.objectContaining({ envelope: { from: account.user, to: ['Case@EXAMPLE.test', 'case@example.test'] } }));
    await h.call('imap_confirm_send', { draftId: preview.draftId, confirmed: true });
    expect(h.sendMail).toHaveBeenCalledTimes(1);
  });

  it('T13-SEND-COMPOSE revalidates the preview revision immediately before SMTP submission', async () => {
    const h = harness(async () => ({ accepted: recipients, rejected: [] }));
    const originalCompose = h.smtp.composeRaw.bind(h.smtp);
    vi.spyOn(h.smtp, 'composeRaw').mockImplementation(async (...args) => {
      const raw = await originalCompose(...args);
      h.account.smtp.host = 'changed.example.test';
      return raw;
    });
    const preview = await h.call('imap_preview_send_email', { to: recipients, subject: 'Synthetic', text: 'body' });
    await expect(h.call('imap_confirm_send', { draftId: preview.draftId, confirmed: true })).rejects.toThrow(/account.*changed|new preview/i);
    expect(h.sendMail).not.toHaveBeenCalled();
  });

  it('T20-AUTH-REFRESH resolves credentials and transport again for each SMTP attempt', async () => {
    const resolve = vi.fn().mockResolvedValueOnce({ kind: 'oauth2', user: account.user, accessToken: SYNTHETIC_ACCESS_TOKEN_A })
      .mockResolvedValueOnce({ kind: 'oauth2', user: account.user, accessToken: SYNTHETIC_ACCESS_TOKEN_B });
    const transports: any[] = [];
    const create = vi.spyOn(nodemailer, 'createTransport').mockImplementation((options: any) => {
      const transport = { verify: vi.fn(async () => true), close: vi.fn(), options };
      transports.push(transport);
      return transport as any;
    });
    try {
      const smtp = new SmtpService({ resolve } as any);
      const synthetic = { ...account, password: SYNTHETIC_PASSWORD, smtp: { host: 'smtp-one.example.test', port: 465, secure: true } };
      await smtp.createTransporter(synthetic);
      synthetic.smtp.host = 'smtp-two.example.test';
      await smtp.createTransporter(synthetic);
      expect(resolve).toHaveBeenCalledTimes(2);
      expect(transports[1].options.host).toBe('smtp-two.example.test');
      expect(transports[1].options.auth.accessToken).toBe('synthetic-access-two');
      smtp.disconnectAll();
    } finally { create.mockRestore(); }
  });

  it('T20-PROBE-CLEANUP verifies once and closes its own transport without retaining it', async () => {
    const transport = { verify: vi.fn(async () => true), close: vi.fn() };
    const create = vi.spyOn(nodemailer, 'createTransport').mockReturnValue(transport as any);
    const smtp = new SmtpService({ resolve: vi.fn(async () => ({ kind: 'password', user: account.user, password: SYNTHETIC_PASSWORD })) } as any);
    try {
      expect(await smtp.verifySmtpConnection({ ...account, password: SYNTHETIC_PASSWORD })).toBe(true);
      expect(transport.verify).toHaveBeenCalledTimes(1);
      expect(transport.close).toHaveBeenCalledTimes(1);
      expect((smtp as any).transporters.size).toBe(0);
    } finally { smtp.disconnectAll(); create.mockRestore(); }
  });
});
