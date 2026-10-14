import { windowsLoopbackProxy } from './windows-system-proxy.js';

export function resolveGmailProxy(
  env: NodeJS.ProcessEnv = process.env,
  transport: 'http' | 'mail' = 'http',
  systemProxy: () => string | undefined = windowsLoopbackProxy,
): string {
  const standard = env.HTTPS_PROXY?.trim() || env.https_proxy?.trim() || env.HTTP_PROXY?.trim() || env.http_proxy?.trim();
  const mail = env.IMAP_MCP_MAIL_PROXY?.trim();
  const configured = env.IMAP_MCP_GMAIL_PROXY?.trim()
    || (transport === 'mail' ? mail || standard : standard || mail)
    || systemProxy();
  if (!configured) throw new Error('Gmail requires a proxy. Configure IMAP_MCP_GMAIL_PROXY or HTTPS_PROXY, or enable a Windows local HTTP proxy. Direct fallback is disabled.');
  try {
    const parsed = new URL(configured);
    const supported = transport === 'http' ? ['http:', 'https:'] : ['http:', 'https:', 'socks:', 'socks4:', 'socks4a:', 'socks5:'];
    if (!parsed.hostname || !supported.includes(parsed.protocol)) throw new Error('unsupported');
  } catch {
    throw new Error(transport === 'http' ? 'Gmail OAuth requires an HTTP or HTTPS proxy URL' : 'Gmail mail transport requires a supported proxy URL');
  }
  return configured;
}
