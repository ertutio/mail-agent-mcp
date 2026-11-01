import { describe, it, expect, vi } from 'vitest';
import { ImapService } from '../src/services/imap-service.js';
import { safeSendTools } from '../src/tools/safe-send-tools.js';
import { composerRecipients, deliveryReceipt } from '../src/utils/mail-compose.js';

// T25 / MAIL-11: stable part selection — same-name different bytes, unnamed
// inline (CID), ordering changes, and real MIME byte verification. This file
// does NOT mock mailparser: the tests exercise the real MIME parsing path.
describe('T25E: stable part selection and byte verification', () => {
  const buildMime = (attachments: Array<{filename?: string; content: string; cid?: string}>) => {
    const boundary = 'bnd_t25e';
    const parts = attachments.map((att) => {
      const type = att.filename?.endsWith('.pdf') ? 'application/pdf' : 'text/plain';
      const cid = att.cid ? `\r\nContent-ID: <${att.cid}>` : '';
      const name = att.filename ? `; filename="${att.filename}"` : '';
      const disposition = att.cid
        ? '\r\nContent-Disposition: attachment'
        : `\r\nContent-Disposition: attachment${name}`;
      return `--${boundary}\r\nContent-Type: ${type}; charset=utf-8${disposition}${cid}\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${att.content}\r\n`;
    }).join('');
    return Buffer.from(`From: sender@synth.test\r\nTo: dest@synth.test\r\nSubject: T25E\r\nMessage-ID: <t25e@synth.test>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n${parts}--${boundary}--\r\n`);
  };

  const setupSvc = (mime: Buffer) => {
    const svc = new ImapService();
    vi.spyOn(svc as any, 'ensureConnected').mockResolvedValue({
      getMailboxLock: async () => ({ release: () => {} }),
      status: async () => ({ uidValidity: 111n }),
      fetchOne: vi.fn(async () => ({ source: mime, size: mime.length })),
    });
    return svc;
  };

  it('T25E-SAME-NAME-DIFF-BYTES: partIndex selects the correct same-name attachment', async () => {
    const mime = buildMime([
      { filename: 'report.pdf', content: 'PDF-VERSION-AAA' },
      { filename: 'report.pdf', content: 'PDF-VERSION-BBB' },
      { filename: 'report.pdf', content: 'PDF-VERSION-CCC' },
    ]);
    const svc = setupSvc(mime);

    const first = await svc.getAttachmentContent('acc1', 'INBOX', 7, 'report.pdf', 111, 0);
    const second = await svc.getAttachmentContent('acc1', 'INBOX', 7, 'report.pdf', 111, 1);
    const third = await svc.getAttachmentContent('acc1', 'INBOX', 7, 'report.pdf', 111, 2);

    expect(first.content.toString()).toContain('PDF-VERSION-AAA');
    expect(second.content.toString()).toContain('PDF-VERSION-BBB');
    expect(third.content.toString()).toContain('PDF-VERSION-CCC');
    expect(first.totalMatches).toBe(3);
  });

  it('T25E-PART-INDEX-OUT-OF-RANGE: an out-of-range partIndex is rejected', async () => {
    const mime = buildMime([{ filename: 'a.txt', content: 'data' }]);
    const svc = setupSvc(mime);

    await expect(
      svc.getAttachmentContent('acc1', 'INBOX', 7, 'a.txt', 111, 5)
    ).rejects.toThrow(/out of range/);
  });

  it('T25E-UNNAMED-ATTACHMENT: an unnamed inline attachment is found by CID', async () => {
    const mime = buildMime([
      { content: 'inline-image-data', cid: 'img-001' },
      { filename: 'report.pdf', content: 'pdf-data' },
    ]);
    const svc = setupSvc(mime);

    const result = await svc.getAttachmentContent('acc1', 'INBOX', 7, 'img-001', 111);
    expect(result.content.toString()).toContain('inline-image-data');
  });

  it('T25E-ORDER-CHANGE: part selection follows parsed MIME order', async () => {
    const mime = buildMime([
      { filename: 'data.txt', content: 'SECOND-COPY' },
      { filename: 'data.txt', content: 'FIRST-COPY' },
    ]);
    const svc = setupSvc(mime);

    const first = await svc.getAttachmentContent('acc1', 'INBOX', 7, 'data.txt', 111, 0);
    const second = await svc.getAttachmentContent('acc1', 'INBOX', 7, 'data.txt', 111, 1);
    expect(first.content.toString()).toContain('SECOND-COPY');
    expect(second.content.toString()).toContain('FIRST-COPY');
  });

  it('T25E-REAL-BYTES: real MIME parsing preserves attachment bytes', async () => {
    const content = 'T25E-EXACT-BYTES-0123456789';
    const mime = buildMime([{ filename: 'exact.bin', content }]);
    const svc = setupSvc(mime);

    const result = await svc.getAttachmentContent('acc1', 'INBOX', 7, 'exact.bin', 111);
    expect(result.content.toString()).toContain('T25E-EXACT-BYTES-0123456789');
  });
});

// T25 round-2: the forward chain (handler → ImapService → real MIME parsing)
// binds the original-email read and every attachment read to one account
// identity, UIDVALIDITY, UID and explicit part — a change in between rejects
// at the read boundary instead of freezing another message's bytes.
describe('T25R: forward chain identity binding (real ImapService, real MIME)', () => {
  const buildForwardMime = () => {
    const boundary = 'bnd_t25r';
    const part = (filename: string, content: string) =>
      `--${boundary}\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="${filename}"\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${content}\r\n`;
    const parts = part('report.pdf', 'FWD-VERSION-AAA') + part('report.pdf', 'FWD-VERSION-BBB');
    return Buffer.from(`From: sender@synth.test\r\nTo: dest@synth.test\r\nSubject: T25R original\r\nMessage-ID: <t25r@synth.test>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n${parts}--${boundary}--\r\n`);
  };

  const setupForward = (options: { statusUidValidity?: bigint } = {}) => {
    const mime = buildForwardMime();
    const svc = new ImapService();
    const fetches: number[] = [];
    const client = {
      mailbox: { uidValidity: 111n } as any,
      getMailboxLock: async () => ({ release: () => {} }),
      status: async () => ({ uidValidity: options.statusUidValidity ?? 111n }),
      fetchOne: vi.fn(async () => {
        fetches.push(Date.now());
        return { source: mime, size: mime.length, flags: [] };
      }),
    };
    vi.spyOn(svc as any, 'ensureConnected').mockResolvedValue(client);
    const account: any = {
      id: 'acc1', name: 'Acc', host: 'imap.synth.test', port: 993, tls: true, secure: true,
      user: 'me@synth.test', email: 'me@synth.test', password: '', saveToSent: false,
      smtp: { host: 'smtp.synth.test', port: 465, secure: true },
    };
    // Mirror the real AccountManager: getAccount is synchronous.
    const getAccount = vi.fn((): any => account);
    const manager: any = { getAccount, resolveAccountId: (id?: string) => id ?? 'acc1' };
    svc.setAccountManager(manager);
    const handlers = new Map<string, Function>();
    const sent: any[] = [];
    const smtpService = {
      // Snapshot attachment bytes at capture time: the safe-send lifecycle
      // zeroizes frozen buffers after the send completes.
      sendEmail: vi.fn(async (_accountId: string, _account: unknown, composer: any) => {
        sent.push({ ...composer, attachments: composer.attachments?.map((a: any) => ({ ...a, content: Buffer.isBuffer(a.content) ? Buffer.from(a.content) : a.content })) });
        return { messageId: '<fwd@synth.test>', rawMessage: Buffer.from('raw'), receipt: deliveryReceipt(composerRecipients(composer), composerRecipients(composer), []) };
      }),
    };
    safeSendTools(
      { registerTool: (name: string, _def: unknown, handler: Function) => handlers.set(name, handler) } as any,
      svc, manager, smtpService as any,
      { id: () => 'draft-1', clock: () => 100, ttlMs: 1_000 },
    );
    return { svc, client, handlers, sent, getAccount, account, smtpService };
  };

  const json = (result: any) => JSON.parse(result.content[0].text);

  it('T25R-FWD-E2E: same-name originals materialize distinct bytes; confirm reuses them without re-downloading', async () => {
    const { handlers, sent, client } = setupForward();
    const preview = json(await handlers.get('imap_preview_forward_email')!({ accountId: 'acc1', folder: 'INBOX', uid: 7, to: ['you@synth.test'], includeAttachments: true }));
    expect(preview.draftId).toBe('draft-1');
    const previewFetches = client.fetchOne.mock.calls.length;

    const confirmation = json(await handlers.get('imap_confirm_send')!({ draftId: 'draft-1', confirmed: true }));
    expect(confirmation.status).toBe('sent');
    // The mock captures the frozen composer directly.
    const attachments = sent[0].attachments;
    expect(attachments).toHaveLength(2);
    expect(attachments[0].content.toString()).toContain('FWD-VERSION-AAA');
    expect(attachments[1].content.toString()).toContain('FWD-VERSION-BBB');
    // Confirm must reuse the frozen bytes: no re-read of the original message.
    expect(client.fetchOne.mock.calls.length).toBe(previewFetches);
  });

  it('T25R-FWD-VALIDITY: UIDVALIDITY change between the reads rejects before anything is frozen', async () => {
    const { handlers, smtpService } = setupForward({ statusUidValidity: 222n });
    await expect(handlers.get('imap_preview_forward_email')!({ accountId: 'acc1', folder: 'INBOX', uid: 7, to: ['you@synth.test'], includeAttachments: true }))
      .rejects.toThrow(/UIDVALIDITY/);
    expect(smtpService.sendEmail).not.toHaveBeenCalled();
    await expect(handlers.get('imap_confirm_send')!({ draftId: 'draft-1', confirmed: true })).rejects.toThrow(/Unknown|tampered/);
  });

  it('T25R-FWD-IDENTITY: account identity change after the original read rejects at the read boundary', async () => {
    const { handlers, getAccount, account, smtpService } = setupForward();
    // Model an account edit landing between the handler's account lookup and
    // the attachment reads: the first getAccount (handler capture) sees the
    // original identity, every later one (read boundary) sees the edit.
    let calls = 0;
    getAccount.mockImplementation((): any => {
      calls += 1;
      return calls === 1 ? account : { ...account, host: 'other.imap.synth.test' };
    });
    await expect(handlers.get('imap_preview_forward_email')!({ accountId: 'acc1', folder: 'INBOX', uid: 7, to: ['you@synth.test'], includeAttachments: true }))
      .rejects.toThrow(/identity changed/);
    expect(smtpService.sendEmail).not.toHaveBeenCalled();
  });

  it('T25R-FWD-PER-FETCH-IDENTITY: an edit landing after the boundary check is caught by the per-fetch check', async () => {
    const { handlers, getAccount, account, smtpService } = setupForward();
    // Calls 1-2 (handler capture, boundary check) see the original identity;
    // the edit lands before the per-fetch checks run inside
    // getAttachmentContent, so no fetch may happen under the new identity.
    let calls = 0;
    getAccount.mockImplementation((): any => {
      calls += 1;
      return calls <= 2 ? account : { ...account, host: 'other.imap.synth.test' };
    });
    await expect(handlers.get('imap_preview_forward_email')!({ accountId: 'acc1', folder: 'INBOX', uid: 7, to: ['you@synth.test'], includeAttachments: true }))
      .rejects.toThrow(/identity changed/);
    expect(smtpService.sendEmail).not.toHaveBeenCalled();
    await expect(handlers.get('imap_confirm_send')!({ draftId: 'draft-1', confirmed: true })).rejects.toThrow(/Unknown|tampered/);
  });

  it('T25R-FWD-NO-VALIDITY-FAILS-CLOSED: a mailbox without UIDVALIDITY metadata rejects instead of skipping the check', async () => {
    const { handlers, client, smtpService } = setupForward();
    // Model a client that cannot report UIDVALIDITY: the forward must fail
    // closed rather than silently skip the identity binding (audit H2).
    delete (client.mailbox as any);
    (client as any).mailbox = undefined;
    await expect(handlers.get('imap_preview_forward_email')!({ accountId: 'acc1', folder: 'INBOX', uid: 7, to: ['you@synth.test'], includeAttachments: true }))
      .rejects.toThrow(/UIDVALIDITY unavailable/);
    expect(smtpService.sendEmail).not.toHaveBeenCalled();
  });
});
