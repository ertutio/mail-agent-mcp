import { describe, it, expect, vi } from 'vitest';
import { runEnrollmentCli, type EnrollmentCliDependencies } from '../src/enroll.js';
import type { CredentialBackend } from '../src/credentials/credential-backend.js';
import { credentialTarget } from '../src/credentials/credential-backend.js';
import type { ImapAccount } from '../src/types/index.js';

// T17: the repair flow re-verifies the account inside the transaction —
// an account deleted or whose target changed between selection and
// rotation prevents the repair from proceeding.
describe('T17R: repair transaction re-verification', () => {
  const qqAccount = (): ImapAccount => ({
    id: 'qq-account', name: 'QQ Mail', host: 'imap.qq.com', port: 993,
    user: 'owner@qq.com', password: '', tls: true,
    auth: { kind: 'credential', provider: 'qq', credentialTarget: credentialTarget('qq', 'owner@qq.com') },
  });

  it('T17R-QQ-ACCOUNT-REMOVED: a removed account prevents the rotation', async () => {
    const output: string[] = [];
    const credentials = {} as CredentialBackend;
    const prompt = vi.fn(async () => 'new-auth-code');
    const rotate = vi.fn(async () => undefined);
    let callCount = 0;
    const deps: EnrollmentCliDependencies = {
      platform: 'win32',
      getAccounts: () => {
        callCount++;
        if (callCount <= 1) return [qqAccount()];
        return [];
      },
      credentials, prompt,
      rotateCredential: rotate,
      authenticateOnly: vi.fn(async () => undefined),
      writeOutput: (text) => { output.push(text); },
    };

    await expect(runEnrollmentCli(['qq-repair'], deps)).rejects.toThrow(
      /removed or its credential target changed/,
    );
    expect(rotate).not.toHaveBeenCalled();
  });

  it('T17R-QQ-TARGET-CHANGED: a changed credential target prevents the rotation', async () => {
    const output: string[] = [];
    const credentials = {} as CredentialBackend;
    const prompt = vi.fn(async () => 'new-auth-code');
    const rotate = vi.fn(async () => undefined);
    let callCount = 0;
    const changedAccount = { ...qqAccount(), auth: { kind: 'credential' as const, provider: 'qq' as const, credentialTarget: 'MailAgentMCP:qq:CHANGED' } };
    const deps: EnrollmentCliDependencies = {
      platform: 'win32',
      getAccounts: () => {
        callCount++;
        if (callCount <= 1) return [qqAccount()];
        return [changedAccount];
      },
      credentials, prompt,
      rotateCredential: rotate,
      authenticateOnly: vi.fn(async () => undefined),
      writeOutput: (text) => { output.push(text); },
    };

    await expect(runEnrollmentCli(['qq-repair'], deps)).rejects.toThrow(
      /removed or its credential target changed/,
    );
    expect(rotate).not.toHaveBeenCalled();
  });

  it('T17R-QQ-SUCCESS-PASSTHROUGH: the re-verification passes for an unchanged account', async () => {
    const output: string[] = [];
    const credentials = {} as CredentialBackend;
    const prompt = vi.fn(async () => 'new-auth-code');
    const rotate = vi.fn(async () => undefined);
    const deps: EnrollmentCliDependencies = {
      platform: 'win32',
      getAccounts: () => [qqAccount()],
      credentials, prompt,
      rotateCredential: rotate,
      authenticateOnly: vi.fn(async () => undefined),
      writeOutput: (text) => { output.push(text); },
    };

    await runEnrollmentCli(['qq-repair'], deps);
    expect(rotate).toHaveBeenCalledOnce();
    expect(output.join('')).toContain('repaired successfully');
  });
});
