/** Bounded, conservative preflight for the opt-in single-message MCP surface. */
export const HEADER_BYTES = 16 * 1024;
export const BODY_PREFIX_BYTES = 4 * 1024;
export const preflightHeader = { key: 'HEADER', start: 0, maxLength: HEADER_BYTES + 4 };
export const preflightText = { key: 'TEXT', start: 0, maxLength: BODY_PREFIX_BYTES };
export const guardedToolName = 'imap_get_email';

export class ConfidentialMessageSkipped extends Error {
  constructor() {
    super('Message unavailable under confidential-message policy');
  }
}

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
  return value.replace(/[\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu, '')
    .normalize('NFKC').toLowerCase().normalize('NFKC').replace(/\s+/gu, ' ');
}

function overlapsMarker(text: string, marker: string, prefixLength: number): boolean {
  if (!marker.length) return true;
  for (let length = 1; length <= prefixLength; length++) {
    if (text.endsWith(marker.slice(0, length))) return true;
  }
  return false;
}

/** A following character can compose with the last character or change its casing. */
function boundaryForm(value: string): string {
  return value.replace(/\p{M}/gu, '').replace(/ς/gu, 'σ');
}

export function marked(value: string, markers: readonly string[], truncated = false): boolean {
  const text = normalize(value);
  return markers.some(marker => {
    const key = normalize(marker);
    if (text.includes(key)) return true;
    // Withhold when a literal marker might straddle the preview boundary.
    if (!truncated) return false;
    return overlapsMarker(text, key, key.length - 1);
  });
}

export function inspectHeader(bytes: Buffer, markers: readonly string[]): { ascii: boolean } | undefined {
  try {
    const boundary = bytes.indexOf('\r\n\r\n');
    if (boundary < 0 || boundary > HEADER_BYTES || boundary + 4 !== bytes.length) return undefined;
    const header = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, boundary));
    const fields = new Map<string, string>();
    const singleton = new Set(['subject', 'content-type', 'content-transfer-encoding', 'content-disposition', 'mime-version']);
    let last: string | undefined;
    for (const line of header.split('\r\n')) {
      if (/[\x00-\x08\x0a-\x1f\x7f]/u.test(line)) return undefined;
      if (/^[ \t]/u.test(line)) {
        if (!last) return undefined;
        fields.set(last, fields.get(last)! + ' ' + line.trim());
        continue;
      }
      const match = /^([!-9;-~]+):[ \t]*(.*)$/u.exec(line);
      if (!match) return undefined;
      last = match[1].toLowerCase();
      if (singleton.has(last) && fields.has(last)) return undefined;
      fields.set(last, match[2]);
    }
    const subject = fields.get('subject') ?? '';
    // Do not incorrectly approve unsupported or malformed RFC 2047 encoded words.
    if (subject.includes('=?')) return undefined;
    const mime = fields.get('mime-version');
    if (mime !== undefined && mime.trim() !== '1.0') return undefined;
    if (fields.has('content-disposition')) return undefined;
    const type = /^text\/plain(?:\s*;\s*charset\s*=\s*(?:"(utf-8|us-ascii)"|(utf-8|us-ascii)))?$/iu.exec(fields.get('content-type')?.trim() ?? 'text/plain');
    const transfer = fields.get('content-transfer-encoding')?.trim().toLowerCase() ?? '7bit';
    if (!type || !['7bit', '8bit'].includes(transfer)) return undefined;
    if (marked(subject, markers)) return undefined;
    return { ascii: transfer === '7bit' || (type[1] ?? type[2] ?? 'us-ascii').toLowerCase() === 'us-ascii' };
  } catch {
    return undefined;
  }
}

export function canExposeOpening(bytes: Buffer, size: number, ascii: boolean, markers: readonly string[]): boolean {
  try {
    if (!Number.isSafeInteger(size) || size < 0 || bytes.length !== Math.min(size, BODY_PREFIX_BYTES)) return false;
    if (bytes.some(value => value === 0 || (ascii && value > 127))) return false;
    const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const truncated = bytes.length < size;
    if (marked(body, markers, truncated)) return false;
    if (!truncated || ascii) return true;
    // Compare a conservative form only at the boundary. Marks can compose
    // or reorder, and a following letter can change the case of Greek sigma.
    const decomposedBody = normalize(body).normalize('NFKD');
    const tail = boundaryForm(decomposedBody);
    const endsWithMark = /\p{M}$/u.test(decomposedBody);
    return markers.every(marker => {
      const decomposedMarker = normalize(marker).normalize('NFKD');
      // The mark-stripped comparison loses a fragment that consists only of marks.
      if (endsWithMark && /^\p{M}/u.test(decomposedMarker)) return false;
      const key = boundaryForm(decomposedMarker);
      return !overlapsMarker(tail, key, key.length);
    });
  } catch {
    return false;
  }
}
