import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImapService } from '../src/services/imap-service.js';
import { registerTools } from '../src/tools/index.js';
import { BODY_PREFIX_BYTES, canExposeMessage, confidentialMarkers, preflightSource } from '../src/utils/confidential-message.js';

const markers = ['DO NOT SHARE', '机密'];
const markerEnv = JSON.stringify(markers);
const subject = 'synthetic';
const wire = (body: string, headers: string[] = []) =>
  Buffer.from(['From: sender@example.test', 'To: recipient@example.test', 'Subject: ' + subject, ...headers, '', body].join('\r\n'));
const textHeaders = ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit'];

afterEach(() => vi.unstubAllEnvs());

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

function serviceFor(fetchOne: ReturnType<typeof vi.fn>) {
  vi.stubEnv('IMAP_MCP_CONFIDENTIAL_MARKERS', markerEnv);
  const service = new ImapService();
  const release = vi.fn();
  const getMailboxLock = vi.fn().mockResolvedValue({ release });
  vi.spyOn(service as any, 'ensureConnected').mockResolvedValue({ fetchOne, getMailboxLock });
  return { service, release, getMailboxLock };
}
const read = (service: ImapService) => service.getEmailContent('account', 'INBOX', 42);
const envelope = { uid: 42, envelope: { subject } };
const message = (source: Buffer) => ({ uid: 42, source, size: source.length, flags: new Set() });

describe('guarded MCP surface', () => {
  it('allows just the guarded tool; an explicit list can only narrow it', () => {
    vi.stubEnv('IMAP_MCP_CONFIDENTIAL_MARKERS', markerEnv);
    const collect = (value: string) => {
      vi.stubEnv('IMAP_MCP_ENABLED_TOOLS', value);
      const names: string[] = [];
      const stub: any = {};
      registerTools({ registerTool: (name: string) => names.push(name) } as any, stub, stub, stub, stub);
      return names;
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
  it('withholds a marked body before rendering or full fetch', async () => {
    const fetchOne = vi.fn().mockResolvedValueOnce(envelope).mockResolvedValueOnce(message(wire('机密 fixture', textHeaders)));
    const { service } = serviceFor(fetchOne);
    await expect(read(service)).rejects.toThrow(/^Message unavailable under confidential-message policy$/);
    expect(fetchOne).toHaveBeenCalledTimes(2);
    expect(fetchOne).toHaveBeenLastCalledWith(42, { uid: true, source: preflightSource, size: true }, { uid: true });
  });
  it('returns the normal text for supported ordinary mail only after preflight', async () => {
    const plain = message(wire('ordinary sample'));
    const fetchOne = vi.fn().mockResolvedValueOnce(envelope).mockResolvedValueOnce(plain).mockResolvedValueOnce(plain);
    const { service } = serviceFor(fetchOne);
    await expect(service.getEmailContent('account', 'INBOX', 42, { bodyFormat: 'text' }))
      .resolves.toMatchObject({ subject, textContent: 'ordinary sample' });
    expect(fetchOne).toHaveBeenCalledTimes(3);
  });
  it('withholds changed payloads and hides lower-level errors', async () => {
    const plain = message(wire('ordinary sample'));
    const fetchOne = vi.fn().mockResolvedValueOnce(envelope).mockResolvedValueOnce(plain).mockResolvedValueOnce(message(wire('DO NOT SHARE xx')));
    const { service } = serviceFor(fetchOne);
    await expect(read(service)).rejects.toThrow(/^Message unavailable under confidential-message policy$/);
    fetchOne.mockRejectedValueOnce(new Error('sensitive synthetic server echo'));
    await expect(read(service)).rejects.toThrow(/^Message unavailable under confidential-message policy$/);
  });
});
