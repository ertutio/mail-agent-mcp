import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let active = 0;
// Native PDF/canvas code must not share the MCP process. Input is passed only
// through stdin; parser diagnostics never enter the JSON-RPC transport.
const parserScript = `
console.log = console.warn = console.error = () => {};
const chunks = []; let size = 0;
process.stdin.on('data', chunk => { size += chunk.length; if(size > 262144) process.exit(1); chunks.push(chunk); });
process.stdin.on('end', async () => {
  try {
    const { PDFParse } = require(process.argv[1]);
    const parser = new PDFParse({ data: Buffer.concat(chunks), isEvalSupported: false, enableXfa: false, useSystemFonts: false });
    let result;
    try { result = await parser.getText({ first: 20, pageJoiner: '' }); }
    finally { await parser.destroy(); }
    const maxChars = Number(process.argv[2]);
    process.stdout.write(JSON.stringify({ text: result.text.slice(0, maxChars), truncated: result.text.length > maxChars || result.total > 20, pages: result.total }));
  } catch { process.exitCode = 1; }
});
`;

export interface PdfPreviewResult {
  text: string;
  truncated: boolean;
  /** Total page count reported by the parser (worker caps extraction at 20). */
  pages?: number;
}

export async function extractPdfPreview(bytes: Buffer, maxChars: number): Promise<PdfPreviewResult> {
  if (bytes.length > 256*1024 || active >= 2 || !Number.isInteger(maxChars) || maxChars < 1 || maxChars > 100000) {
    throw new Error('PDF preview resource limit');
  }
  active++;
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--max-old-space-size=128', '-e', parserScript, require.resolve('pdf-parse'), String(maxChars)], {
        stdio: ['pipe','pipe','ignore'], windowsHide: true,
      });
      const output: Buffer[] = []; let total = 0; let failure: string | undefined;
      const timer = setTimeout(() => { failure = 'PDF preview timed out'; child.kill(); }, 5000);
      child.stdout.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > 602048) { failure = 'PDF preview output limit'; child.kill(); }
        else output.push(chunk);
      });
      child.stdin.on('error', () => { /* early parser exit is handled by close */ });
      child.once('error', () => { clearTimeout(timer); reject(new Error('PDF preview could not start')); });
      child.once('close', code => {
        clearTimeout(timer);
        if (failure || code !== 0) { reject(new Error(failure ?? 'PDF preview failed')); return; }
        try {
          const value = JSON.parse(Buffer.concat(output).toString('utf8'));
          if (typeof value.text !== 'string' || value.text.length > maxChars || typeof value.truncated !== 'boolean') throw new Error('invalid');
          const pages = Number.isInteger(value.pages) && value.pages >= 0 ? value.pages : undefined;
          resolve({ text: value.text, truncated: value.truncated, ...(pages !== undefined ? { pages } : {}) });
        } catch { reject(new Error('PDF preview failed')); }
      });
      child.stdin.end(bytes);
    });
  } finally { active--; }
}
