import { describe, expect, it, vi } from 'vitest';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { ImapService } from '../src/services/imap-service.js';
import { SmtpService } from '../src/services/smtp-service.js';
import { safeSendTools } from '../src/tools/safe-send-tools.js';

async function harness(headers: string[], defaultBcc: string | string[] = ['audit@example.test']) {
  const source = Buffer.from([...headers, 'Message-ID: <audit-original@example.test>', 'Date: Wed, 21 Oct 2026 10:00:00 +0000', 'Subject: Synthetic audit fixture', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', 'Synthetic original body', ''].join('\r\n'));
  const imap = new ImapService();
  const client = { getMailboxLock: vi.fn(async () => ({ release: vi.fn() })), fetchOne: vi.fn(async () => ({ source, size: source.length, flags: new Set() })) };
  // Exercise the actual MIME consumer; replace only synthetic protocol I/O.
  vi.spyOn(imap as any, 'ensureConnected').mockResolvedValue(client);
  const copies: Buffer[] = [];
  vi.spyOn(imap, 'appendToSentFolder').mockImplementation(async (_id, raw) => { copies.push(Buffer.from(raw)); return { saved: true }; });
  const smtp = new SmtpService();
  const stream = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
  const submitted: any[] = [];
  vi.spyOn(smtp, 'createTransporter').mockResolvedValue({ sendMail: async (options: any) => {
    submitted.push(options);
    const streamed = await stream.sendMail(options);
    // Synthetic SMTP acceptance, independent of streamTransport serialization.
    return { ...streamed, accepted: [...options.envelope.to], rejected: [] };
  } } as any);
  const account = { id: 'audit-fixture', name: 'Synthetic', host: 'imap.example.test', port: 993, tls: true, user: 'Self@example.test', password: '', defaultBcc };
  const handlers = new Map<string, Function>();
  safeSendTools({ registerTool: (name: string, _schema: unknown, handler: Function) => handlers.set(name, handler) } as any,
    imap, { resolveAccountId: () => account.id, getAccount: async () => account } as any, smtp);
  const call = async (name: string, input: unknown) => JSON.parse((await handlers.get(name)!(input)).content[0].text);
  return { call, submitted, copies };
}

function values(value: any): string[] {
  return [value].flat().flatMap(group => group?.value?.map((item: any) => item.address) ?? []);
}

describe('independent audit regressions through production preview/confirm', () => {
  it('AUDIT-REPLY-IDENTITY retains case-distinct Reply-To, To and self localparts', async () => {
    const h = await harness(['From: Author <author@example.test>', 'Reply-To: Alice@example.test', 'To: Self@example.test, self@example.test, alice@example.test']);
    const preview = await h.call('imap_preview_reply_to_email', { folder: 'INBOX', uid: 9, replyAll: true, text: 'Synthetic reply' });
    expect(preview.summary.to).toEqual(['Alice@example.test', 'self@example.test', 'alice@example.test']);
    const confirmed = await h.call('imap_confirm_send', { draftId: preview.draftId, confirmed: true });
    const parsed = await simpleParser(h.submitted[0].raw);
    expect(values(parsed.to)).toEqual(['Alice@example.test', 'self@example.test', 'alice@example.test']);
    expect(h.submitted[0].envelope.to).toEqual(['Alice@example.test', 'self@example.test', 'alice@example.test', 'audit@example.test']);
    expect(confirmed).toMatchObject({ status: 'sent', receipt: { accepted: h.submitted[0].envelope.to, rejected: [], unknown: [] } });
  });

  it('AUDIT-REPLY-CC preserves original To/Cc categories and default Bcc on the wire', async () => {
    const h = await harness(['From: Author <author@example.test>', 'Reply-To: reply@example.test', 'To: Self@example.test, peer@example.test', 'Cc: Copy@example.test, reply@EXAMPLE.test']);
    const preview = await h.call('imap_preview_reply_to_email', { folder: 'INBOX', uid: 9, replyAll: true, text: 'Synthetic reply' });
    expect(preview.summary.to).toEqual(['reply@example.test', 'peer@example.test']);
    expect(preview.summary.cc).toEqual(['Copy@example.test']);
    expect(preview.summary.bccCount).toBe(1);
    await h.call('imap_confirm_send', { draftId: preview.draftId, confirmed: true });
    const parsed = await simpleParser(h.submitted[0].raw);
    expect(values(parsed.to)).toEqual(['reply@example.test', 'peer@example.test']);
    expect(values(parsed.cc)).toEqual(['Copy@example.test']);
    expect(h.submitted[0].envelope.to).toEqual(['reply@example.test', 'peer@example.test', 'Copy@example.test', 'audit@example.test']);
    expect(parsed.inReplyTo).toBe('<audit-original@example.test>');
  });

  it('AUDIT-SERIALIZED freezes the same To/Cc/Bcc recipients used by MIME, SMTP and receipt', async () => {
    const h = await harness(['From: author@example.test', 'To: Self@example.test'], ' ["audit@example.test","OtherAudit@example.test"] ');
    const preview = await h.call('imap_preview_send_email', { to: ' ["One@example.test","two@example.test"] ', cc: ' ["Copy@example.test"] ', bcc: ' ["Blind@example.test","audit@example.test"] ', subject: 'Synthetic serialized fixture', text: 'Synthetic body' });
    expect(preview.summary.to).toEqual(['One@example.test', 'two@example.test']);
    expect(preview.summary.cc).toEqual(['Copy@example.test']);
    expect(preview.summary.bccCount).toBe(3);
    const confirmed = await h.call('imap_confirm_send', { draftId: preview.draftId, confirmed: true });
    const expected = [...preview.summary.to, ...preview.summary.cc, 'audit@example.test', 'OtherAudit@example.test', 'Blind@example.test'];
    expect(h.submitted[0].envelope.to).toEqual(expected);
    const parsed = await simpleParser(h.submitted[0].raw);
    expect(values(parsed.to)).toEqual(preview.summary.to);
    expect(values(parsed.cc)).toEqual(preview.summary.cc);
    expect(h.submitted[0].raw.toString()).not.toMatch(/^bcc:/im);
    expect(h.copies[0].equals(h.submitted[0].raw)).toBe(true);
    expect(confirmed).toMatchObject({ status: 'sent', receipt: { accepted: expected, rejected: [], unknown: [] } });
    const repeated = await h.call('imap_confirm_send', { draftId: preview.draftId, confirmed: true });
    expect(repeated).toMatchObject({ status: 'already_sent', alreadyConfirmed: true, receipt: confirmed.receipt });
    expect(h.submitted).toHaveLength(1);
  });
});
