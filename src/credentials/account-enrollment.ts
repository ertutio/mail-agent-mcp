import type { AccountManager } from '../services/account-manager.js';
import type { ImapAccount } from '../types/index.js';
import type { CredentialBackend } from './credential-backend.js';
import { credentialTarget, gmailClientSecretTarget } from './credential-backend.js';

export interface QqEnrollmentInput {
  email: string;
  name: string;
  authorizationCode: string;
}

export interface GmailEnrollmentInput {
  email: string;
  name: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

type EnrollmentAccountManager = Pick<AccountManager, 'addAccount'>;
export const NETEASE_ENDPOINTS = {
  '163': { imapHost: 'imap.163.com', smtpHost: 'smtp.163.com', smtpPort: 465 },
  '126': { imapHost: 'imap.126.com', smtpHost: 'smtp.126.com', smtpPort: 465 },
  'yeah': { imapHost: 'imap.yeah.net', smtpHost: 'smtp.yeah.net', smtpPort: 465 },
  'netease-enterprise': { imapHost: 'imaphz.qiye.163.com', smtpHost: 'smtphz.qiye.163.com', smtpPort: 994 },
} as const;

interface CredentialSnapshot {
  exists: boolean;
  value?: string;
}

export class AccountEnrollmentService {
  constructor(
    private readonly credentials: CredentialBackend,
    private readonly accounts: EnrollmentAccountManager,
  ) {}

  async enrollNetease(input: QqEnrollmentInput & { provider: keyof typeof NETEASE_ENDPOINTS }): Promise<ImapAccount> {
    const endpoint = NETEASE_ENDPOINTS[input.provider];
    if (!endpoint) throw new Error('Unsupported NetEase provider');
    const email = required(input.email, 'Email address').toLowerCase();
    const name = required(input.name, 'Account name');
    const authorizationCode = required(input.authorizationCode, 'Client authorization code');
    const target = credentialTarget('netease', email);
    return this.persist([{ target, secret: authorizationCode }], {
      name, email, user: email, host: endpoint.imapHost, port: 993, tls: true, password: '',
      smtp: { host: endpoint.smtpHost, port: endpoint.smtpPort, secure: true, user: email, password: '' },
      auth: { kind: 'credential', provider: 'netease', credentialTarget: target,
        endpoints: { ...endpoint, imapPort: 993 } },
    });
  }

  async enrollQq(input: QqEnrollmentInput): Promise<ImapAccount> {
    const email = required(input.email, 'QQ email').toLowerCase();
    const name = required(input.name, 'Account name');
    const authorizationCode = required(input.authorizationCode, 'QQ authorization code');
    const target = credentialTarget('qq', email);

    return this.persist([{ target, secret: authorizationCode }], {
      name,
      email,
      host: 'imap.qq.com',
      port: 993,
      user: email,
      password: '',
      tls: true,
      smtp: {
        host: 'smtp.qq.com',
        port: 465,
        secure: true,
        user: email,
        password: '',
      },
      auth: {
        kind: 'credential',
        provider: 'qq',
        credentialTarget: target,
      },
    });
  }

  async enrollGmail(input: GmailEnrollmentInput): Promise<ImapAccount> {
    const email = required(input.email, 'Gmail email').toLowerCase();
    const name = required(input.name, 'Account name');
    const clientId = required(input.clientId, 'Gmail OAuth clientId');
    const clientSecret = required(input.clientSecret, 'Gmail OAuth client secret');
    const refreshToken = required(input.refreshToken, 'Gmail refresh token');
    const target = credentialTarget('gmail', email);
    const clientSecretTarget = gmailClientSecretTarget(email);

    return this.persist([
      { target, secret: refreshToken },
      { target: clientSecretTarget, secret: clientSecret },
    ], {
      name,
      email,
      host: 'imap.gmail.com',
      port: 993,
      user: email,
      password: '',
      tls: true,
      smtp: {
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        user: email,
        password: '',
      },
      auth: {
        kind: 'oauth2',
        provider: 'gmail',
        credentialTarget: target,
        clientId,
        clientSecretTarget,
      },
    });
  }

  private async persist(
    credentials: Array<{ target: string; secret: string }>,
    account: Omit<ImapAccount, 'id'>,
  ): Promise<ImapAccount> {
    const snapshots = credentials.map(({ target, secret }) => ({
      ...this.snapshot(target),
      target,
      secret,
    }));
    const written: Array<CredentialSnapshot & { target: string; secret: string }> = [];

    try {
      for (const snapshot of snapshots) {
        this.credentials.write(snapshot.target, snapshot.secret);
        written.push(snapshot);
      }
      return await this.accounts.addAccount(account);
    } catch (cause) {
      let rollbackFailed = false;
      for (const snapshot of written.reverse()) {
        try {
          if (snapshot.exists) {
            this.credentials.write(snapshot.target, snapshot.value!);
          } else if (!this.credentials.delete(snapshot.target)) {
            throw new Error('Credential deletion failed');
          }
        } catch {
          rollbackFailed = true;
        }
      }
      if (rollbackFailed) {
        throw new Error('Account enrollment failed and credential rollback failed', {
          cause,
        });
      }
      throw cause;
    }
  }

  private snapshot(target: string): CredentialSnapshot {
    const handle = this.credentials.read(target);
    if (!handle) return { exists: false };

    try {
      const value = handle.read();
      if (typeof value !== 'string') {
        throw new Error('Stored credential has an invalid value');
      }
      return { exists: true, value };
    } finally {
      handle.dispose();
    }
  }
}

function required(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}
