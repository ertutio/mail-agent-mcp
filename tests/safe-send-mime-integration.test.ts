import { describe, expect, it, vi } from 'vitest';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { ImapService } from '../src/services/imap-service.js';
import { SmtpService } from '../src/services/smtp-service.js';
import { safeSendTools } from '../src/tools/safe-send-tools.js';

const original = Buffer.from([
  'From: "Author, One" <author@example.test>',
  'Reply-To: "Reply, One" <reply1@example.test>, Reply Two <reply2@example.test>',
  'To: Me <me@example.test>, "Peer, One" <peer@example.test>',
  'Cc: Copy <copy@example.test>, REPLY1@example.test, ME@example.test',
  'Message-ID: <original@example.test>',
  'Date: Wed, 21 Oct 2026 10:00:00 +0000',
  'Subject: Synthetic <header> & subject',
  'MIME-Version: 1.0',
  'Content-Type: multipart/related; boundary="fixture"',
  '', '--fixture', 'Content-Type: text/html; charset=utf-8', '',
  '<p>中文 original &amp; text</p><img src="cid:image-fixture">',
  '--fixture', 'Content-Type: image/png', 'Content-ID: <image-fixture>',
  'Content-Disposition: inline; filename="pixel.png"', 'Content-Transfer-Encoding: base64', '', 'c3ludGhldGljLWltYWdl',
  '--fixture--', '',
].join('\r\n'));

async function harness() {
  const imap = new ImapService();
  const client = {
    // T25: the forward chain binds reads to the mailbox UIDVALIDITY captured
    // at the original read, so the fake client must expose it (fail-closed).
    mailbox: { uidValidity: 4242n } as any,
    status: vi.fn(async () => ({ uidValidity: 4242n })),
    getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
    fetchOne: vi.fn(async () => ({ source: original, flags: new Set(), size: original.length })),
  };
  // Only protocol I/O is substituted: actual getEmailContent and mailparser are exercised.
  vi.spyOn(imap as any, 'ensureConnected').mockResolvedValue(client);
  const copies: Buffer[] = [];
  vi.spyOn(imap, 'appendToSentFolder').mockImplementation(async (_id, raw) => { copies.push(Buffer.from(raw)); return { saved: true }; });
  const smtp = new SmtpService();
  const stream = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
  let submitted: any;
  let streamed: any;
  vi.spyOn(smtp, 'createTransporter').mockResolvedValue({ sendMail: async (options: any) => { submitted = options; streamed = await stream.sendMail(options); return streamed; } } as any);
  let returned: any;
  const actualSend = smtp.sendEmail.bind(smtp);
  vi.spyOn(smtp, 'sendEmail').mockImplementation(async (...args) => { returned = await actualSend(...args); return returned; });
  const handlers = new Map<string, Function>();
  const account = { id: 'mime-fixture', name: 'Synthetic', host: 'imap.example.test', port: 993, tls: true, user: 'me@example.test', password: '', defaultBcc: ['audit@example.test'] };
  // Mirror the real AccountManager shape: getAccount is synchronous, and the
  // ImapService learns the manager so getAccountRevision resolves revisions.
  const manager = { resolveAccountId: () => account.id, getAccount: () => account } as any;
  imap.setAccountManager(manager);
  safeSendTools({ registerTool: (name: string, _schema: unknown, handler: Function) => handlers.set(name, handler) } as any,
    imap, manager, smtp);
  const call = async (name: string, input: unknown) => JSON.parse((await handlers.get(name)!(input)).content[0].text);
  return { imap, call, copies, snapshot: () => ({ submitted, streamed, returned }) };
}

describe('T22/T23/T24 real MIME through production safe-send tools', () => {
  it('T23-REAL-CONSUMER reply-all expands multiple Reply-To/To/Cc and excludes self', async () => {
    const h = await harness();
    const preview = await h.call('imap_preview_reply_to_email', { folder: 'INBOX', uid: 42, replyAll: true, text: 'Synthetic reply' });
    expect(preview.summary.to).toEqual(['reply1@example.test', 'reply2@example.test', 'peer@example.test']);
    expect(preview.summary.cc).toEqual(['copy@example.test', 'REPLY1@example.test', 'ME@example.test']);
    await h.call('imap_confirm_send', { draftId: preview.draftId, confirmed: true });
    const { submitted } = h.snapshot();
    const parsed = await simpleParser(submitted.raw);
    expect(parsed.inReplyTo).toBe('<original@example.test>');
    expect([parsed.to].flat().flatMap(group => group?.value.map(address => address.address) ?? [])).toEqual(preview.summary.to);
    expect([parsed.cc].flat().flatMap(group => group?.value.map(address => address.address) ?? [])).toEqual(preview.summary.cc);
    expect([parsed.references].flat()).toEqual(['<original@example.test>']);
    expect(submitted.envelope.to).toEqual(['reply1@example.test', 'reply2@example.test', 'peer@example.test', 'copy@example.test', 'REPLY1@example.test', 'ME@example.test', 'audit@example.test']);
  });

  it('T24-REAL-HTML-ONLY forward preserves readable body/note/escaped headers in both views and CID bytes', async () => {
    const h = await harness();
    const preview = await h.call('imap_preview_forward_email', { folder: 'INBOX', uid: 42, to: 'reader@example.test', text: '附言 <note> & literal', includeAttachments: true });
    await h.call('imap_confirm_send', { draftId: preview.draftId, confirmed: true });
    const parsed = await simpleParser(h.snapshot().submitted.raw, { keepCidLinks: true });
    expect(parsed.text).toContain('附言 <note> & literal');
    expect(parsed.text).toContain('中文 original');
    expect(parsed.text).toContain('Synthetic <header> & subject');
    expect(parsed.html).toContain('附言 &lt;note&gt; &amp; literal');
    expect(parsed.html).toContain('Synthetic &lt;header&gt; &amp; subject');
    expect(parsed.html).toContain('cid:image-fixture');
    expect(parsed.attachments[0].content.toString()).toBe('synthetic-image');
  });

  it('T22-REAL-STREAM frozen raw/Message-ID/Sent and To/Cc/Bcc envelope match', async () => {
    const h = await harness();
    const preview = await h.call('imap_preview_send_email', { to: '"To, One" <CaseSensitive@example.test>, to2@example.test', cc: ['CopyCase@example.test'], bcc: ['BlindCase@example.test'], subject: 'Synthetic', text: 'body' });
    const result = await h.call('imap_confirm_send', { draftId: preview.draftId, confirmed: true });
    const { submitted, streamed, returned } = h.snapshot();
    const parsed = await simpleParser(submitted.raw);
    expect(submitted.envelope).toEqual({ from: 'me@example.test', to: ['CaseSensitive@example.test', 'to2@example.test', 'CopyCase@example.test', 'audit@example.test', 'BlindCase@example.test'] });
    expect(submitted.raw.toString()).not.toMatch(/^bcc:/im);
    expect(returned.messageId).toBe(parsed.messageId);
    expect(streamed.messageId).toBe(parsed.messageId);
    expect(streamed.message.equals(submitted.raw)).toBe(true);
    expect(h.copies[0].equals(submitted.raw)).toBe(true);
    // streamTransport is not an SMTP acceptance assertion.
    expect(result.status).toBe('ambiguous');
  });
});
