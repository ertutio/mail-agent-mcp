import { describe, it, expect, vi } from 'vitest';
import { simpleParser } from 'mailparser';
import { SmtpService } from '../src/services/smtp-service.js';
import { emailTools } from '../src/tools/email-tools.js';

// B2: imap_save_draft reused the send-path MIME generation, which keeps Bcc
// envelope-only — the saved draft carried no Bcc header, so explicit and
// account-default BCC recipients were unrecoverable after reopening. The
// draft path composes with keepBcc so the stored MIME restores its
// recipients, while the send path keeps hiding Bcc from the wire MIME.

const account: any = {
  id: 'acc1',
  name: 'Test',
  email: 'user@example.com',
  user: 'user@example.com',
  defaultBcc: 'archive@example.com',
  saveToSent: false,
};

const headerOf = (raw: string, name: string) => {
  const headers = raw.split(/\r?\n\r?\n/)[0].split(/\r?\n/);
  const start = headers.findIndex(line => line.toUpperCase().startsWith(`${name.toUpperCase()}: `));
  if (start === -1) return '';
  const folded = [headers[start]];
  for (let i = start + 1; i < headers.length && /^[ \t]/.test(headers[i]); i++) {
    folded.push(headers[i].trim());
  }
  return folded.join(' ').slice(name.length + 2);
};

describe('B2: composeRaw draft mode keeps Bcc in the stored MIME', () => {
  it('B2-DRAFT-KEEP-BCC: keepBcc emits a Bcc header that real parsing restores', async () => {
    const smtp = new SmtpService();
    const raw = await smtp.composeRaw(account, {
      from: 'user@example.com',
      to: 'rcpt@example.com',
      subject: 'draft bcc',
      text: 'hi',
      bcc: ['extra@example.com', 'archive@example.com'],
    }, { keepBcc: true });

    expect(headerOf(raw.toString(), 'Bcc')).toContain('extra@example.com');
    expect(headerOf(raw.toString(), 'Bcc')).toContain('archive@example.com');

    const parsed = await simpleParser(raw);
    const bcc = (parsed.to as any).value.length >= 0 ? parsed.bcc : undefined;
    const addresses = (bcc?.value ?? []).map((v: any) => v.address).sort();
    expect(addresses).toEqual(['archive@example.com', 'extra@example.com']);
  });

  it('B2-SEND-DEFAULT-BCC-FREE: the send path still compiles a Bcc-free MIME', async () => {
    const smtp = new SmtpService();
    const raw = await smtp.composeRaw(account, {
      from: 'user@example.com',
      to: 'rcpt@example.com',
      subject: 'send bcc',
      text: 'hi',
      bcc: ['hidden1@synth.test', 'hidden2@synth.test'],
    });

    expect(headerOf(raw.toString(), 'Bcc')).toBe('');
  });
});

describe('B2: imap_save_draft stores explicit and default BCC recipients', () => {
  const handlers = new Map<string, Function>();
  const appended: Array<{ folder: string; raw: Buffer; flags: string[] }> = [];

  const imapService: any = {
    findDraftsFolder: vi.fn(async () => 'Drafts'),
    appendMessage: vi.fn(async (_accountId: string, folder: string, raw: Buffer, flags: string[]) => {
      appended.push({ folder, raw, flags });
      return true;
    }),
  };
  const manager: any = {
    resolveAccountId: (id?: string) => id ?? 'acc1',
    getAccount: vi.fn(async () => account),
  };
  const smtpService = new SmtpService();

  emailTools(
    { registerTool: (name: string, _def: unknown, handler: Function) => handlers.set(name, handler) } as any,
    imapService,
    manager,
    smtpService,
  );

  it('B2-DRAFT-HANDLER-MERGED-BCC: merged default+explicit Bcc is restorable from the saved draft', async () => {
    const result = JSON.parse((await handlers.get('imap_save_draft')!({
      accountId: 'acc1',
      to: 'rcpt@example.com',
      subject: 'save with bcc',
      text: 'body',
      bcc: 'extra@example.com',
    })).content[0].text);
    expect(result.success).toBe(true);

    expect(appended[0].flags).toEqual(['\\Draft', '\\Seen']);
    const rawText = appended[0].raw.toString();
    const bccHeader = headerOf(rawText, 'Bcc');
    expect(bccHeader).toContain('extra@example.com');
    expect(bccHeader).toContain('archive@example.com');

    const parsed = await simpleParser(appended[0].raw);
    const addresses = ((parsed.bcc as any)?.value ?? []).map((v: any) => v.address).sort();
    expect(addresses).toEqual(['archive@example.com', 'extra@example.com']);
  });

  it('B2-DRAFT-HANDLER-DEFAULT-ONLY: a draft without explicit bcc still stores the account default', async () => {
    const result = JSON.parse((await handlers.get('imap_save_draft')!({
      accountId: 'acc1',
      to: 'rcpt@example.com',
      subject: 'save default bcc',
      text: 'body',
    })).content[0].text);
    expect(result.success).toBe(true);

    const parsed = await simpleParser(appended[1].raw);
    const addresses = ((parsed.bcc as any)?.value ?? []).map((v: any) => v.address);
    expect(addresses).toEqual(['archive@example.com']);
  });
});
