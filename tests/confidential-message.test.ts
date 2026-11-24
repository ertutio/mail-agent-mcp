import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { ImapService } from '../src/services/imap-service.js';
import { registerTools } from '../src/tools/index.js';
import { BODY_PREFIX_BYTES, canExposeOpening, confidentialMarkers, inspectHeader, preflightHeader, preflightText } from '../src/utils/confidential-message.js';

const markers = ['DO NOT SHARE', '机密'];
const subject = 'synthetic';
const wire = (body: string, headers: string[] = []) =>
  Buffer.from(['From: sender@example.test', 'To: recipient@example.test', 'Subject: ' + subject, ...headers, '', body].join('\r\n'));
const textHeaders = ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit'];

const split = (msg: Buffer) => {
  const end = msg.indexOf('\r\n\r\n') + 4;
  return { header: msg.subarray(0, end), body: msg.subarray(end) };
};
const canExposeMessage = (msg: Buffer, size: number, policy: readonly string[]) => {
  const { header, body } = split(msg);
  const format = inspectHeader(header, policy);
  return !!format && canExposeOpening(body.subarray(0, BODY_PREFIX_BYTES), size - header.length, format.ascii, policy);
};

describe('confidential preflight', () => {
  it('matches decoded UTF-8 literal in a bounded prefix', () => {
    expect(canExposeMessage(wire('机密 sample', textHeaders), wire('机密 sample', textHeaders).length, markers)).toBe(false);
    const msg = wire('x'.repeat(BODY_PREFIX_BYTES) + 'DO NOT SHARE', textHeaders);
    expect(canExposeMessage(msg, msg.length, markers)).toBe(true); // outside declared policy window
  });
  it('normalizes case, width and whitespace and withholds marker fragments at the boundary', () => {
    for (const body of ['ＤＯ not\tshare sample', 'do not\r\nshare sample', 'DO NOT SHA\u200bRE sample', 'DO NOT SHA\u2028RE sample', 'DO NOT SHA\u2029RE sample', 'x'.repeat(BODY_PREFIX_BYTES - 5) + 'DO NOT SHARE']) {
      const msg = wire(body, textHeaders);
      expect(canExposeMessage(msg, msg.length, markers)).toBe(false);
    }
  });
  it('allows an ordinary Unicode opening in supported 8bit text', () => {
    const msg = wire('今天开会，日期待定', textHeaders);
    expect(canExposeMessage(msg, msg.length, markers)).toBe(true);
  });
  it('fails closed when the byte boundary splits the first UTF-8 character of a marker', () => {
    const msg = wire('x'.repeat(BODY_PREFIX_BYTES - 1) + '机密', textHeaders);
    expect(canExposeMessage(msg, msg.length, markers)).toBe(false);
  });
  it.each([
    ['multipart', wire('secret', ['Content-Type: multipart/alternative; boundary=x'])],
    ['unsupported charset', wire('secret', ['Content-Type: text/plain; charset=iso-8859-1'])],
    ['unsupported transfer encoding', wire('YQ==', ['Content-Transfer-Encoding: base64'])],
    ['attachment', wire('payload', ['Content-Disposition: attachment'])],
    ['duplicate subject', wire('body', ['Subject: shadow'])],
    ['encoded subject', Buffer.from('Subject: =?UTF-8?B?eA==?=\r\n\r\nbody')],
    ['missing separator', Buffer.from('Subject: incomplete')],
  ])('fails closed for %s', (_name, msg) => expect(canExposeMessage(msg, msg.length, markers)).toBe(false));
  it('rejects inconsistent prefix length and invalid UTF-8', () => {
    const msg = wire('ordinary', textHeaders);
    expect(canExposeMessage(msg.subarray(0, -2), msg.length, markers)).toBe(false);
    const bad = Buffer.concat([msg, Buffer.from([0xff])]);
    expect(canExposeMessage(bad, bad.length, markers)).toBe(false);
  });
  it('never logs a malformed marker value', () => {
    expect(() => confidentialMarkers({ IMAP_MCP_CONFIDENTIAL_MARKERS: 'synthetic-private-setting' }))
      .toThrow('must be a JSON array');
    expect(() => confidentialMarkers({ IMAP_MCP_CONFIDENTIAL_MARKERS: '[]' })).toThrow();
    expect(() => confidentialMarkers({ IMAP_MCP_CONFIDENTIAL_MARKERS: '' })).toThrow();
  });
});

function serviceFor(fetchOne: ReturnType<typeof vi.fn>, policy: readonly string[] = markers) {
  const service = new ImapService(undefined, policy);
  const release = vi.fn();
  const getMailboxLock = vi.fn().mockResolvedValue({ release });
  vi.spyOn(service as any, 'ensureConnected').mockResolvedValue({ fetchOne, getMailboxLock });
  return { service, release, getMailboxLock };
}
const read = (service: ImapService) => service.getEmailContent('account', 'INBOX', 42);
const envelope = { uid: 42, envelope: { subject } };
const message = (source: Buffer) => ({ uid: 42, source, size: source.length, flags: new Set() });

const headerResponse = (msg: Buffer) => ({ uid: 42, headers: split(msg).header, size: msg.length });
const openingResponse = (msg: Buffer) => ({
  uid: 42, bodyParts: new Map([['text', split(msg).body.subarray(0, BODY_PREFIX_BYTES)]]),
});

describe('guarded MCP surface', () => {
  async function expectSkippedAfterPreview(msg: Buffer, marker: string) {
    const fetchOne = vi.fn().mockResolvedValueOnce(envelope).mockResolvedValueOnce(headerResponse(msg))
      .mockResolvedValueOnce(openingResponse(msg)).mockResolvedValueOnce(message(msg));
    const { service, release } = serviceFor(fetchOne, [marker]);
    const accountManager = { resolveAccountId: () => 'account' };
    const handlers = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>();
    registerTools({
      registerTool: (name: string, _config: unknown, handler: (input: Record<string, unknown>) => Promise<unknown>) =>
        handlers.set(name, handler),
    } as any, service, accountManager as any, {} as any, {} as any, [marker]);
    const result = await handlers.get('imap_get_email')!({ folder: 'INBOX', uid: 42, maxContentLength: 10000 });
    expect(result).toEqual({ content: [{ type: 'text', text: '{"status":"skipped"}' }] });
    expect(fetchOne).toHaveBeenCalledTimes(3);
    expect(fetchOne).toHaveBeenLastCalledWith(42, { uid: true, bodyParts: [preflightText] }, { uid: true });
    expect(release).toHaveBeenCalledOnce();
  }

  it('withholds a canonical-equivalent marker after invisible characters are removed', async () => {
    const marker = 'Café témoin';
    const body = marker.normalize('NFD').replace('e\u0301', 'e\u200b\u0301');
    await expectSkippedAfterPreview(wire(body, textHeaders), marker);
  });

  it('withholds a preview whose complete final UTF-8 character can compose across the byte boundary', async () => {
    const marker = 'é témoin';
    const prefix = 'x'.repeat(BODY_PREFIX_BYTES - 1) + 'e';
    expect(Buffer.byteLength(prefix)).toBe(BODY_PREFIX_BYTES);
    await expectSkippedAfterPreview(wire(prefix + marker.normalize('NFD').slice(1), textHeaders), marker);
  });

  it('allows just the guarded tool; an explicit list can only narrow it', () => {
    const collect = (value: string) => {
      vi.stubEnv('IMAP_MCP_ENABLED_TOOLS', value);
      const names: string[] = [];
      const stub: any = {};
      try {
        registerTools({ registerTool: (name: string) => names.push(name) } as any, stub, stub, stub, stub, markers);
        return names;
      } finally {
        vi.unstubAllEnvs();
      }
    };
    expect(collect('')).toEqual(['imap_get_email']);
    expect(collect('imap_get_email,imap_download_attachment,imap_search_emails,imap_mail_digest')).toEqual(['imap_get_email']);
    expect(collect('imap_download_attachment,imap_mail_digest')).toEqual([]);
  });
  it('withholds a marked subject before fetching any body', async () => {
    const fetchOne = vi.fn().mockResolvedValue({ uid: 42, envelope: { subject: 'DO NOT SHARE synthetic title' } });
    const { service, release, getMailboxLock } = serviceFor(fetchOne);
    await expect(read(service)).rejects.toThrow(/^Message unavailable under confidential-message policy$/);
    expect(getMailboxLock).toHaveBeenCalledWith('INBOX', { readOnly: true });
    expect(fetchOne).toHaveBeenCalledExactlyOnceWith(42, { uid: true, envelope: true }, { uid: true });
    expect(release).toHaveBeenCalledOnce();
  });
  it('requests exactly the bounded HEADER and TEXT wire sections and never full source for a marked long message', async () => {
    const require = createRequire(import.meta.url);
    const fetchCommand = require('imapflow/lib/commands/fetch.js');
    const compiler = require('imapflow/lib/handler/imap-compiler.js');
    const parser = require('imapflow/lib/handler/imap-parser.js');
    const msg = wire('机密 fixture ' + 'x'.repeat(BODY_PREFIX_BYTES + 20), textHeaders);
    const { header, body } = split(msg);
    const commands: string[] = [];
    const sendLiteral = async (command: string, attributes: unknown, options: any) => {
      commands.push((await compiler({ tag: 'A1', command, attributes })).toString());
      const isHeader = commands.length === 1;
      const bytes = isHeader ? header : body.subarray(0, BODY_PREFIX_BYTES);
      const response = '* 1 FETCH (UID 42 ' + (isHeader ? 'RFC822.SIZE ' + msg.length + ' ' : '') +
        'BODY[' + (isHeader ? 'HEADER' : 'TEXT') + ']<0> {' + bytes.length + '}\r\n)';
      await options.untagged.FETCH(await parser(Buffer.from(response), { literals: [bytes] }));
      return { next() {} };
    };
    const connection = { state: 1, states: { SELECTED: 1 }, mailbox: {}, capabilities: new Set(['BINARY']), enabled: new Set(), exec: sendLiteral };
    const fetchOne = vi.fn().mockResolvedValueOnce(envelope).mockImplementation(async (uid, query, options) =>
      (await fetchCommand(connection, uid, query, options)).list[0]);
    const { service } = serviceFor(fetchOne);
    await expect(read(service)).rejects.toThrow(/^Message unavailable under confidential-message policy$/);
    expect(fetchOne).toHaveBeenCalledTimes(3);
    expect(commands).toEqual([
      'A1 UID FETCH 42 (UID RFC822.SIZE BODY.PEEK[HEADER]<0.16388>)',
      'A1 UID FETCH 42 (UID BODY.PEEK[TEXT]<0.4096>)',
    ]);
  });
  it('does not fetch TEXT when the raw header is unsupported', async () => {
    const msg = wire('body', ['Content-Type: multipart/alternative; boundary=x']);
    const fetchOne = vi.fn().mockResolvedValueOnce(envelope).mockResolvedValueOnce(headerResponse(msg));
    const { service } = serviceFor(fetchOne);
    await expect(read(service)).rejects.toThrow(/^Message unavailable under confidential-message policy$/);
    expect(fetchOne).toHaveBeenCalledTimes(2);
    expect(fetchOne).toHaveBeenLastCalledWith(42, { uid: true, bodyParts: [preflightHeader], size: true }, { uid: true });
  });
  it('rejects a server response larger than the requested TEXT window', async () => {
    const msg = wire('x'.repeat(BODY_PREFIX_BYTES + 20));
    const fetchOne = vi.fn().mockResolvedValueOnce(envelope).mockResolvedValueOnce(headerResponse(msg))
      .mockResolvedValueOnce({ uid: 42, bodyParts: new Map([['text', split(msg).body]]) });
    const { service } = serviceFor(fetchOne);
    await expect(read(service)).rejects.toThrow(/^Message unavailable under confidential-message policy$/);
    expect(fetchOne).toHaveBeenCalledTimes(3);
    expect(fetchOne).toHaveBeenLastCalledWith(42, { uid: true, bodyParts: [preflightText] }, { uid: true });
  });
  it('returns the normal text for supported ordinary mail only after preflight', async () => {
    const msg = wire('ordinary sample');
    const fetchOne = vi.fn().mockResolvedValueOnce(envelope).mockResolvedValueOnce(headerResponse(msg)).mockResolvedValueOnce(openingResponse(msg)).mockResolvedValueOnce(message(msg));
    const { service } = serviceFor(fetchOne);
    await expect(service.getEmailContent('account', 'INBOX', 42, { bodyFormat: 'text' }))
      .resolves.toMatchObject({ subject, textContent: 'ordinary sample' });
    expect(fetchOne).toHaveBeenCalledTimes(4);
  });
  it('withholds changed payloads and hides lower-level errors', async () => {
    const msg = wire('ordinary sample');
    const fetchOne = vi.fn().mockResolvedValueOnce(envelope).mockResolvedValueOnce(headerResponse(msg)).mockResolvedValueOnce(openingResponse(msg)).mockResolvedValueOnce(message(wire('changed! sample')));
    const { service } = serviceFor(fetchOne);
    await expect(read(service)).rejects.toThrow(/^Message unavailable under confidential-message policy$/);
    fetchOne.mockRejectedValueOnce(new Error('sensitive synthetic server echo'));
    await expect(read(service)).rejects.toThrow(/^Message unavailable under confidential-message policy$/);
  });
});
