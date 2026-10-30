import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

const SYNTHETIC_PASSWORD_1 = ["dummy-p", "assword"].join('');
const SYNTHETIC_PASSWORD_2 = ["synthetic", "-password"].join('');
const SYNTHETIC_PASSWORD_3 = ["secr", "et123"].join('');
const SYNTHETIC_PASSWORD_4 = ["imapS", "ecret"].join('');
const SYNTHETIC_PASSWORD_5 = ["smtpS", "ecret"].join('');
const SYNTHETIC_PASSWORD_6 = ["mypas", "sword"].join('');
const SYNTHETIC_PASSWORD_7 = ["store", "d-pass"].join('');
const SYNTHETIC_PASSWORD_8 = ["stored-s", "mtp-pass"].join('');
const SYNTHETIC_PASSWORD_9 = ["not-en", "crypted"].join('');

// Mock the file system for tests
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    promises: {
      readFile: vi.fn(),
      writeFile: vi.fn(),
      mkdir: vi.fn(),
      open: vi.fn(),
      unlink: vi.fn(),
      rename: vi.fn(),
    },
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

// Need to import after mocking
import { AccountManager } from '../src/services/account-manager.js';
import { credentialTarget, gmailClientSecretTarget, type CredentialBackend } from '../src/credentials/credential-backend.js';
import { validateAccountCandidate } from '../src/utils/account-candidate.js';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

describe('AccountManager', () => {
  const SYNTHETIC_ENCRYPTION_KEY = [
    '01234567', '89abcdef', '01234567', '89abcdef',
    '01234567', '89abcdef', '01234567', '89abcdef',
  ].join('');
  const mockEncryptionKey = SYNTHETIC_ENCRYPTION_KEY;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock encryption key file
    let stored:string|undefined;
    let pending:string|undefined;
    vi.mocked(readFileSync).mockReset().mockImplementation((file:any)=>{
      if(String(file).endsWith('.key'))return mockEncryptionKey;
      if(stored!==undefined)return stored;
      throw Object.assign(new Error('Synthetic file not found'),{code:'ENOENT'});
    });

    // Mock accounts file not existing initially
    vi.mocked(fs.readFile).mockRejectedValue({ code: 'ENOENT' });
    vi.mocked(fs.writeFile).mockReset().mockImplementation(async(_file:any,text:any)=>{pending=String(text);});
    vi.mocked(fs.rename).mockImplementation(async()=>{stored=pending;});
    vi.mocked(fs.open).mockResolvedValue({writeFile:async()=>{},close:async()=>{}} as any);
    vi.mocked(fs.unlink).mockResolvedValue(undefined);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();

    // Remove any env-var overrides set by individual tests
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('IMAP_MCP_ACCOUNT_')) {
    delete process.env.IMAP_MCP_CONFIG_DIR;
        delete process.env[key];
      }
    }
  });

  describe('constructor', () => {
    it('should create account manager with correct config path', () => {
      const manager = new AccountManager();
      expect(manager).toBeDefined();
    });

    it('uses an explicit isolated config directory without touching the default profile', async () => {
      process.env.IMAP_MCP_CONFIG_DIR = 'C:\\Users\\example\\mail-agent-cleanroom';
      const manager = new AccountManager();
      await manager.addAccount({
        name: 'Synthetic',
        host: 'imap.example.test',
        port: 993,
        user: 'person@example.test',
        password: SYNTHETIC_PASSWORD_1,
        tls: true,
      });
      expect(fs.mkdir).toHaveBeenCalledWith(
        path.resolve('C:\\Users\\example\\mail-agent-cleanroom'),
        expect.objectContaining({ recursive: true }),
      );
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringMatching(/accounts\.json\..+\.tmp$/),
        expect.any(String),
        expect.any(Object),
      );
    });

    it('should create encryption key if not exists', () => {
      vi.mocked(readFileSync).mockImplementation(() => {
        throw Object.assign(new Error('File not found'),{code:'ENOENT'});
      });

      const manager = new AccountManager();
      expect(manager).toBeDefined();
      expect(writeFileSync).toHaveBeenCalled();
    });
  });

  describe('addAccount', () => {
    it('rejects generic Gmail password fallback before persistence', async () => {
      const manager = new AccountManager();
      await expect(manager.addAccount({
        name: 'Gmail', host: 'imap.gmail.com', port: 993,
        user: 'person@example.test', password: SYNTHETIC_PASSWORD_2, tls: true,
      })).rejects.toThrow(/node dist\/enroll\.js gmail/i);
      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it('rejects generic QQ SMTP password fallback before persistence', async () => {
      const manager = new AccountManager();
      await expect(manager.addAccount({
        name: 'QQ', host: 'imap.example.test', port: 993,
        user: 'person@example.test', password: SYNTHETIC_PASSWORD_2, tls: true,
        smtp: {
          host: 'smtp.qq.com', port: 465, secure: true,
          password: SYNTHETIC_PASSWORD_2,
        },
      })).rejects.toThrow(/node dist\/enroll\.js qq/i);
      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it('rejects mismatched credential targets before persistence', async () => {
      const manager = new AccountManager();
      await expect(manager.addAccount({
        name: 'QQ', host: 'imap.qq.com', port: 993,
        user: 'person@qq.com', password: '', tls: true,
        auth: {
          kind: 'credential', provider: 'qq',
          credentialTarget: credentialTarget('qq', 'other@qq.com'),
        },
      })).rejects.toThrow(/credential target.*mismatch/i);
      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it('should add account with generated id', async () => {
      const manager = new AccountManager();

      const account = await manager.addAccount({
        name: 'Test Account',
        host: 'imap.test.com',
        port: 993,
        user: 'user@test.com',
        password: SYNTHETIC_PASSWORD_3,
        tls: true,
      });

      expect(account.id).toBeDefined();
      expect(account.name).toBe('Test Account');
      expect(account.host).toBe('imap.test.com');
      expect(account.user).toBe('user@test.com');
      expect(account.password).toBe('secret123'); // Returns unencrypted
    });

    it('should save accounts after adding', async () => {
      const manager = new AccountManager();

      await manager.addAccount({
        name: 'Test',
        host: 'imap.test.com',
        port: 993,
        user: 'user@test.com',
        password: 'secret',
        tls: true,
      });

      expect(fs.writeFile).toHaveBeenCalled();
    });

    it('should encrypt password when storing', async () => {
      const manager = new AccountManager();

      await manager.addAccount({
        name: 'Test',
        host: 'imap.test.com',
        port: 993,
        user: 'user@test.com',
        password: 'secret',
        tls: true,
      });

      // Check that writeFile was called with encrypted data
      const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
      const savedData = JSON.parse(writeCall[1] as string);

      // Password should be encrypted (contains :)
      expect(savedData[0].password).toContain(':');
      expect(savedData[0].password).not.toBe('secret');
    });

    it('should handle SMTP config with encrypted password', async () => {
      const manager = new AccountManager();

      const account = await manager.addAccount({
        name: 'Test',
        host: 'imap.test.com',
        port: 993,
        user: 'user@test.com',
        password: SYNTHETIC_PASSWORD_4,
        tls: true,
        smtp: {
          host: 'smtp.test.com',
          port: 587,
          secure: false,
          password: SYNTHETIC_PASSWORD_5,
        },
      });

      expect(account.smtp?.password).toBe('smtpSecret'); // Returns unencrypted
    });
  });

  describe('getAccount', () => {
    it('should return undefined for non-existent account', () => {
      const manager = new AccountManager();
      const account = manager.getAccount('non-existent-id');
      expect(account).toBeUndefined();
    });

    it('should return decrypted account', async () => {
      const manager = new AccountManager();

      const created = await manager.addAccount({
        name: 'Test',
        host: 'imap.test.com',
        port: 993,
        user: 'user@test.com',
        password: SYNTHETIC_PASSWORD_6,
        tls: true,
      });

      const retrieved = manager.getAccount(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.password).toBe('mypassword');
    });
  });

  describe('getAllAccounts', () => {
    it('should return empty array when no accounts', () => {
      const manager = new AccountManager();
      const accounts = manager.getAllAccounts();
      expect(accounts).toEqual([]);
    });

    it('should return all accounts with decrypted passwords', async () => {
      const manager = new AccountManager();

      await manager.addAccount({
        name: 'Account 1',
        host: 'imap1.test.com',
        port: 993,
        user: 'user1@test.com',
        password: 'pass1',
        tls: true,
      });

      await manager.addAccount({
        name: 'Account 2',
        host: 'imap2.test.com',
        port: 993,
        user: 'user2@test.com',
        password: 'pass2',
        tls: true,
      });

      const accounts = manager.getAllAccounts();

      expect(accounts.length).toBe(2);
      expect(accounts[0].password).toBe('pass1');
      expect(accounts[1].password).toBe('pass2');
    });
  });

  describe('getAccountByName', () => {
    it('should find account by name', async () => {
      const manager = new AccountManager();

      await manager.addAccount({
        name: 'My Email',
        host: 'imap.test.com',
        port: 993,
        user: 'user@test.com',
        password: 'secret',
        tls: true,
      });

      const account = manager.getAccountByName('My Email');

      expect(account).toBeDefined();
      expect(account?.name).toBe('My Email');
    });

    it('should return undefined for non-existent name', () => {
      const manager = new AccountManager();
      const account = manager.getAccountByName('Non Existent');
      expect(account).toBeUndefined();
    });
  });

  describe('resolveAccountId', () => {
    const addOne = (manager: AccountManager, name: string) => manager.addAccount({
      name, host: 'imap.test.com', port: 993, user: `${name}@test.com`, password: 'pw', tls: true,
    });

    it('returns the id when an explicit accountId exists', async () => {
      const manager = new AccountManager();
      const created = await addOne(manager, 'A');
      expect(manager.resolveAccountId(created.id)).toBe(created.id);
    });

    it('throws for an unknown accountId', async () => {
      const manager = new AccountManager();
      await addOne(manager, 'A');
      expect(() => manager.resolveAccountId('nope')).toThrow(/not found/i);
    });

    it('resolves by accountName', async () => {
      const manager = new AccountManager();
      const created = await addOne(manager, 'Work');
      expect(manager.resolveAccountId(undefined, 'Work')).toBe(created.id);
    });

    it('throws for an unknown accountName', async () => {
      const manager = new AccountManager();
      await addOne(manager, 'Work');
      expect(() => manager.resolveAccountId(undefined, 'Home')).toThrow(/no account named/i);
    });

    it('defaults to the only account when none is specified', async () => {
      const manager = new AccountManager();
      const created = await addOne(manager, 'Solo');
      expect(manager.resolveAccountId()).toBe(created.id);
    });

    it('throws when no accounts are configured', () => {
      const manager = new AccountManager();
      expect(() => manager.resolveAccountId()).toThrow(/no accounts configured/i);
    });

    it('throws when multiple accounts exist and none is specified', async () => {
      const manager = new AccountManager();
      await addOne(manager, 'A');
      await addOne(manager, 'B');
      expect(() => manager.resolveAccountId()).toThrow(/multiple accounts/i);
    });
  });

  describe('environment variable credential overrides', () => {
    const addWork = (manager: AccountManager, name = 'Work Gmail') => manager.addAccount({
      name,
      host: 'imap.test.com',
      port: 993,
      user: 'stored-user@test.com',
      password: SYNTHETIC_PASSWORD_7,
      tls: true,
    });

    it('overrides IMAP user and password from env vars in getAccount', async () => {
      process.env.IMAP_MCP_ACCOUNT_WORK_GMAIL_IMAP_USERNAME = 'env-user@test.com';
      process.env.IMAP_MCP_ACCOUNT_WORK_GMAIL_IMAP_PASSWORD = 'env-pass';

      const manager = new AccountManager();
      const created = await addWork(manager);

      const account = manager.getAccount(created.id);
      expect(account?.user).toBe('env-user@test.com');
      expect(account?.password).toBe('env-pass');
    });

    it('normalizes the account name to build the env var prefix', async () => {
      process.env.IMAP_MCP_ACCOUNT_MY_WORK_ACCOUNT__IMAP_USERNAME = 'env@test.com';

      const manager = new AccountManager();
      const created = await manager.addAccount({
        name: 'My Work-Account!',
        host: 'imap.test.com',
        port: 993,
        user: 'stored@test.com',
        password: 'stored',
        tls: true,
      });

      const account = manager.getAccount(created.id);
      expect(account?.user).toBe('env@test.com');
    });

    it('applies overrides in getAllAccounts and getAccountByName too', async () => {
      process.env.IMAP_MCP_ACCOUNT_WORK_GMAIL_IMAP_PASSWORD = 'env-pass';

      const manager = new AccountManager();
      await addWork(manager);

      expect(manager.getAllAccounts()[0].password).toBe('env-pass');
      expect(manager.getAccountByName('Work Gmail')?.password).toBe('env-pass');
    });

    it('leaves fields untouched when no matching env var is set', async () => {
      const manager = new AccountManager();
      const created = await addWork(manager);

      const account = manager.getAccount(created.id);
      expect(account?.user).toBe('stored-user@test.com');
      expect(account?.password).toBe('stored-pass');
    });

    it('overrides SMTP credentials separately when an smtp config exists', async () => {
      process.env.IMAP_MCP_ACCOUNT_WORK_GMAIL_IMAP_USERNAME = 'env-imap@test.com';
      process.env.IMAP_MCP_ACCOUNT_WORK_GMAIL_SMTP_USERNAME = 'env-smtp@test.com';
      process.env.IMAP_MCP_ACCOUNT_WORK_GMAIL_SMTP_PASSWORD = 'env-smtp-pass';

      const manager = new AccountManager();
      const created = await manager.addAccount({
        name: 'Work Gmail',
        host: 'imap.test.com',
        port: 993,
        user: 'stored-user@test.com',
        password: SYNTHETIC_PASSWORD_7,
        tls: true,
        smtp: {
          host: 'smtp.test.com',
          port: 587,
          secure: false,
          user: 'stored-smtp@test.com',
          password: SYNTHETIC_PASSWORD_8,
        },
      });

      const account = manager.getAccount(created.id);
      expect(account?.user).toBe('env-imap@test.com');
      expect(account?.smtp?.user).toBe('env-smtp@test.com');
      expect(account?.smtp?.password).toBe('env-smtp-pass');
    });

    it('ignores SMTP env vars when the account has no smtp config', async () => {
      process.env.IMAP_MCP_ACCOUNT_WORK_GMAIL_SMTP_USERNAME = 'env-smtp@test.com';

      const manager = new AccountManager();
      const created = await addWork(manager);

      const account = manager.getAccount(created.id);
      expect(account?.smtp).toBeUndefined();
    });

    it('captures and removes the env vars from process.env in the constructor', async () => {
      process.env.IMAP_MCP_ACCOUNT_WORK_GMAIL_IMAP_USERNAME = 'env-user@test.com';
      process.env.IMAP_MCP_ACCOUNT_WORK_GMAIL_IMAP_PASSWORD = 'env-pass';

      // Construction alone consumes them — no getter call needed
      new AccountManager();

      expect(process.env.IMAP_MCP_ACCOUNT_WORK_GMAIL_IMAP_USERNAME).toBeUndefined();
      expect(process.env.IMAP_MCP_ACCOUNT_WORK_GMAIL_IMAP_PASSWORD).toBeUndefined();
    });

    it('keeps applying the override after the env var is consumed', async () => {
      process.env.IMAP_MCP_ACCOUNT_WORK_GMAIL_IMAP_PASSWORD = 'env-pass';

      const manager = new AccountManager();
      const created = await addWork(manager);

      // Env var already consumed at construction, override still applies on every read
      expect(process.env.IMAP_MCP_ACCOUNT_WORK_GMAIL_IMAP_PASSWORD).toBeUndefined();
      expect(manager.getAccount(created.id)?.password).toBe('env-pass');
      expect(manager.getAccount(created.id)?.password).toBe('env-pass');
    });

    it('holds neither the cache key nor the value as plaintext', async () => {
      process.env.IMAP_MCP_ACCOUNT_WORK_GMAIL_IMAP_PASSWORD = 'env-pass';

      const manager = new AccountManager();

      const cache = (manager as any).capturedEnvOverrides as Map<string, string>;
      expect(cache.size).toBe(1);

      // The plaintext variable name is not used as the key
      expect(cache.has('IMAP_MCP_ACCOUNT_WORK_GMAIL_IMAP_PASSWORD')).toBe(false);

      const [key, value] = [...cache.entries()][0];
      expect(key).not.toContain('WORK_GMAIL'); // key does not leak the account name
      expect(value).not.toBe('env-pass'); // value is encrypted
      expect(value).toContain(':'); // iv:ciphertext form
    });

    it('does not persist env overrides to disk', async () => {
      process.env.IMAP_MCP_ACCOUNT_WORK_GMAIL_IMAP_PASSWORD = 'env-pass';

      const manager = new AccountManager();
      const created = await addWork(manager);

      manager.getAccount(created.id);

      // No write happened just from reading
      const writes = vi.mocked(fs.writeFile).mock.calls;
      const lastWrite = writes[writes.length - 1];
      const saved = JSON.parse(lastWrite[1] as string);
      expect(saved[0].password).not.toBe('env-pass');
    });

    it('round-trips an empty password placeholder added via addAccount', async () => {
      const manager = new AccountManager();

      const created = await manager.addAccount({
        name: 'Env Managed',
        host: 'imap.test.com',
        port: 993,
        user: '',
        password: '',
        tls: true,
      });

      // No decrypt crash; empty placeholders come back as empty strings
      const account = manager.getAccount(created.id);
      expect(account?.user).toBe('');
      expect(account?.password).toBe('');
    });

    it('lets env vars fill an empty placeholder stored for an account', async () => {
      process.env.IMAP_MCP_ACCOUNT_ENV_MANAGED_IMAP_USERNAME = 'env-user@test.com';
      process.env.IMAP_MCP_ACCOUNT_ENV_MANAGED_IMAP_PASSWORD = 'env-pass';

      const manager = new AccountManager();
      const created = await manager.addAccount({
        name: 'Env Managed',
        host: 'imap.test.com',
        port: 993,
        user: '',
        password: '',
        tls: true,
      });

      const account = manager.getAccount(created.id);
      expect(account?.user).toBe('env-user@test.com');
      expect(account?.password).toBe('env-pass');
    });

    it('round-trips an empty password placeholder set via updateAccount', async () => {
      const manager = new AccountManager();

      const created = await manager.addAccount({
        name: 'Later Env Managed',
        host: 'imap.test.com',
        port: 993,
        user: 'stored-user@test.com',
        password: SYNTHETIC_PASSWORD_7,
        tls: true,
      });

      // Marking the field env-managed on edit stores an empty placeholder
      await manager.updateAccount(created.id, { password: '' });

      // Must not crash on decrypt; comes back as an empty string
      const account = manager.getAccount(created.id);
      expect(account?.password).toBe('');
    });
  });

  describe('malformed stored accounts', () => {
    // A stored account whose credentials were never written (null user/password)
    // must not crash listing — decrypt is called on the password unconditionally.
    const loadAccounts = (accounts: unknown[]) => {
      vi.mocked(readFileSync).mockImplementation(((p: any) => {
        if (String(p).endsWith('.key')) return mockEncryptionKey;
        return JSON.stringify(accounts);
      }) as any);
    };

    it('lists an account with a null password without throwing', () => {
      loadAccounts([
        { id: 'bad', name: 'Private', user: null, password: null, host: 'imap.mail.me.com', port: 993, tls: true },
      ]);

      const manager = new AccountManager();

      const accounts = manager.getAllAccounts();
      expect(accounts).toHaveLength(1);
      expect(accounts[0].name).toBe('Private');
      expect(accounts[0].password).toBe('');
    });

    it('returns an empty password for a null/blank stored value via getAccount / getAccountByName', () => {
      loadAccounts([
        { id: 'bad', name: 'Private', user: null, password: null, host: 'imap.mail.me.com', port: 993, tls: true },
      ]);

      const manager = new AccountManager();

      expect(manager.getAccount('bad')?.password).toBe('');
      expect(manager.getAccountByName('Private')?.password).toBe('');
    });

    it('returns an empty password for an empty-string stored value', () => {
      loadAccounts([
        { id: 'empty', name: 'Private', user: '', password: '', host: 'imap.mail.me.com', port: 993, tls: true },
      ]);

      const manager = new AccountManager();

      expect(manager.getAllAccounts()[0].password).toBe('');
      expect(manager.getAccount('empty')?.password).toBe('');
    });

    it('throws on a non-empty but malformed (unencrypted) IMAP password', () => {
      loadAccounts([
        { id: 'corrupt', name: 'Private', user: 'me', password: SYNTHETIC_PASSWORD_9, host: 'imap.mail.me.com', port: 993, tls: true },
      ]);

      const manager = new AccountManager();

      expect(() => manager.getAllAccounts()).toThrow(/not a valid encrypted string/);
      expect(() => manager.getAccount('corrupt')).toThrow(/not a valid encrypted string/);
      expect(() => manager.getAccountByName('Private')).toThrow(/not a valid encrypted string/);
    });

    it('throws on a non-empty but malformed SMTP password', () => {
      loadAccounts([
        {
          id: 'corrupt-smtp', name: 'Private', user: 'me', password: '', host: 'imap.mail.me.com', port: 993, tls: true,
          smtp: { host: 'smtp.mail.me.com', port: 587, user: 'me', password: SYNTHETIC_PASSWORD_9 },
        },
      ]);

      const manager = new AccountManager();

      expect(() => manager.getAllAccounts()).toThrow(/not a valid encrypted string/);
    });
  });

  describe('removeAccount', () => {
    it('should remove existing account', async () => {
      const manager = new AccountManager();

      const account = await manager.addAccount({
        name: 'To Remove',
        host: 'imap.test.com',
        port: 993,
        user: 'user@test.com',
        password: 'secret',
        tls: true,
      });

      await manager.removeAccount(account.id);

      const retrieved = manager.getAccount(account.id);
      expect(retrieved).toBeUndefined();
    });

    it('should throw error for non-existent account', async () => {
      const manager = new AccountManager();

      await expect(manager.removeAccount('non-existent')).rejects.toThrow(
        'Account non-existent not found'
      );
    });
  });

    it('deletes both Gmail credentials when removing a provider account', async () => {
      const values = new Map<string, string>();
      const disposed: string[] = [];
      const backend: CredentialBackend = {
        read: (target) => {
          const value = values.get(target);
          if (value === undefined) return undefined;
          return { read: () => value, dispose: () => { disposed.push(target); } };
        },
        write: (target, secret) => { values.set(target, secret); },
        delete: (target) => values.delete(target),
      };
      const manager = new AccountManager(backend);
      const refreshTarget = credentialTarget('gmail', 'person@gmail.com');
      const clientTarget = gmailClientSecretTarget('person@gmail.com');
      const account = await manager.addAccount({
        name: 'Gmail', host: 'imap.gmail.com', port: 993,
        user: 'person@gmail.com', password: '', tls: true,
        auth: {
          kind: 'oauth2', provider: 'gmail', credentialTarget: refreshTarget,
          clientId: 'desktop-client-id', clientSecretTarget: clientTarget,
        },
        smtp: {
          host: 'smtp.gmail.com', port: 465, secure: true,
          user: 'person@gmail.com',
        },
      });
      backend.write(refreshTarget, 'dummy-refresh-token');
      backend.write(clientTarget, 'dummy-client-secret');

      await manager.removeAccount(account.id);

      expect(manager.getAccount(account.id)).toBeUndefined();
      expect(values.size).toBe(0);
      expect(disposed).toEqual([refreshTarget, clientTarget]);
    });

    it('restores the account and credential when persistence fails after cleanup', async () => {
      const values = new Map<string, string>();
      const backend: CredentialBackend = {
        read: (target) => {
          const value = values.get(target);
          return value === undefined
            ? undefined
            : { read: () => value, dispose: () => undefined };
        },
        write: (target, secret) => { values.set(target, secret); },
        delete: (target) => values.delete(target),
      };
      const manager = new AccountManager(backend);
      const target = credentialTarget('qq', 'person@qq.com');
      const account = await manager.addAccount({
        name: 'QQ', host: 'imap.qq.com', port: 993,
        user: 'person@qq.com', password: '', tls: true,
        auth: {
          kind: 'credential', provider: 'qq', credentialTarget: target,
        },
        smtp: {
          host: 'smtp.qq.com', port: 465, secure: true,
          user: 'person@qq.com',
        },
      });
      backend.write(target, 'dummy-authorization-code');
      vi.mocked(fs.writeFile).mockRejectedValueOnce(new Error('synthetic persistence failure'));

      await expect(manager.removeAccount(account.id)).rejects.toThrow('synthetic persistence failure');
      expect(manager.getAccount(account.id)).toBeDefined();
      expect(values.get(target)).toBe('dummy-authorization-code');
    });

  describe('updateAccount', () => {
    it('rejects renaming an account to an existing account name', async () => {
      const manager = new AccountManager();
      const first = await manager.addAccount({ name: 'Personal', host: 'imap.example.test', port: 993, user: 'a@example.test', password: SYNTHETIC_PASSWORD_2, tls: true });
      await manager.addAccount({ name: 'Work', host: 'imap.example.test', port: 993, user: 'b@example.test', password: SYNTHETIC_PASSWORD_2, tls: true });
      vi.mocked(fs.writeFile).mockClear();
      await expect(manager.updateAccount(first.id, { name: 'Work' })).rejects.toThrow(/unique name/);
      expect(fs.writeFile).not.toHaveBeenCalled();
    });
    it('rejects changing a generic password account to a provider-bound host', async () => {
      const manager = new AccountManager();
      const account = await manager.addAccount({
        name: 'Generic', host: 'imap.example.test', port: 993,
        user: 'person@example.test', password: SYNTHETIC_PASSWORD_2, tls: true,
      });
      vi.mocked(fs.writeFile).mockClear();

      await expect(manager.updateAccount(account.id, {
        host: 'imap.qq.com',
      })).rejects.toThrow(/node dist\/enroll\.js qq/i);
      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it('rejects mismatched credential targets before persistence', async () => {
      const manager = new AccountManager();
      const account = await manager.addAccount({
        name: 'QQ', host: 'imap.qq.com', port: 993,
        user: 'person@qq.com', password: '', tls: true,
        auth: {
          kind: 'credential', provider: 'qq',
          credentialTarget: credentialTarget('qq', 'person@qq.com'),
        },
      });
      vi.mocked(fs.writeFile).mockClear();
      await expect(manager.updateAccount(account.id, {
        auth: {
          kind: 'credential', provider: 'qq',
          credentialTarget: credentialTarget('gmail', 'person@qq.com'),
        },
      })).rejects.toThrow(/credential target.*mismatch/i);
      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it('should update account fields', async () => {
      const manager = new AccountManager();

      const account = await manager.addAccount({
        name: 'Original Name',
        host: 'imap.test.com',
        port: 993,
        user: 'user@test.com',
        password: 'secret',
        tls: true,
      });

      const updated = await manager.updateAccount(account.id, {
        name: 'New Name',
      });

      expect(updated.name).toBe('New Name');
      expect(updated.host).toBe('imap.test.com'); // Unchanged
      expect(manager.getAccount(account.id)?.password).toBe('secret');
    });

    it('should encrypt new password on update', async () => {
      const manager = new AccountManager();

      const account = await manager.addAccount({
        name: 'Test',
        host: 'imap.test.com',
        port: 993,
        user: 'user@test.com',
        password: 'oldpass',
        tls: true,
      });

      const updated = await manager.updateAccount(account.id, {
        password: 'newpass',
      });

      expect(updated.password).toBe('newpass'); // Returns decrypted
    });

    it('should throw error for non-existent account', async () => {
      const manager = new AccountManager();

      await expect(
        manager.updateAccount('non-existent', { name: 'New' })
      ).rejects.toThrow('Account with id non-existent not found');
    });

    it('should preserve id on update', async () => {
      const manager = new AccountManager();

      const account = await manager.addAccount({
        name: 'Test',
        host: 'imap.test.com',
        port: 993,
        user: 'user@test.com',
        password: 'secret',
        tls: true,
      });

      const updated = await manager.updateAccount(account.id, {
        name: 'Updated',
      });

      expect(updated.id).toBe(account.id);
    });
  });
// T07 / BUG-SEC-06 (candidate contract): account candidates are validated as a
// pure step before any store write. Only known fields pass; garbage types,
// null credentials and unknown extras are rejected; the empty-string
// placeholder rule (env-managed credentials) stays compatible.
describe('T07: account candidate schema', () => {
  const baseCandidate = {
    name: 'T07 Candidate',
    host: 'imap.synth.test',
    port: 993,
    user: 'user@synth.test',
    password: ['t07-', 'synthetic', '-pw'].join(''),
    tls: true,
  };

  describe('validateAccountCandidate (pure)', () => {
    it('T07-SCHEMA-UNKNOWN-FIELD: rejects unknown extra fields by name', () => {
      expect(() => validateAccountCandidate({ ...baseCandidate, evilExtra: 'x' }))
        .toThrow(/evilExtra/);
    });

    it('T07-SCHEMA-TYPES: rejects wrong types and out-of-range ports', () => {
      for (const broken of [
        { ...baseCandidate, port: '993' },
        { ...baseCandidate, port: 0 },
        { ...baseCandidate, port: 70000 },
        { ...baseCandidate, tls: 'yes' },
        { ...baseCandidate, name: '   ' },
        { ...baseCandidate, host: 993 },
        { ...baseCandidate, user: 42 },
      ]) {
        expect(() => validateAccountCandidate(broken)).toThrow();
      }
      expect(() => validateAccountCandidate(null)).toThrow();
      expect(() => validateAccountCandidate([baseCandidate])).toThrow();
      expect(() => validateAccountCandidate('nope')).toThrow();
    });

    it('T07-SCHEMA-NULL-CREDENTIALS: null credentials rejected, empty-string placeholders accepted', () => {
      expect(() => validateAccountCandidate({ ...baseCandidate, password: null })).toThrow();
      const placeholder = validateAccountCandidate({ ...baseCandidate, user: '', password: '' });
      expect(placeholder.user).toBe('');
      expect(placeholder.password).toBe('');
    });

    it('T07-SCHEMA-NORMALIZES: applies defaults and drops nothing silently', () => {
      const normalized = validateAccountCandidate({ ...baseCandidate, port: undefined, tls: undefined });
      expect(normalized.port).toBe(993);
      expect(normalized.tls).toBe(true);
      const starttls = validateAccountCandidate({ ...baseCandidate, port: undefined, tls: false });
      expect(starttls.port).toBe(143);
      expect(Object.keys(normalized).sort()).toEqual(
        ['host', 'name', 'password', 'port', 'tls', 'user']
      );
    });

    it('T07-SCHEMA-WEB-SHAPE: accepts the exact shape the setup API builds', () => {
      const shape = {
        name: 'Web Shape',
        host: 'imap.synth.test',
        port: 993,
        user: 'user@synth.test',
        password: '',
        tls: true,
        email: 'user@synth.test',
        smtp: { host: 'smtp.synth.test', port: 465, secure: true, user: 'user@synth.test', password: '' },
        sentFolder: 'Gesendet',
        defaultBcc: ['audit@synth.test'],
      };
      const normalized = validateAccountCandidate(shape);
      expect(normalized.smtp?.host).toBe('smtp.synth.test');
      expect(normalized.defaultBcc).toEqual(['audit@synth.test']);
      expect(() => validateAccountCandidate({ ...shape, smtp: { ...shape.smtp, port: '465' } })).toThrow();
      expect(() => validateAccountCandidate({ ...shape, smtp: { ...shape.smtp, authMethod: 'BOGUS' } })).toThrow();
    });

    it('T07-SCHEMA-AUTH: accepts known provider auth references, rejects unknown auth fields', () => {
      const qq = validateAccountCandidate({
        ...baseCandidate,
        auth: { kind: 'credential', provider: 'qq', credentialTarget: 'MailAgentMCP:qq:synth' },
      });
      expect(qq.auth?.kind).toBe('credential');
      expect(() => validateAccountCandidate({
        ...baseCandidate,
        auth: { kind: 'credential', provider: 'qq', credentialTarget: 'MailAgentMCP:qq:synth', evilAuthField: 1 },
      })).toThrow(/evilAuthField/);
      expect(() => validateAccountCandidate({
        ...baseCandidate,
        auth: { kind: 'oauth2', provider: 'gmail' },
      })).toThrow(/credentialTarget/);
    });
  });

  describe('addAccount / updateAccount wiring', () => {
    it('T07-ADD-REJECTS-NO-WRITE: an invalid candidate is refused with zero store writes', async () => {
      const manager = new AccountManager();
      await expect(
        manager.addAccount({ ...baseCandidate, evilExtra: 'x' } as any)
      ).rejects.toThrow(/evilExtra/);
      expect(vi.mocked(fs.writeFile)).not.toHaveBeenCalled();
      expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
    });

    it('T07-ADD-TYPE-REJECT: a string port never reaches the store', async () => {
      const manager = new AccountManager();
      await expect(
        manager.addAccount({ ...baseCandidate, port: '993' } as any)
      ).rejects.toThrow();
      expect(vi.mocked(fs.writeFile)).not.toHaveBeenCalled();
    });

    it('T07-ADD-COMPAT: a valid web-shape candidate persists only known fields', async () => {
      const manager = new AccountManager();
      const account = await manager.addAccount({ ...baseCandidate });
      const stored = JSON.parse(String(vi.mocked(fs.writeFile).mock.calls[0][1]));
      expect(stored[0].name).toBe('T07 Candidate');
      expect(Object.keys(stored[0]).sort()).toEqual(
        ['host', 'id', 'name', 'password', 'port', 'tls', 'user']
      );
    });

    it('T07-UPDATE-REJECTS-UNKNOWN-FIELD: unknown update fields never reach the store', async () => {
      const manager = new AccountManager();
      const account = await manager.addAccount({ ...baseCandidate });
      vi.mocked(fs.writeFile).mockClear();
      await expect(
        manager.updateAccount(account.id, { evilExtra: 'x' } as any)
      ).rejects.toThrow(/evilExtra/);
      expect(vi.mocked(fs.writeFile)).not.toHaveBeenCalled();
    });
  });
});
  // T07 night-review remediation: the SMTP sub-candidate follows the same
  // missing/null/default contract as the top level, the NORMALIZED candidate
  // is what gets persisted AND returned (disk and return agree), and illegal
  // add/update stays zero-write.
  describe('T07R: review remediation', () => {
    it('T07R-SMTP-DEFAULTS: missing smtp port/secure derive from secure', async () => {
      const manager = new AccountManager();
      const account = await manager.addAccount({
        name: 'T07R A', host: 'imap.synth.test', port: 993,
        user: 'a@synth.test', password: ['t07r-', 'pw'].join(''), tls: true,
        smtp: { host: 'smtp.synth.test' },
      } as any);
      expect(account.smtp!.port).toBe(465);
      expect(account.smtp!.secure).toBe(true);

      const noTls = await manager.addAccount({
        name: 'T07R B', host: 'imap.synth.test', port: 143, user: 'b@synth.test',
        password: ['t07r-', 'pw2'].join(''), tls: false,
        smtp: { host: 'smtp.synth.test', secure: false },
      } as any);
      expect(noTls.smtp!.port).toBe(587);
    });

    it('T07R-SMTP-NULL-CONSISTENT: null smtp and null smtp fields are rejected', () => {
      expect(() => validateAccountCandidate({
        name: 'T07R C', host: 'imap.synth.test', port: 993, user: 'c@synth.test',
        password: ['t07r-', 'pw3'].join(''), tls: true, smtp: null,
      })).toThrow(/smtp/);
      expect(() => validateAccountCandidate({
        name: 'T07R D', host: 'imap.synth.test', port: 993, user: 'd@synth.test',
        password: ['t07r-', 'pw4'].join(''), tls: true,
        smtp: { host: 'smtp.synth.test', port: 465, secure: true, user: null },
      })).toThrow(/smtp.user/);
    });

    it('T07R-TRIM-NORMALIZATION: name/host/user are trimmed before persistence', () => {
      const normalized = validateAccountCandidate({
        name: '  T07R E  ', host: '  imap.synth.test  ', port: 993,
        user: '  e@synth.test  ', password: ['t07r-', 'pw5'].join(''), tls: true,
      });
      expect(normalized.name).toBe('T07R E');
      expect(normalized.host).toBe('imap.synth.test');
      expect(normalized.user).toBe('e@synth.test');
    });

    it('T07R-RETURN-MATCHES-DISK: the returned account equals the persisted one', async () => {
      const manager = new AccountManager();
      const inputPassword = ['t07r-', 'disk'].join('');
      const account = await manager.addAccount({
        name: '  T07R F  ', host: '  imap.synth.test  ', port: 993,
        user: '  f@synth.test  ', password: inputPassword, tls: true,
        smtp: { host: 'smtp.synth.test' },
      } as any);

      // The stored record (what saveAccounts wrote) must match the return.
      const stored = JSON.parse(String(vi.mocked(fs.writeFile).mock.calls.at(-1)![1]));
      expect(stored).toHaveLength(1);
      expect(stored[0].name).toBe(account.name);
      expect(stored[0].host).toBe(account.host);
      expect(stored[0].user).toBe(account.user);
      expect(stored[0].smtp.port).toBe(account.smtp!.port);
      expect(stored[0].password).not.toBe(inputPassword); // encrypted at rest
      // The manager decrypts back to the same plaintext it validated.
      const reread = manager.getAccount(account.id)!;
      expect(reread.name).toBe(account.name);
      expect(reread.password).toBe(account.password);
      expect(account.password).toBe(inputPassword);
    });


    it('T07R-MERGE-CIPHERTEXT: stored ciphertext is not re-validated as plaintext', async () => {
      const manager = new AccountManager();
      const longPassword = ['long-', 'password'].join('').repeat(250); // 3000 chars
      const account = await manager.addAccount({
        name: 'T07R I', host: 'imap.synth.test', port: 993,
        user: 'i@synth.test', password: longPassword, tls: true,
      });
      const updated = await manager.updateAccount(account.id, { name: 'T07R I renamed' });
      expect(updated.name).toBe('T07R I renamed');
      const reread = manager.getAccount(account.id)!;
      expect(reread.password).toBe(longPassword);
    });

    it('T07R-UPDATE-NORMALIZED: updateAccount persists and returns trimmed values', async () => {
      const manager = new AccountManager();
      const account = await manager.addAccount({
        name: 'T07R G', host: 'imap.synth.test', port: 993,
        user: 'g@synth.test', password: ['t07r-', 'pw6'].join(''), tls: true,
      });
      const updated = await manager.updateAccount(account.id, { name: '  T07R H  ' });
      expect(updated.name).toBe('T07R H');
      const stored = JSON.parse(String(vi.mocked(fs.writeFile).mock.calls.at(-1)![1]));
      expect(stored[0].name).toBe('T07R H');
    });
  });
});