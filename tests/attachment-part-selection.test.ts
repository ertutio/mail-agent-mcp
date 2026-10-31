import { describe, it, expect, vi } from 'vitest';
import { ImapService } from '../src/services/imap-service.js';

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
