import type { ImapAccount } from '../types/index.js';
import type { CredentialBackend, SecretHandle } from './credential-backend.js';
import { credentialTargetsForAccount, gmailClientSecretTargetsForAccount } from './credential-backend.js';

export type ResolvedAccountAuth =
  | { kind: 'password'; user: string; password: string }
  | { kind: 'oauth2'; user: string; accessToken: string };

export type GmailAccessTokenExchange = (
  refreshToken: string,
  account: ImapAccount,
) => Promise<string> | string;

function readSecret(handle: SecretHandle): string {
  try {
    const value = handle.read();
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('Malformed credential');
    }
    return value;
  } finally {
    handle.dispose();
  }
}

export function assertCredentialTarget(account: ImapAccount): void {
  if (!account.auth) return;
  const validProviderKind =
    (account.auth.provider === 'qq' && account.auth.kind === 'credential')
    || (account.auth.provider === 'netease' && account.auth.kind === 'credential')
    || (account.auth.provider === 'gmail' && account.auth.kind === 'oauth2');
  const expected = validProviderKind
    ? credentialTargetsForAccount(account.auth.provider, account.user)
    : [];
  if (!expected.includes(account.auth.credentialTarget)) {
    throw new Error('Credential target mismatch for account');
  }
  if (
    account.auth.kind === 'oauth2'
    && account.auth.clientSecretTarget !== undefined
    && !gmailClientSecretTargetsForAccount(account.user).includes(account.auth.clientSecretTarget)
  ) {
    throw new Error('Credential target mismatch for account');
  }
}

export function assertProviderEndpoints(account: ImapAccount): void {
  if (!account.auth) return;
  const normalize = (host: string) => host.trim().toLowerCase().replace(/\.$/, '');
  const provider = account.auth.provider;
  if (provider === 'qq' || provider === 'gmail') {
    if (normalize(account.host) !== `imap.${provider}.com` || account.port !== 993 || account.tls !== true) {
      throw new Error('Credential endpoint mismatch: provider IMAP requires its canonical host and TLS port 993');
    }
    if (account.smtp && (normalize(account.smtp.host) !== `smtp.${provider}.com`
      || ![465,587].includes(account.smtp.port)
      || (account.smtp.port === 465 && account.smtp.secure !== true))) {
      throw new Error('Credential endpoint mismatch: provider SMTP requires its canonical TLS endpoint');
    }
  } else if (provider === 'netease' && account.auth.kind === 'credential') {
    const binding = account.auth.endpoints;
    if (!binding || account.host !== binding.imapHost || account.port !== binding.imapPort || account.tls !== true
      || (account.smtp && (account.smtp.host !== binding.smtpHost || account.smtp.port !== binding.smtpPort || account.smtp.secure !== true))) {
      throw new Error('Credential endpoint mismatch; re-enroll locally to change servers');
    }
  }
  if (account.smtp?.tls?.rejectUnauthorized === false) throw new Error('Provider TLS verification cannot be disabled');
}

export class AccountAuthResolver {
  constructor(
    private readonly backend?: CredentialBackend,
    private readonly gmailAccessTokenExchange?: GmailAccessTokenExchange,
  ) {}

  async resolve(
    account: ImapAccount,
    protocol: 'imap' | 'smtp' = 'imap',
  ): Promise<ResolvedAccountAuth> {
    if (!account.auth) {
      const smtp = protocol === 'smtp' ? account.smtp : undefined;
      return { kind: 'password', user: smtp?.user || account.user, password: smtp?.password || account.password };
    }
    assertCredentialTarget(account);
    assertProviderEndpoints(account);
    if (account.auth.kind === 'credential' && account.auth.provider === 'netease') {
      const binding = account.auth.endpoints;
      const endpoint = protocol === 'imap' ? { host: account.host, port: account.port, secure: account.tls }
        : { host: account.smtp?.host, port: account.smtp?.port, secure: account.smtp?.secure };
      const expectedHost = protocol === 'imap' ? binding.imapHost : binding.smtpHost;
      const expectedPort = protocol === 'imap' ? binding.imapPort : binding.smtpPort;
      if (endpoint.host !== expectedHost || endpoint.port !== expectedPort || endpoint.secure !== true) {
        throw new Error('Credential endpoint mismatch; re-enroll locally to change servers');
      }
    }
    if (!this.backend) {
      throw new Error('Credential backend is not configured');
    }
    const handle = this.backend.read(account.auth.credentialTarget);
    if (!handle) throw new Error('Credential not found');
    const secret = readSecret(handle);
    const user = protocol === 'smtp' ? account.smtp?.user ?? account.user : account.user;
    if (account.auth.kind === 'credential') {
      return { kind: 'password', user, password: secret };
    }
    if (!this.gmailAccessTokenExchange) {
      throw new Error('Gmail refresh-token exchange is not configured; password fallback is disabled');
    }
    const accessToken = await this.gmailAccessTokenExchange(secret, account);
    if (!accessToken) throw new Error('Gmail refresh-token exchange returned an empty access token');
    return { kind: 'oauth2', user, accessToken };
  }
}

export function buildImapAuth(auth: ResolvedAccountAuth):
  { user: string; pass: string } | { user: string; accessToken: string } {
  return auth.kind === 'password' ? { user: auth.user, pass: auth.password } : { user: auth.user, accessToken: auth.accessToken };
}

export function buildSmtpAuth(auth: ResolvedAccountAuth):
  { user: string; pass: string } | { type: 'OAuth2'; user: string; accessToken: string } {
  return auth.kind === 'password'
    ? { user: auth.user, pass: auth.password }
    : { type: 'OAuth2', user: auth.user, accessToken: auth.accessToken };
}

export function accountForPersistence(account: ImapAccount): ImapAccount {
  if (!account.auth) return account;
  assertCredentialTarget(account);
  assertProviderEndpoints(account);
  const stored: ImapAccount = { ...account, password: '' };
  if (account.smtp) {
    const { password: _secret, ...smtp } = account.smtp;
    stored.smtp = smtp;
  }
  return stored;
}
