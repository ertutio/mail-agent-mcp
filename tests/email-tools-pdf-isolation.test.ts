import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync, rmSync, readFileSync } from 'fs';

// T06 / MAIL-02: every PDF entry point must run the native parser inside the
// isolated, budgeted worker (src/utils/pdf-preview.ts) — never inside the MCP
// process. Case IDs:
//   T06-ISOLATED-ENTRY — imap_download_attachment extracts text without any
//     in-process pdf-parse import (the historical E09 defect).
//   T06-BUDGET-OVERSIZE — inputs over the shared byte budget fall back to
//     save-only with an explicit, observable reason.
//   T06-UNAVAILABLE-REASON — a failed parse reports why instead of silently
//     omitting the text fields.

const PDF_DOWNLOAD_ROOT = join(tmpdir(), `imap-pdf-isolation-${process.pid}`);
process.env.IMAP_DOWNLOAD_DIR = PDF_DOWNLOAD_ROOT;

// Record every in-process import of pdf-parse. The isolated worker loads the
// real library in its own child process, which this mock cannot intercept.
let inProcessPdfParseImports = 0;
vi.mock('pdf-parse', () => {
  inProcessPdfParseImports++;
  return { PDFParse: class { destroy() {} } };
});

const { emailTools } = await import('../src/tools/email-tools.js');

function makePdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const pdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length ${stream.length} >>
stream
${stream}
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
trailer
<< /Root 1 0 R /Size 6 >>
%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

let downloadHandler: Function;

const mockServer = {
  registerTool: vi.fn((name: string, _schema: any, handler: Function) => {
    if (name === 'imap_download_attachment') downloadHandler = handler;
  }),
};

const mockImapService = { getAttachmentContent: vi.fn() };
const mockAccountManager = { resolveAccountId: (id: string) => id };

describe('T06: imap_download_attachment shares the isolated PDF worker (MAIL-02)', () => {
  const savePath = join(PDF_DOWNLOAD_ROOT, 'attachment.pdf');

  beforeEach(() => {
    vi.clearAllMocks();
    emailTools(
      mockServer as any,
      mockImapService as any,
      mockAccountManager as any,
      {} as any,
    );
  });

  afterEach(() => {
    if (existsSync(PDF_DOWNLOAD_ROOT)) rmSync(PDF_DOWNLOAD_ROOT, { recursive: true, force: true });
  });

  it('T06-ISOLATED-ENTRY: extracts text via the worker with zero in-process pdf-parse imports', async () => {
    mockImapService.getAttachmentContent.mockResolvedValueOnce({
      content: makePdf('Hello PDF Isolation'),
      contentType: 'application/pdf',
      filename: 'invoice.pdf',
    });

    const result = await downloadHandler({
      accountId: 'acc1',
      folder: 'INBOX',
      uid: 1,
      filename: 'invoice.pdf',
      savePath,
      extractText: true,
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.saved).toBe(true);
    expect(parsed.textContent).toContain('Hello PDF Isolation');
    expect(parsed.pages).toBe(1);
    expect(existsSync(savePath)).toBe(true);
    expect(readFileSync(savePath).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(inProcessPdfParseImports).toBe(0);
  });

  it('T06-BUDGET-OVERSIZE: an over-budget PDF falls back to save-only with an explicit reason', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const oversized = Buffer.concat([makePdf('x'), Buffer.alloc(300 * 1024, 'a')]);
    mockImapService.getAttachmentContent.mockResolvedValueOnce({
      content: oversized,
      contentType: 'application/pdf',
      filename: 'big.pdf',
    });

    const result = await downloadHandler({
      accountId: 'acc1',
      folder: 'INBOX',
      uid: 2,
      filename: 'big.pdf',
      savePath,
      extractText: true,
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.saved).toBe(true);
    expect(parsed.textContent).toBeUndefined();
    expect(parsed.textContentUnavailable).toMatch(/resource limit/i);
    expect(existsSync(savePath)).toBe(true);
    errorSpy.mockRestore();
  });

  it('T06-UNAVAILABLE-REASON: a broken PDF reports the extraction failure', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockImapService.getAttachmentContent.mockResolvedValueOnce({
      content: Buffer.from('this is not a real pdf', 'utf8'),
      contentType: 'application/pdf',
      filename: 'broken.pdf',
    });

    const result = await downloadHandler({
      accountId: 'acc1',
      folder: 'INBOX',
      uid: 3,
      filename: 'broken.pdf',
      savePath,
      extractText: true,
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.saved).toBe(true);
    expect(parsed.textContent).toBeUndefined();
    expect(typeof parsed.textContentUnavailable).toBe('string');
    errorSpy.mockRestore();
  });
});
