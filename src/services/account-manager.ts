import { promises as fs } from 'fs';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { ImapAccount } from '../types/index.js';
import { ENV_CREDENTIAL_SUFFIXES, envVarName } from '../utils/env-credentials.js';
import { accountForPersistence, assertCredentialTarget } from '../credentials/account-auth.js';
import type { CredentialBackend } from '../credentials/credential-backend.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {withAccountStoreLock} from '../utils/account-store-lock.js';
import {validateAccountCandidate, type AccountCandidate} from '../utils/account-candidate.js';


type ProviderAccountCandidate = Pick<ImapAccount, 'host' | 'smtp' | 'auth'>;

function providerForHost(host: string | undefined): 'gmail' | 'qq' | undefined {
  const normalized = host?.trim().toLowerCase().replace(/\.$/, '');
  if (normalized === 'imap.gmail.com' || normalized === 'smtp.gmail.com') return 'gmail';
  if (normalized === 'imap.qq.com' || normalized === 'smtp.qq.com') return 'qq';
  return undefined;
}

/**
 * Gmail and QQ Mail use provider-bound enrollment and must never silently
 * enter the legacy password store. Other IMAP/SMTP hosts keep the inherited
 * generic-password compatibility path.
 */
export function assertProviderAccountAuth(
  account: ProviderAccountCandidate,
  hasPasswordUpdate = false,
): void {
  const provider = providerForHost(account.host) ?? providerForHost(account.smtp?.host);
  if (!provider) return;
  const validAuth = provider === 'gmail'
    ? account.auth?.provider === 'gmail' && account.auth.kind === 'oauth2'
    : account.auth?.provider === 'qq' && account.auth.kind === 'credential';
  if (validAuth && !hasPasswordUpdate) return;
  throw new Error(
    provider === 'gmail'
      ? 'Gmail password fallback is disabled. Run node dist/enroll.js gmail in a trusted local terminal.'
      : 'QQ Mail password fallback is disabled. Run node dist/enroll.js qq in a trusted local terminal.',
  );
}

export class AccountManager {
  private configPath: string;
  private configDir: string;
  private accounts: Map<string, ImapAccount> = new Map();
  private encryptionKey: string;
  private capturedEnvOverrides: Map<string, string> = new Map();
  private readonly transactionContext=new AsyncLocalStorage<boolean>();
  private writeInProgress=false;

  async withStoreTransaction<T>(action:()=>Promise<T>):Promise<T>{
    if(this.transactionContext.getStore()) return action();
    return withAccountStoreLock(this.configDir,async()=>{
      this.loadAccountsSync(true);
      const snapshot=new Map(this.accounts);this.writeInProgress=true;
      try{return await this.transactionContext.run(true,action);}
      catch(error){this.accounts=snapshot;throw error;}
      finally{this.writeInProgress=false;}
    });
  }

  private static readonly ENV_OVERRIDE_PATTERN =
    /^IMAP_MCP_ACCOUNT_.+_(?:IMAP|SMTP)_(?:USERNAME|PASSWORD)$/;

  constructor(private readonly credentialBackend?: CredentialBackend) {
    const configuredDir = process.env.IMAP_MCP_CONFIG_DIR?.trim();
    this.configDir = configuredDir
      ? path.resolve(configuredDir)
      : path.join(os.homedir(), '.imap-mcp');
    this.configPath = path.join(this.configDir, 'accounts.json');
    this.encryptionKey = this.getOrCreateEncryptionKey();
    this.captureEnvOverrides();
    try {
      this.loadAccountsSync();
    } catch (error) {
      // T09 / SA-07: startup stays usable — the browser setup is the recovery
      // path — but every account read re-raises the failure until the store
      // is fixed, and no stale accounts leak into memory.
      console.error('Account store could not be loaded:', error instanceof Error ? error.message : error);
    }
  }

  async addAccount(account: Omit<ImapAccount, 'id'>): Promise<ImapAccount> {
    return this.withStoreTransaction(()=>this.addAccountUnlocked(account));
  }
  private async addAccountUnlocked(account: Omit<ImapAccount,'id'>):Promise<ImapAccount>{
    // Pure candidate validation (T07 / BUG-SEC-06): schema, types, credential
    // placeholder rules and unknown-field rejection happen before any store
    // access, so an invalid candidate can never reach accounts.json. The
    // normalized candidate — never the raw input — is persisted.
    const candidate = validateAccountCandidate(account);
    assertProviderAccountAuth(candidate);
    for (const existing of this.accounts.values()) {
      if (existing.name === candidate.name) throw new Error('Account name already exists; choose a unique name');
      if (candidate.auth && existing.auth?.provider === candidate.auth.provider && existing.user === candidate.user) {
        throw new Error('Credential-backed account already exists; repair it instead of enrolling twice');
      }
    }
    const id = crypto.randomUUID();
    const persistenceInput = accountForPersistence({ ...candidate, id });
    const newAccount: ImapAccount = {
      ...persistenceInput,
      id,
      password: this.encrypt(persistenceInput.password),
    };

    // Encrypt SMTP password if provided
    if (persistenceInput.smtp?.password) {
      newAccount.smtp = {
        ...persistenceInput.smtp,
        password: this.encrypt(persistenceInput.smtp.password),
      };
    }

    this.accounts.set(id, newAccount);
    await this.saveAccounts();

    // T07 review: the caller gets the persisted record with secrets decrypted
    // back — the same normalized values that just hit the disk, never the raw
    // un-normalized input.
    const returned: ImapAccount = { ...newAccount, password: this.decrypt(newAccount.password) };
    if (newAccount.smtp?.password !== undefined) {
      returned.smtp = { ...newAccount.smtp, password: this.decrypt(newAccount.smtp.password) };
    }
    return returned;
  }


  async removeAccount(id: string): Promise<void> {
    return this.withStoreTransaction(()=>this.removeAccountUnlocked(id));
  }
  private async removeAccountUnlocked(id:string):Promise<void>{
    const account = this.accounts.get(id);
    if (!account) {
      throw new Error(`Account ${id} not found`);
    }

    const targets = account.auth
      ? [
        account.auth.credentialTarget,
        ...(account.auth.kind === 'oauth2' && account.auth.clientSecretTarget
          ? [account.auth.clientSecretTarget]
          : []),
      ]
      : [];
    if (targets.length > 0) {
      assertCredentialTarget(account);
      if (!this.credentialBackend) {
        throw new Error('Credential backend is required to remove this account safely');
      }
    }

    const snapshots = targets.map((target) => {
      const handle = this.credentialBackend!.read(target);
      if (!handle) return { target, value: undefined };
      try {
        const value = handle.read();
        if (typeof value !== 'string' || value.length === 0) {
          throw new Error('Stored credential is invalid');
        }
        return { target, value };
      } finally {
        handle.dispose();
      }
    });
    const deleted: Array<{ target: string; value: string }> = [];
    try {
      for (const snapshot of snapshots) {
        if (snapshot.value === undefined) continue;
        if (!this.credentialBackend!.delete(snapshot.target)) {
          throw new Error('Credential cleanup failed');
        }
        deleted.push({ target: snapshot.target, value: snapshot.value });
      }
    } catch (error) {
      try {
        for (const snapshot of [...deleted].reverse()) {
          this.credentialBackend!.write(snapshot.target, snapshot.value);
        }
      } catch {
        throw new Error('Account removal failed and credential rollback failed', { cause: error });
      }
      throw error;
    }

    this.accounts.delete(id);
    try {
      await this.saveAccounts();
    } catch (error) {
      this.accounts.set(id, account);
      try {
        for (const snapshot of [...deleted].reverse()) {
          this.credentialBackend!.write(snapshot.target, snapshot.value);
        }
      } catch {
        throw new Error('Account removal failed and credential rollback failed', { cause: error });
      }
      throw error;
    }
  }

  async updateAccount(id: string, updates: Partial<Omit<ImapAccount, 'id'>>): Promise<ImapAccount> {
    return this.withStoreTransaction(()=>this.updateAccountUnlocked(id,updates));
  }
  private async updateAccountUnlocked(id:string,updates:Partial<Omit<ImapAccount,'id'>>):Promise<ImapAccount>{
    const existingAccount = this.accounts.get(id);
    if (!existingAccount) {
      throw new Error(`Account with id ${id} not found`);
    }

    // The merged result is a candidate too: schema and unknown-field rules
    // apply before anything is written (T07). Stored ciphertext is NOT
    // re-validated as plaintext (a long stored password would exceed the
    // plaintext budget in encrypted form) — it is restored after validation
    // and flows through unchanged unless an update provides a new value.
    const mergedInput: Record<string, unknown> = {
      ...existingAccount,
      ...updates,
      smtp: updates.smtp ?? existingAccount.smtp,
      password: updates.password !== undefined ? updates.password : '',
    };
    if (mergedInput.smtp !== undefined && updates.smtp?.password === undefined) {
      mergedInput.smtp = { ...(mergedInput.smtp as Record<string, unknown>), password: '' };
    }
    const candidate = validateAccountCandidate(mergedInput);
    if (updates.password === undefined) candidate.password = existingAccount.password;
    if (candidate.smtp && updates.smtp?.password === undefined && existingAccount.smtp?.password !== undefined) {
      candidate.smtp.password = existingAccount.smtp.password;
    }
    for (const [otherId, other] of this.accounts) {
      if (otherId !== id && other.name === candidate.name) {
        throw new Error('Account name already exists; choose a unique name');
      }
    }
    assertProviderAccountAuth(
      candidate,
      updates.password !== undefined || updates.smtp?.password !== undefined,
    );

    // Encrypt password if it's being updated. Use an explicit undefined check so
    // an empty placeholder ("" — used for env-managed credentials) is encrypted
    // to a decryptable value rather than stored raw. Built from the VALIDATED
    // candidate (T07 review) so normalization reaches the disk, not just the
    // validation pass.
    const processedUpdates = accountForPersistence({ ...candidate, id });
    if (existingAccount.auth || updates.password !== undefined) {
      processedUpdates.password = this.encrypt(processedUpdates.password);
    }

    // Encrypt SMTP password if it's being updated
    if (updates.smtp?.password && processedUpdates.smtp?.password) {
      processedUpdates.smtp = {
        ...processedUpdates.smtp,
        password: this.encrypt(processedUpdates.smtp.password),
      };
    }

    // Merge updates with existing account
    const updatedAccount: ImapAccount = {
      ...existingAccount,
      ...processedUpdates,
      id, // Ensure ID doesn't change
    };

    // T10 / SA-06: construct the decrypted RESPONSE before committing — if
    // return-object construction fails (e.g. a decrypt error), the update is
    // not committed at all, keeping response, memory and disk in the same
    // pre-update state.
    const decrypted: ImapAccount = {
      ...updatedAccount,
      password: this.decrypt(updatedAccount.password),
    };

    if (updatedAccount.smtp?.password) {
      decrypted.smtp = {
        ...updatedAccount.smtp,
        password: this.decrypt(updatedAccount.smtp.password),
      };
    }

    this.accounts.set(id, updatedAccount);
    await this.saveAccounts();

    return decrypted;
  }

  getAccount(id: string): ImapAccount | undefined {
    this.loadAccountsSync();
    const account = this.accounts.get(id);
    if (!account) return undefined;

    const decrypted: ImapAccount = {
      ...account,
      password: this.decryptField(account.password),
    };

    if (account.smtp?.password) {
      decrypted.smtp = {
        ...account.smtp,
        password: this.decryptField(account.smtp.password),
      };
    }

    return this.applyEnvOverrides(decrypted);
  }

  /**
   * Override IMAP/SMTP credentials from environment variables, keyed by the
   * account's normalized name. This lets credentials be supplied at runtime
   * (e.g. from a secret manager) instead of the encrypted `accounts.json`.
   *
   *   IMAP_MCP_ACCOUNT_<NAME>_IMAP_USERNAME  -> user
   *   IMAP_MCP_ACCOUNT_<NAME>_IMAP_PASSWORD  -> password
   *   IMAP_MCP_ACCOUNT_<NAME>_SMTP_USERNAME  -> smtp.user  (only if smtp exists)
   *   IMAP_MCP_ACCOUNT_<NAME>_SMTP_PASSWORD  -> smtp.password (only if smtp exists)
   *
   * <NAME> is the account name uppercased with every non-alphanumeric character
   * replaced by "_". Overrides are applied in-memory only; nothing is written
   * back to disk. A variable takes effect only when it was present at startup.
   *
   * The values themselves are captured once in the constructor (see
   * `captureEnvOverrides`) and served here from the encrypted cache.
   */
  private applyEnvOverrides(account: ImapAccount): ImapAccount {
    const varName = (suffix: string) => envVarName(account.name, suffix);

    const result: ImapAccount = { ...account };

    const imapUser = this.getEnvOverride(varName(ENV_CREDENTIAL_SUFFIXES.imapUser));
    if (imapUser !== undefined) {
      result.user = imapUser;
    }

    const imapPassword = this.getEnvOverride(varName(ENV_CREDENTIAL_SUFFIXES.imapPassword));
    if (imapPassword !== undefined) {
      result.password = imapPassword;
    }

    if (result.smtp) {
      const smtpUser = this.getEnvOverride(varName(ENV_CREDENTIAL_SUFFIXES.smtpUser));
      const smtpPassword = this.getEnvOverride(varName(ENV_CREDENTIAL_SUFFIXES.smtpPassword));

      if (smtpUser !== undefined || smtpPassword !== undefined) {
        result.smtp = { ...result.smtp };
        if (smtpUser !== undefined) {
          result.smtp.user = smtpUser;
        }
        if (smtpPassword !== undefined) {
          result.smtp.password = smtpPassword;
        }
      }
    }

    return result;
  }

  /**
   * Capture every `IMAP_MCP_ACCOUNT_*_(IMAP|SMTP)_(USERNAME|PASSWORD)` variable
   * into an encrypted in-memory cache and delete it from `process.env`. Run once
   * in the constructor so the plaintext secrets do not linger in the process
   * environment (where they could leak to child processes or diagnostics) any
   * longer than necessary. `Object.entries` snapshots the keys, so deleting
   * during iteration is safe.
   */
  private captureEnvOverrides(): void {
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined && AccountManager.ENV_OVERRIDE_PATTERN.test(name)) {
        this.capturedEnvOverrides.set(this.hashCacheKey(name), this.encrypt(value));
        delete process.env[name];
      }
    }
  }

  /**
   * Return a captured override value by variable name, decrypting it from the
   * cache. Returns `undefined` when no such variable was present at startup.
   */
  private getEnvOverride(name: string): string | undefined {
    const encrypted = this.capturedEnvOverrides.get(this.hashCacheKey(name));
    if (encrypted === undefined) {
      return undefined;
    }
    return this.decrypt(encrypted);
  }

  /**
   * Derive a deterministic, non-reversible cache key from a variable name via
   * HMAC-SHA256 keyed by the encryption key. Keeps the account name (embedded in
   * the variable name) out of the in-memory cache in plaintext while still
   * allowing lookups.
   */
  private hashCacheKey(name: string): string {
    return crypto
      .createHmac('sha256', Buffer.from(this.encryptionKey, 'hex'))
      .update(name)
      .digest('hex');
  }

  getAllAccounts(): ImapAccount[] {
    this.loadAccountsSync();
    return Array.from(this.accounts.values()).map(account => {
      const decrypted: ImapAccount = {
        ...account,
        password: this.decryptField(account.password),
      };

      if (account.smtp?.password) {
        decrypted.smtp = {
          ...account.smtp,
          password: this.decryptField(account.smtp.password),
        };
      }

      return this.applyEnvOverrides(decrypted);
    });
  }

  /**
   * Resolve which account a tool call refers to, in a backward-compatible way:
   *   1. explicit `accountId`        → must exist
   *   2. explicit `accountName`      → matched by name
   *   3. neither, and exactly ONE account configured → that account (default)
   * Throws a helpful, actionable error otherwise. Returns the account id.
   */
  resolveAccountId(accountId?: string, accountName?: string): string {
    this.loadAccountsSync();

    if (accountId) {
      if (!this.accounts.has(accountId)) {
        throw new Error(`Account ${accountId} not found. Use imap_list_accounts to see available accounts.`);
      }
      return accountId;
    }

    if (accountName) {
      const match = Array.from(this.accounts.values()).find(acc => acc.name === accountName);
      if (!match) {
        throw new Error(`No account named "${accountName}". Use imap_list_accounts to see available accounts.`);
      }
      return match.id;
    }

    const all = Array.from(this.accounts.values());
    if (all.length === 1) {
      return all[0].id;
    }
    if (all.length === 0) {
      throw new Error('No accounts configured. Open the local browser setup with node dist/setup.js --skip-claude to add one. Never enter credentials in chat.');
    }
    throw new Error(
      `Multiple accounts are configured (${all.length}). Specify accountId or accountName. Use imap_list_accounts to see them.`
    );
  }

  getAccountByName(name: string): ImapAccount | undefined {
    this.loadAccountsSync();
    const account = Array.from(this.accounts.values()).find(acc => acc.name === name);
    if (!account) return undefined;

    const decrypted: ImapAccount = {
      ...account,
      password: this.decryptField(account.password),
    };

    if (account.smtp?.password) {
      decrypted.smtp = {
        ...account.smtp,
        password: this.decryptField(account.smtp.password),
      };
    }

    return this.applyEnvOverrides(decrypted);
  }

  private loadAccountsSync(strict=false): void {
    if(this.writeInProgress&&!strict) return;
    try {
      const data = readFileSync(this.configPath, 'utf-8');
      const accounts = JSON.parse(data);
      if (!Array.isArray(accounts)) {
        throw new Error('Account store is not a JSON array');
      }
      const loaded = new Map<string, ImapAccount>();
      for (const account of accounts) {
        if (typeof account !== 'object' || account === null || typeof (account as ImapAccount).id !== 'string') {
          throw new Error('Account store contains a malformed entry');
        }
        loaded.set((account as ImapAccount).id, account as ImapAccount);
      }
      this.accounts = loaded;
    } catch (error) {
      // T09 / SA-07: a failed load must not leave stale in-memory accounts.
      // ENOENT means an empty store; anything else (corrupt JSON, non-array,
      // malformed entries, refused reads) clears the visible accounts — and a
      // strict load (taken before any write) still refuses to overwrite the
      // broken file, so the original bytes survive until the user fixes them.
      this.accounts = new Map();
      if(strict&&(error as NodeJS.ErrnoException).code!=='ENOENT') throw new Error('Account store is unreadable or invalid; refusing to overwrite it');
      if (strict) return;
      if ((error as any).code !== 'ENOENT') {
        throw new Error('Account store is unreadable or invalid; fix or remove it before using accounts', { cause: error });
      }
    }
  }

  private async saveAccounts(): Promise<void> {
    const accounts = Array.from(this.accounts.values());
    const dir = path.dirname(this.configPath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

    const temporary=this.configPath+'.'+crypto.randomUUID()+'.tmp';
    try{
      await fs.writeFile(temporary,JSON.stringify(accounts,null,2),{mode:0o600,flag:'wx'});
      await fs.rename(temporary,this.configPath);
    }finally{await fs.unlink(temporary).catch(()=>undefined);}

    await this.enforceStorePermissions();
  }

  /**
   * Defence in depth for the credential store. `~/.imap-mcp/` holds the raw
   * AES-256 key and the (encrypted) accounts, so anyone able to read the key
   * plus the store can recover every password. The `mode` options above only
   * apply when a file is *created*; a store written before this hardening — or
   * under a permissive umask — could still be world-readable. Re-assert
   * owner-only permissions on the directory, the accounts file, and the key.
   * Best effort: silently ignored on platforms without POSIX modes (Windows)
   * or when a path does not exist yet.
   */
  private async enforceStorePermissions(): Promise<void> {
    if (process.platform === 'win32') return;

    const dir = path.dirname(this.configPath);
    const keyPath = path.join(dir, '.key');
    const targets: Array<[string, number]> = [
      [dir, 0o700],
      [this.configPath, 0o600],
      [keyPath, 0o600],
    ];

    for (const [target, mode] of targets) {
      try {
        await fs.chmod(target, mode);
      } catch {
        // best effort — path may not exist yet, or fs is stubbed in tests
      }
    }
  }

  private getOrCreateEncryptionKey(): string {
    const keyPath = path.join(this.configDir, '.key');
    
    try {
      return readFileSync(keyPath, 'utf-8');
    } catch (error) {
      if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;
      const key = crypto.randomBytes(32).toString('hex');
      // Owner-only from the moment of creation: the key alone can decrypt every
      // stored credential (see enforceStorePermissions).
      mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
      try{writeFileSync(keyPath,key,{mode:0o600,flag:'wx'});}
      catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;return readFileSync(keyPath,'utf8');}
      return key;
    }
  }

  private encrypt(text: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(
      'aes-256-cbc',
      Buffer.from(this.encryptionKey, 'hex'),
      iv
    );

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    return iv.toString('hex') + ':' + encrypted;
  }

  /**
   * Decrypt a stored credential field.
   *
   * A missing or empty value (null, undefined, or "") is treated as "no
   * credential" and returns an empty string — the env-override mechanism can
   * still fill it at runtime. A non-empty value that is not a well-formed
   * encrypted string (missing the "iv:ciphertext" separator, or otherwise
   * undecryptable) is a corrupt entry and throws, rather than being silently
   * swallowed.
   */
  private decryptField(value: string | null | undefined): string {
    if (value === undefined || value === null || value === '') {
      return '';
    }
    if (typeof value !== 'string' || !value.includes(':')) {
      throw new Error('Cannot decrypt credential field: value is not a valid encrypted string');
    }
    return this.decrypt(value);
  }

  private decrypt(text: string): string {
    const [ivHex, encrypted] = text.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv(
      'aes-256-cbc',
      Buffer.from(this.encryptionKey, 'hex'),
      iv
    );

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }
}
