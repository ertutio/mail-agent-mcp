import { describe, it, expect, vi, beforeEach } from 'vitest';
import { emailTools } from '../src/tools/email-tools.js';

// T23 / MAIL-04: replies prefer the Reply-To address, and reply-all covers
// the full recipient set (Reply-To + original To + original Cc) minus our
// own address, deduplicated by address.
//   T23-REPLY-TO-PREFERRED — a Reply-To header wins over From
//   T23-REPLY-ALL-COMPLETE — reply-all includes To and Cc, excludes self
//   T23-NO-REPLY-TO-FALLBACK — without Reply-To the reply goes to From
//   T23-DEDUP — duplicates (and self) never appear twice
//   T23-THREADING — In-Reply-To/References preserved

const mockServer = {
  registerTool: vi.fn((name: string, _schema: any, handler: Function) => {
    toolHandlers[name] = handler;
  }),
};

const toolHandlers: Record<string, Function> = {};

const ACCOUNT = {
  id: 'acc1', name: 'T23', host: 'smtp.synth.test', port: 465,
  user: 'sender@synth.test', password: 'unused', tls: true,
  email: 'me@self.test',
};

const originalWith = (overrides: Record<string, unknown> = {}) => ({
  uid: 7,
  from: 'Bob <bob@from.test>',
  date: new Date('2026-01-15T10:00:00Z'),
  subject: 'Original subject',
  to: ['Me <me@self.test>', 'Other <other@t.test>'],
  cc: ['Cc1 <cc1@t.test>', 'Cc2 <cc2@t.test>'],
  messageId: '<original@synth.test>',
  textContent: 'original plain body',
  headers: {
    'message-id': '<original@synth.test>',
  },
  ...overrides,
});

describe('T23: reply address model', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const setup = (original: Record<string, unknown>) => {
    const mockImapService = {
      getEmailContent: vi.fn(async () => original),
      appendToSentFolder: vi.fn(async () => ({ saved: false, errorCategory: 'folder_not_found', error: 'unused' })),
    };
    const mockSmtpService = { sendEmail: vi.fn(async () => ({ messageId: '<sent@synth.test>', rawMessage: Buffer.from('raw') })) };
    emailTools(
      mockServer as any,
      mockImapService as any,
      { resolveAccountId: (id: string) => id, getAccount: async () => ACCOUNT } as any,
      mockSmtpService as any,
    );
    return { mockSmtpService, mockImapService };
  };

  const reply = async (mockSmtpService: any, args: Record<string, unknown> = {}) => {
    await toolHandlers.imap_reply_to_email({ accountId: 'acc1', folder: 'INBOX', uid: 7, ...args });
    expect(mockSmtpService.sendEmail).toHaveBeenCalledOnce();
    return mockSmtpService.sendEmail.mock.calls[0]![2] as any;
  };

  it('T23-REPLY-TO-PREFERRED: a Reply-To header wins over From', async () => {
    const { mockSmtpService } = setup(originalWith({
      headers: { 'message-id': '<original@synth.test>', 'reply-to': 'Alice <reply-to@rt.test>' },
    }));

    const composer = await reply(mockSmtpService);

    expect(composer.to).toEqual(['Alice <reply-to@rt.test>']);
  });

  it('T23-REPLY-ALL-COMPLETE: reply-all covers Reply-To + To + Cc minus self', async () => {
    const { mockSmtpService } = setup(originalWith({
      headers: { 'message-id': '<original@synth.test>', 'reply-to': 'Alice <reply-to@rt.test>' },
    }));

    const composer = await reply(mockSmtpService, { replyAll: true });

    expect(composer.to).toEqual(['Alice <reply-to@rt.test>', 'Other <other@t.test>']);
    expect(composer.cc).toEqual(['Cc1 <cc1@t.test>', 'Cc2 <cc2@t.test>']);
  });

  it('T23-NO-REPLY-TO-FALLBACK: without Reply-To the reply goes to From', async () => {
    const { mockSmtpService } = setup(originalWith());

    const composer = await reply(mockSmtpService);

    expect(composer.to).toEqual(['Bob <bob@from.test>']);
    expect(composer.subject).toBe('Re: Original subject');
  });

  it('T23-DEDUP: repeated and self addresses never appear twice', async () => {
    const { mockSmtpService } = setup(originalWith({
      to: ['Me <me@self.test>', 'Other <other@t.test>', 'other@t.test'],
    }));

    const composer = await reply(mockSmtpService, { replyAll: true });

    const flat = [...composer.to, ...(composer.cc ?? [])].map((v: string) => v.toLowerCase());
    expect(flat.filter((v: string) => v.includes('other@t.test'))).toHaveLength(1);
    expect(flat.some((v: string) => v.includes('me@self.test'))).toBe(false);
  });

  it('T23-THREADING: In-Reply-To and References are preserved', async () => {
    const { mockSmtpService } = setup(originalWith());

    const composer = await reply(mockSmtpService);

    expect(composer.inReplyTo).toBe('<original@synth.test>');
    expect(composer.references).toBe('<original@synth.test>');
  });

  // T23 review: the address model must hold against a REAL mailparser parse
  // of a synthetic MIME — not just hand-built objects.
  it('T23R-REAL-MIME: structured Reply-To/To/Cc expand from a real parsed MIME', async () => {
    const { simpleParser } = await import('mailparser');
    const mime = [
      'From: Bob <bob@from.test>',
      'Reply-To: Alice <reply-to@rt.test>',
      'To: Me <me@self.test>, Other <other@t.test>',
      'Cc: Cc1 <cc1@t.test>, Cc2 <cc2@t.test>',
      'Subject: Original subject',
      'Message-ID: <original@synth.test>',
      'Date: Thu, 15 Jan 2026 10:00:00 +0000',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'original plain body',
      '',
    ].join('\r\n');
    const parsed = await simpleParser(mime);
    expect(parsed.cc).toBeDefined(); // the real parser sees the Cc header

    const formatAddressList = (list: any): string[] =>
      (list?.value ?? []).map((v: any) => (v.name ? v.name + ' <' + v.address + '>' : v.address));
    const mockImapService = {
      getEmailContent: vi.fn(async () => ({
        uid: 7,
        from: parsed.from?.text ?? '',
        date: parsed.date ?? new Date(),
        subject: parsed.subject ?? '',
        to: formatAddressList(parsed.to),
        cc: formatAddressList(parsed.cc),
        messageId: parsed.messageId ?? '',
        textContent: parsed.text ?? '',
        headers: { 'message-id': parsed.messageId ?? '', 'reply-to': (parsed.headers.get('reply-to') as any)?.text ?? String(parsed.headers.get('reply-to') ?? '') },
      })),
      appendToSentFolder: vi.fn(async () => ({ saved: false, errorCategory: 'folder_not_found', error: 'unused' })),
    };
    const mockSmtpService = { sendEmail: vi.fn(async () => ({ messageId: '<sent@synth.test>', rawMessage: Buffer.from('raw') })) };
    emailTools(
      mockServer as any,
      mockImapService as any,
      { resolveAccountId: (id: string) => id, getAccount: async () => ACCOUNT } as any,
      mockSmtpService as any,
    );

    await toolHandlers.imap_reply_to_email({ accountId: 'acc1', folder: 'INBOX', uid: 7, replyAll: true });
    expect(mockSmtpService.sendEmail).toHaveBeenCalledOnce();
    const composer = mockSmtpService.sendEmail.mock.calls[0]![2] as any;

    // mailparser may quote names containing special characters; assert the
    // ADDRESS content, which is what routing depends on.
    const bare = (v: string) => (v.match(/<([^>]+)>/) ?? [])[1] ?? v;
    expect(composer.to.map(bare)).toEqual(['reply-to@rt.test', 'other@t.test']);
    expect(composer.cc.map(bare)).toEqual(['cc1@t.test', 'cc2@t.test']);
    // The sender's own address must not appear as a RECIPIENT (it appears
    // once as the From field).
    const recipients = JSON.stringify([...composer.to, ...(composer.cc ?? [])]);
    expect(recipients).not.toContain('me@self.test');
    expect(composer.inReplyTo).toBe('<original@synth.test>');
  });
});
