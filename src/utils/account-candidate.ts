import type { AccountAuth, ImapAccount, SmtpConfig } from '../types/index.js';

/**
 * Pure validation and normalization for account candidates (T07 / BUG-SEC-06).
 *
 * A "candidate" is everything a caller may hand to AccountManager.addAccount
 * (or merge into updateAccount) before it is written to accounts.json. The
 * contract, checked here with zero side effects:
 *
 * - Only known fields pass. Unknown extras are rejected by name instead of
 *   being silently persisted.
 * - Types are enforced: ports are integers 1..65535, booleans are booleans,
 *   strings are strings.
 * - Credential rules: `null` credentials are rejected (a missing credential is
 *   an absent key, not null); the empty string is accepted only as the
 *   env-managed placeholder for user/password/smtp credentials.
 * - Defaults: `tls` defaults to true; `port` defaults to 993, or 143 when the
 *   candidate opts out of TLS.
 * - Provider credential references (`auth`) get structural validation; target
 *   existence and endpoint binding stay with the existing credential checks.
 *
 * The returned object is a fresh, normalized candidate — callers persist that,
 * never the raw input.
 */
export class CandidateValidationError extends Error {}

const SMTP_AUTH_METHODS = new Set(['PLAIN', 'LOGIN', 'CRAM-MD5', 'XOAUTH2']);
const AUTH_PROVIDERS = new Set(['gmail', 'qq', 'netease']);

const CANDIDATE_FIELDS = new Set([
  'id', 'name', 'host', 'port', 'user', 'password', 'auth', 'tls', 'email',
  'loginMethod', 'authTimeout', 'connTimeout', 'keepalive', 'smtp',
  'saveToSent', 'sentFolder', 'defaultBcc',
]);

const AUTH_FIELDS = new Set([
  'kind', 'provider', 'credentialTarget', 'clientId', 'clientSecretTarget', 'endpoints',
]);

const SMTP_FIELDS = new Set([
  'host', 'port', 'secure', 'user', 'password', 'authMethod', 'tls',
]);

function fail(message: string): never {
  throw new CandidateValidationError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(container: Record<string, unknown>, key: string, options: { optional?: boolean; allowEmpty?: boolean; max?: number; trim?: boolean; prefix?: string } = {}): string | undefined {
  const value = container[key];
  const label = options.prefix ? `${options.prefix}${key}` : key;
  if (value === undefined) {
    if (options.optional) return undefined;
    fail(`${label} is required`);
  }
  if (typeof value !== 'string') fail(`${label} must be a string`);
  const trimmed = value.trim();
  if (!options.allowEmpty && trimmed.length === 0) fail(`${label} must not be empty`);
  if (options.max !== undefined && value.length > options.max) fail(`${label} exceeds ${options.max} characters`);
  // Normalized fields return the trimmed value so the persisted record, the
  // returned account and the validated candidate are one and the same.
  return options.trim ? trimmed : value;
}

function booleanField(container: Record<string, unknown>, key: string, fallback?: boolean): boolean | undefined {
  const value = container[key];
  if (value === undefined) {
    if (fallback === undefined) return undefined;
    return fallback;
  }
  if (typeof value !== 'boolean') fail(`${key} must be a boolean`);
  return value;
}

function portField(container: Record<string, unknown>, key: string, fallback?: number): number | undefined {
  const value = container[key];
  if (value === undefined) {
    if (fallback === undefined) return undefined;
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) fail(`${key} must be an integer between 1 and 65535`);
  return value;
}

function optionalPositiveInteger(container: Record<string, unknown>, key: string): number | undefined {
  const value = container[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) fail(`${key} must be a positive integer`);
  return value;
}

function validateAuth(value: unknown): AccountAuth {
  if (!isPlainObject(value)) fail('auth must be an object');
  for (const key of Object.keys(value)) {
    if (!AUTH_FIELDS.has(key)) fail(`auth.${key} is not a known field`);
  }
  const kind = value.kind;
  if (kind !== 'credential' && kind !== 'oauth2') fail('auth.kind must be "credential" or "oauth2"');
  const provider = value.provider;
  if (typeof provider !== 'string' || !AUTH_PROVIDERS.has(provider)) {
    fail('auth.provider must be one of gmail, qq, netease');
  }
  const credentialTarget = stringField(value, 'credentialTarget', { max: 512 });
  if (!credentialTarget) fail('auth.credentialTarget is required');
  if (kind === 'oauth2' && provider !== 'gmail') fail('oauth2 auth is only supported for gmail');
  if (value.clientId !== undefined && typeof value.clientId !== 'string') fail('auth.clientId must be a string');
  if (value.clientSecretTarget !== undefined && (typeof value.clientSecretTarget !== 'string' || value.clientSecretTarget.length === 0)) {
    fail('auth.clientSecretTarget must be a non-empty string');
  }
  if (provider === 'netease') {
    const endpoints = value.endpoints as Record<string, unknown>;
    if (!isPlainObject(endpoints)) fail('netease auth requires endpoints');
    for (const key of Object.keys(endpoints)) {
      if (!['imapHost', 'imapPort', 'smtpHost', 'smtpPort'].includes(key)) fail(`auth.endpoints.${key} is not a known field`);
    }
    if (typeof endpoints.imapHost !== 'string' || endpoints.imapHost.trim().length === 0) fail('auth.endpoints.imapHost must be a non-empty string');
    if (typeof endpoints.smtpHost !== 'string' || endpoints.smtpHost.trim().length === 0) fail('auth.endpoints.smtpHost must be a non-empty string');
    const imapPort = endpoints.imapPort;
    const smtpPort = endpoints.smtpPort;
    if (typeof imapPort !== 'number' || !Number.isInteger(imapPort) || imapPort < 1 || imapPort > 65535) fail('auth.endpoints.imapPort must be an integer between 1 and 65535');
    if (typeof smtpPort !== 'number' || !Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) fail('auth.endpoints.smtpPort must be an integer between 1 and 65535');
  }
  return value as unknown as AccountAuth;
}

function validateSmtp(value: unknown): SmtpConfig {
  if (!isPlainObject(value)) fail('smtp must be an object');
  for (const key of Object.keys(value)) {
    if (!SMTP_FIELDS.has(key)) fail(`smtp.${key} is not a known field`);
  }
  // Same missing/null/default contract as the top level: null is rejected,
  // secure defaults to true, and the port derives from it (465/587) when the
  // caller omits it.
  const secure = booleanField(value, 'secure', true)!;
  const smtp: SmtpConfig = {
    host: stringField(value, 'host', { max: 253, trim: true, prefix: 'smtp.' })!,
    port: portField(value, 'port', secure ? 465 : 587)!,
    secure,
  };
  const user = stringField(value, 'user', { optional: true, allowEmpty: true, max: 320, trim: true, prefix: 'smtp.' });
  const password = stringField(value, 'password', { optional: true, allowEmpty: true, max: 4096, prefix: 'smtp.' });
  if (user !== undefined) smtp.user = user;
  if (password !== undefined) smtp.password = password;
  const authMethod = value.authMethod;
  if (authMethod !== undefined) {
    if (typeof authMethod !== 'string' || !SMTP_AUTH_METHODS.has(authMethod)) {
      fail('smtp.authMethod must be one of PLAIN, LOGIN, CRAM-MD5, XOAUTH2');
    }
    smtp.authMethod = authMethod as SmtpConfig['authMethod'];
  }
  if (value.tls !== undefined) {
    const tls = value.tls;
    if (!isPlainObject(tls)) fail('smtp.tls must be an object');
    for (const key of Object.keys(tls)) {
      if (key !== 'rejectUnauthorized') fail(`smtp.tls.${key} is not a known field`);
    }
    const rejectUnauthorized = tls.rejectUnauthorized;
    if (rejectUnauthorized !== undefined && typeof rejectUnauthorized !== 'boolean') {
      fail('smtp.tls.rejectUnauthorized must be a boolean');
    }
    smtp.tls = rejectUnauthorized === undefined ? {} : { rejectUnauthorized };
  }
  return smtp;
}

function validateDefaultBcc(value: unknown): string | string[] {
  if (typeof value === 'string') {
    if (value.trim().length === 0) fail('defaultBcc must not be empty');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) fail('defaultBcc must not be empty');
    for (const entry of value) {
      if (typeof entry !== 'string' || entry.trim().length === 0) {
        fail('defaultBcc entries must be non-empty strings');
      }
    }
    return value as string[];
  }
  fail('defaultBcc must be a string or an array of strings');
}

export interface AccountCandidate extends Omit<ImapAccount, 'id'> {
  id?: string;
}

export function validateAccountCandidate(input: unknown): AccountCandidate {
  if (!isPlainObject(input)) fail('account candidate must be a plain object');
  for (const key of Object.keys(input)) {
    if (!CANDIDATE_FIELDS.has(key)) fail(`${key} is not a known account field`);
  }

  const tls = booleanField(input, 'tls', true)!;
  const port = portField(input, 'port', tls ? 993 : 143)!;

  const candidate: AccountCandidate = {
    name: stringField(input, 'name', { max: 200, trim: true })!,
    host: stringField(input, 'host', { max: 253, trim: true })!,
    port,
    user: stringField(input, 'user', { allowEmpty: true, max: 320, trim: true })!,
    password: stringField(input, 'password', { optional: true, allowEmpty: true, max: 4096 }) ?? '',
    tls,
  };

  if (input.id !== undefined) {
    if (typeof input.id !== 'string' || input.id.length === 0) fail('id must be a non-empty string');
    candidate.id = input.id;
  }
  const email = stringField(input, 'email', { optional: true, max: 320, trim: true });
  if (email !== undefined) candidate.email = email;
  const loginMethod = stringField(input, 'loginMethod', { optional: true, max: 32, trim: true });
  if (loginMethod !== undefined) candidate.loginMethod = loginMethod;
  const authTimeout = optionalPositiveInteger(input, 'authTimeout');
  if (authTimeout !== undefined) candidate.authTimeout = authTimeout;
  const connTimeout = optionalPositiveInteger(input, 'connTimeout');
  if (connTimeout !== undefined) candidate.connTimeout = connTimeout;
  const keepalive = booleanField(input, 'keepalive');
  if (keepalive !== undefined) candidate.keepalive = keepalive;
  if (input.smtp !== undefined) candidate.smtp = validateSmtp(input.smtp);
  const saveToSent = booleanField(input, 'saveToSent');
  if (saveToSent !== undefined) candidate.saveToSent = saveToSent;
  const sentFolder = stringField(input, 'sentFolder', { optional: true, max: 1024, trim: true });
  if (sentFolder !== undefined) candidate.sentFolder = sentFolder;
  if (input.defaultBcc !== undefined) candidate.defaultBcc = validateDefaultBcc(input.defaultBcc);
  if (input.auth !== undefined) candidate.auth = validateAuth(input.auth);

  return candidate;
}
