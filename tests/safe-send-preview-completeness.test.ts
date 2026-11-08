import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { SafeSendService } from '../src/services/safe-send-service.js';
import { safeSendTools } from '../src/tools/safe-send-tools.js';
import { composerRecipients, deliveryReceipt } from '../src/utils/mail-compose.js';

// F1: the frozen preview must show what confirmation will submit — the
// actual frozen body (display-truncated with an explicit range when cut),
// the full To/Cc/Bcc address lists, Reply-To, and per-attachment name,
// type, size and content digest. The preview is computed from the frozen
// payload, and confirming submits exactly those bytes.

const sha256 = (content: Buffer | string) => createHash('sha256').update(content).digest('hex');

const service = (draftId = 'draft-f1') => new SafeSendService({
  executor: () => ({}),
  clock: () => 1_000,
  ttlMs: 60_000,
  id: () => draftId,
});

describe('F1: preview exposes the frozen content completely', () => {
  it('F1-PREVIEW-FIELDS: full recipients, Reply-To, body and attachment digests come from the frozen payload', () => {
    const contentA = Buffer.from('F1-ATTACHMENT-AAA-BYTES');
    const contentB = Buffer.from('F1-ATTACHMENT-BBB-BYTES');
    const svc = service();
    const preview = svc.preview({
      accountId: 'acc-1',
      accountRevision: '0123456789abcdef',
      composer: {
        from: 'me@synth.test',
        to: ['to1@synth.test', 'to2@synth.test'],
        cc: ['cc1@synth.test'],
        bcc: ['bcc1@synth.test', 'bcc2@synth.test'],
        replyTo: 'replies@synth.test',
        subject: 'F1 subject',
        text: 'F1 frozen body',
        html: '<p>F1 frozen body</p>',
        attachments: [
          { filename: 'a.bin', content: contentA, contentType: 'application/octet-stream' },
          { filename: 'b.txt', content: contentB, contentType: 'text/plain' },
        ],
      },
    });

    expect(preview.summary.to).toEqual(['to1@synth.test', 'to2@synth.test']);
    expect(preview.summary.cc).toEqual(['cc1@synth.test']);
    // Full Bcc list, not only a count.
    expect(preview.summary.bcc).toEqual(['bcc1@synth.test', 'bcc2@synth.test']);
    expect(preview.summary.replyTo).toBe('replies@synth.test');
    expect(preview.summary.text).toBe('F1 frozen body');
    expect(preview.summary.html).toBe('<p>F1 frozen body</p>');
    expect(preview.summary.bodyTruncated).toBeUndefined();
    expect(preview.summary.attachments).toHaveLength(2);
    expect(preview.summary.attachments![0]).toMatchObject({ filename: 'a.bin', contentType: 'application/octet-stream', size: contentA.length });
    expect(preview.summary.attachments![0].sha256).toBe(sha256(contentA));
    expect(preview.summary.attachments![1].sha256).toBe(sha256(contentB));
  });

  it('F1-PREVIEW-TRUNCATION: an over-limit body view is cut with an explicit shown/total range', () => {
    const svc = service();
    const longBody = 'F1-BODY-'.repeat(1000); // 8000 chars
    const preview = svc.preview({
      accountId: 'acc-1',
      accountRevision: '0123456789abcdef',
      composer: { from: 'me@synth.test', to: 'you@synth.test', subject: 'long', text: longBody },
    });
    expect(preview.summary.bodyTruncated).toBe(true);
    expect(preview.summary.bodyTotalChars).toBe(longBody.length);
    expect(preview.summary.bodyShownChars).toBe(preview.summary.text!.length);
    expect(preview.summary.text!.length).toBeLessThan(longBody.length);
    expect(longBody.startsWith(preview.summary.text!)).toBe(true);
  });

  it('F1-PREVIEW-CONFIRM-CONSISTENCY: what the preview showed is what the confirmed send submits', async () => {
    const content = Buffer.from('F1-E2E-ATTACHMENT-BYTES-0123456789');
    const longBody = 'F1-E2E-BODY-PREFIX-'.padEnd(2600, 'x'); // over the display cap
    const captured: any[] = [];
    const smtpService = {
      sendEmail: vi.fn(async (_accountId: string, _account: unknown, composer: any) => {
        captured.push({ ...composer, attachments: composer.attachments?.map((a: any) => ({ ...a, content: Buffer.from(a.content) })) });
        return { messageId: '<f1@synth.test>', rawMessage: Buffer.from('raw'), receipt: deliveryReceipt(composerRecipients(composer), composerRecipients(composer), []) };
      }),
    };
    const account: any = {
      id: 'acc-1', name: 'Acc', host: 'imap.synth.test', port: 993, tls: true, secure: true,
      user: 'me@synth.test', email: 'me@synth.test', password: '', saveToSent: false,
      smtp: { host: 'smtp.synth.test', port: 465, secure: true },
    };
    const manager: any = { getAccount: vi.fn(async () => account), resolveAccountId: (id?: string) => id ?? 'acc-1' };
    const svc = new ImapServiceStub();
    const handlers = new Map<string, Function>();
    safeSendTools(
      { registerTool: (name: string, _def: unknown, handler: Function) => handlers.set(name, handler) } as any,
      svc as any, manager, smtpService as any,
      { id: () => 'draft-f1-e2e', clock: () => 1_000, ttlMs: 60_000 },
    );

    const preview = JSON.parse((await handlers.get('imap_preview_send_email')!({
      accountId: 'acc-1',
      to: 'to1@synth.test',
      cc: 'cc1@synth.test',
      bcc: 'bcc1@synth.test',
      replyTo: 'replies@synth.test',
      subject: 'F1 E2E',
      text: longBody,
      attachments: [{ filename: 'e2e.bin', content: content.toString('base64'), contentType: 'application/octet-stream' }],
    })).content[0].text);

    const confirmation = JSON.parse(await handlers.get('imap_confirm_send')!({ draftId: preview.draftId, confirmed: true }).then((r: any) => r.content[0].text));
    expect(confirmation.status).toBe('sent');

    const sent = captured[0];
    // The frozen body the preview displayed is the submitted body's prefix;
    // the full body matches the frozen total length.
    expect(longBody.startsWith(preview.summary.text)).toBe(true);
    expect(preview.summary.bodyTotalChars).toBe(sent.text.length);
    expect(preview.summary.to).toEqual([sent.to].flat());
    expect(preview.summary.cc).toEqual([sent.cc].flat());
    expect(preview.summary.bcc).toEqual([sent.bcc].flat());
    expect(preview.summary.replyTo).toBe(sent.replyTo);
    expect(preview.summary.attachments[0].sha256).toBe(sha256(sent.attachments[0].content));
    expect(preview.summary.attachments[0].size).toBe(sent.attachments[0].content.length);
  });
});

// Minimal ImapService stand-in: the send path never touches IMAP here.
class ImapServiceStub {
  getAccountRevision(): string { return '0123456789abcdef'; }
}
