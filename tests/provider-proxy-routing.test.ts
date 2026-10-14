import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/utils/windows-system-proxy.js', () => ({ windowsLoopbackProxy: () => undefined }));
import { resolveMailProxy } from '../src/utils/mail-proxy.js';
import { resolveGmailProxy } from '../src/utils/gmail-proxy.js';
import { createProxyAwareFetch } from '../src/credentials/proxy-fetch.js';

describe('provider-specific routing independent of local machine settings', () => {
  const env = { HTTPS_PROXY: 'http://proxy.example.test:32109', IMAP_MCP_MAIL_PROXY: 'socks5://proxy.example.test:10801', NO_PROXY: '*' };
  it.each(['imap.qq.com', 'smtp.qq.com', 'imap.163.com', 'smtp.126.com', 'imap.yeah.net', 'imaphz.qiye.163.com', 'smtphz.qiye.163.com'])('connects domestic host %s directly despite global proxies', host => {
    expect(resolveMailProxy(env, host)).toBeUndefined();
  });
  it('connects a NetEase enterprise account with a custom host directly', () => {
    expect(resolveMailProxy(env, 'mail.enterprise.example.test', 'netease')).toBeUndefined();
  });
  it.each(['imap.gmail.com', 'smtp.gmail.com', 'imap.googlemail.com'])('forces Gmail host %s through a proxy despite NO_PROXY=*', host => {
    expect(resolveMailProxy(env, host)).toBe(env.IMAP_MCP_MAIL_PROXY);
  });
  it('does not mistake lookalike domains for domestic servers', () => {
    expect(resolveMailProxy({ HTTPS_PROXY: env.HTTPS_PROXY }, 'imap.qq.com.attacker.test')).toBe(env.HTTPS_PROXY);
  });
  it('rejects missing Gmail proxies without making a direct network request', () => {
    expect(() => resolveMailProxy({}, 'imap.gmail.com')).toThrow(/requires a proxy/);
    expect(() => createProxyAwareFetch({}, {}, 'gmail-required')).toThrow(/requires a proxy/);
  });
  it('uses the dedicated Gmail setting before other settings', () => {
    expect(resolveGmailProxy({ ...env, IMAP_MCP_GMAIL_PROXY: 'http://other.example.test:8888' }, 'mail')).toBe('http://other.example.test:8888');
  });
  it('accepts a dynamically detected system proxy on another port', () => {
    expect(resolveGmailProxy({}, 'http', () => 'http://localhost:48123')).toBe('http://localhost:48123');
  });
  it('accepts lowercase settings and rejects unsupported OAuth proxy protocols', () => {
    expect(resolveGmailProxy({ https_proxy: 'http://proxy.example.test:11111' })).toBe('http://proxy.example.test:11111');
    expect(() => resolveGmailProxy({ IMAP_MCP_GMAIL_PROXY: 'socks5://proxy.example.test:1090' })).toThrow(/HTTP or HTTPS/);
  });
  it('prevents a configured NO_PROXY rule from bypassing OAuth and closes its dispatcher', async () => {
    const close = vi.fn(async () => undefined);
    const dispatcher = { close } as any;
    const createAgent = vi.fn(() => dispatcher);
    const request = vi.fn(async (_input: unknown, init: any) => { expect(init.dispatcher).toBe(dispatcher); return new Response('{}'); });
    const transport = createProxyAwareFetch({ HTTPS_PROXY: env.HTTPS_PROXY, NO_PROXY: '*' }, { createAgent, request: request as any }, 'gmail-required');
    await transport.fetch('https://oauth2.googleapis.com/token');
    await transport.close();
    expect(createAgent).toHaveBeenCalledWith({ httpProxy: env.HTTPS_PROXY, httpsProxy: env.HTTPS_PROXY });
    expect(close).toHaveBeenCalledOnce();
  });
});
