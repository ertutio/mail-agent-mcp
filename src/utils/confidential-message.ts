/** Bounded, conservative preflight for the opt-in single-message MCP surface. */
export const HEADER_BYTES = 16 * 1024;
export const BODY_PREFIX_BYTES = 4 * 1024;
export const preflightSource = { start: 0, maxLength: HEADER_BYTES + 4 + BODY_PREFIX_BYTES };
export const guardedToolName = 'imap_get_email';

export function confidentialMarkers(env: NodeJS.ProcessEnv = process.env): readonly string[] | undefined {
  const raw = env.IMAP_MCP_CONFIDENTIAL_MARKERS;
  if (raw === undefined) return undefined;
  try {
    const values: unknown = JSON.parse(raw);
    if (Array.isArray(values) && values.length >= 1 && values.length <= 32 &&
        values.every((item: unknown) => typeof item === 'string' && item.trim().length >= 1 &&
          item.length <= 128 && !/[\x00-\x1f\x7f]/u.test(item) && normalize(item).trim().length >= 1)) return values as string[];
  } catch { /* report no configuration value */ }
  throw new Error('IMAP_MCP_CONFIDENTIAL_MARKERS must be a JSON array of 1 to 32 non-empty literal markers');
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu, '').replace(/\s+/gu, ' ');
}

export function marked(value: string, markers: readonly string[], truncated = false): boolean {
  const text = normalize(value);
  return markers.some(marker => {
    const key = normalize(marker);
    if (text.includes(key)) return true;
    // If a marker might straddle the bounded prefix, withhold rather than
    // request the full message. Avoid splitting UTF-16 surrogate pairs.
    if (!truncated) return false;
    const chars = Array.from(key);
    return chars.slice(1).some((_, i) => text.endsWith(chars.slice(0, i + 1).join('')));
  });
}

export function canExposeMessage(prefix: Buffer, size: number, markers: readonly string[]): boolean {
  try {
    if (!Number.isSafeInteger(size) || size < 1 || prefix.length !== Math.min(size, preflightSource.maxLength)) return false;
    const boundary = prefix.indexOf('\r\n\r\n');
    if (boundary < 0 || boundary > HEADER_BYTES) return false;
    const header = new TextDecoder('utf-8', { fatal: true }).decode(prefix.subarray(0, boundary));
    const fields = new Map<string, string>();
    const singleton = new Set(['subject', 'content-type', 'content-transfer-encoding', 'content-disposition', 'mime-version']);
    let last: string | undefined;
    for (const line of header.split('\r\n')) {
      if (/[\x00-\x08\x0a-\x1f\x7f]/u.test(line)) return false;
      if (/^[ \t]/u.test(line)) {
        if (!last) return false;
        fields.set(last, fields.get(last)! + ' ' + line.trim());
        continue;
      }
      const match = /^([!-9;-~]+):[ \t]*(.*)$/u.exec(line);
      if (!match) return false;
      last = match[1].toLowerCase();
      if (singleton.has(last) && fields.has(last)) return false;
      fields.set(last, match[2]);
    }
    const subject = fields.get('subject') ?? '';
    // Do not incorrectly approve unsupported or malformed RFC 2047 encoded words.
    if (subject.includes('=?')) return false;
    const mime = fields.get('mime-version');
    if (mime !== undefined && mime.trim() !== '1.0') return false;
    if (fields.has('content-disposition')) return false;
    const type = /^text\/plain(?:\s*;\s*charset\s*=\s*(?:"(utf-8|us-ascii)"|(utf-8|us-ascii)))?$/iu.exec(fields.get('content-type')?.trim() ?? 'text/plain');
    const transfer = fields.get('content-transfer-encoding')?.trim().toLowerCase() ?? '7bit';
    if (!type || !['7bit', '8bit'].includes(transfer)) return false;
    const start = boundary + 4;
    const bytes = prefix.subarray(start, start + BODY_PREFIX_BYTES);
    const ascii = transfer === '7bit' || (type[1] ?? type[2] ?? 'us-ascii').toLowerCase() === 'us-ascii';
    if (bytes.some(value => value === 0 || (ascii && value > 127))) return false;
    const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return !marked(subject, markers) && !marked(body, markers, start + bytes.length < size);
  } catch {
    return false;
  }
}
