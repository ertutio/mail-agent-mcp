import { describe, it, expect, vi, beforeEach } from 'vitest';
import { emailTools } from '../src/tools/email-tools.js';

// T24 / MAIL-05: the forward's HTML view must carry the same user note and
// forwarded-message header as the text view (safely escaped), keep cid:
// references intact, and stay absent when the original has no HTML part.
//   T24-HTML-VIEW-COMPLETE — note + header + original HTML, text unchanged
//   T24-ESCAPE — hostile note/from content is escaped in the HTML view
//   T24-CHINESE — non-ASCII notes survive both views
//   T24-CID-KEPT — original cid: references are not rewritten
//   T24-TEXT-ONLY-ORIGINAL — no htmlContent → no HTML part, complete text

const mockServer = {
  registerTool: vi.fn((name: string, _schema: any, handler: Function) => {
    toolHandlers[name] = handler;
  }),
};

const toolHandlers: Record<string, Function> = {};

const mockImapService = {
  getEmailContent: vi.fn(),
  appendToSentFolder: vi.fn(async () => ({ saved: false, errorCategory: 'folder_not_found', error: 'unused' })),
};
const mockSmtpService = { sendEmail: vi.fn() };
const mockAccountManager = { resolveAccountId: (id: string) => id, getAccount: async () => ACCOUNT };

const ACCOUNT = {
  id: 'acc1', name: 'T24', host: 'smtp.synth.test', port: 465,
  user: 'sender@synth.test', password: 'unused', tls: true,
  email: 'sender@synth.test',
};

const ORIGINAL = {
  uid: 7,
  from: 'Origin <origin@synth.test>',
  date: new Date('2026-01-15T10:00:00Z'),
  subject: 'Original subject',
  to: ['first@synth.test', 'second@synth.test'],
  messageId: '<original@synth.test>',
  textContent: 'original plain body',
  htmlContent: '<html><body>original html body 中文 <img src="cid:img1"></body></html>',
};

describe('T24: forward HTML/text views stay consistent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockImapService.getEmailContent.mockResolvedValue(ORIGINAL);
    mockSmtpService.sendEmail.mockResolvedValue({ messageId: '<sent@synth.test>', rawMessage: Buffer.from('raw') });
    emailTools(mockServer as any, mockImapService as any, mockAccountManager as any, mockSmtpService as any);
  });

  const forward = async (extra: Record<string, unknown> = {}) => {
    await toolHandlers.imap_forward_email({
      accountId: 'acc1', folder: 'INBOX', uid: 7, to: 'dest@synth.test', ...extra,
    });
    expect(mockSmtpService.sendEmail).toHaveBeenCalledOnce();
    return mockSmtpService.sendEmail.mock.calls[0]![2] as any;
  };

  it('T24-HTML-VIEW-COMPLETE: the HTML view carries note, header and original HTML', async () => {
    const composer = await forward({ text: 'please review' });

    expect(composer.text).toContain('please review');
    expect(composer.text).toContain('---------- Forwarded message ----------');
    expect(composer.text).toContain('original plain body');

    expect(composer.html).toContain('please review');
    expect(composer.html).toContain('---------- Forwarded message ----------');
    expect(composer.html).toContain('Origin &lt;origin@synth.test&gt;');
    expect(composer.html).toContain('Original subject');
    expect(composer.html).toContain('first@synth.test, second@synth.test');
    expect(composer.html).toContain('original html body 中文 <img src="cid:img1">');
  });

  it('T24-ESCAPE: hostile note and header values are escaped in the HTML view', async () => {
    const composer = await forward({ text: '<script>alert(1)</script>' });

    expect(composer.html).not.toContain('<script>');
    expect(composer.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('T24-CHINESE: non-ASCII notes survive both views', async () => {
    const composer = await forward({ text: '请查收，谢谢' });

    expect(composer.text).toContain('请查收，谢谢');
    expect(composer.html).toContain('请查收，谢谢');
  });

  it('T24-CID-KEPT: original cid: references are kept verbatim', async () => {
    const composer = await forward({ text: 'see attached' });

    expect(composer.html).toContain('src="cid:img1"');
  });

  it('T24-TEXT-ONLY-ORIGINAL: no htmlContent means no HTML part', async () => {
    mockImapService.getEmailContent.mockResolvedValue({ ...ORIGINAL, htmlContent: undefined });

    const composer = await forward({ text: 'note' });

    expect(composer.html).toBeUndefined();
    expect(composer.text).toContain('note');
    expect(composer.text).toContain('original plain body');
  });
});
