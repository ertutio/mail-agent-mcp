import { describe, it, expect, vi } from 'vitest';
const state = vi.hoisted(() => ({ accounts: [] as any[] }));
vi.mock('../src/services/account-manager.js', () => ({ AccountManager: class {
  async addAccount(account: any) { state.accounts.push(account); return { ...account, id: 'synthetic-account' }; }
} }));
import { runEnrollmentCli } from '../src/enroll.js';

describe('NetEase local registration CLI', () => {
  it.each(['163', '126', 'yeah', 'netease-enterprise'])('uses a hidden prompt and the correct enrollment for %s', async provider => {
    state.accounts = [];
    const secret = ['synthetic', '-auth-code'].join('');
    const prompt = vi.fn(async (label: string) => label === 'Email address' ? 'owner@example.test' : label === 'Account name' ? provider : secret);
    // T16: enrollment now verifies the credential with a login check before
    // committing; this fixture mocks that verification and gives the vault
    // backend the boolean contract the real one has.
    const authenticateOnly = vi.fn(async () => undefined);
    const credentials = { read: vi.fn().mockReturnValue(undefined), write: vi.fn(() => true), delete: vi.fn(() => true) };
    const output: string[] = [];
    await runEnrollmentCli([provider], { platform: 'win32', prompt, credentials, authenticateOnly, writeOutput: text => { output.push(text); } });
    expect(authenticateOnly).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledWith('NetEase client authorization code', { secret: true });
    expect(state.accounts[0].auth.provider).toBe('netease');
    expect(JSON.stringify(state.accounts)).not.toContain(secret); expect(output.join('')).not.toContain(secret);
  });
  it('refuses non-interactive secret entry', async () => {
    await expect(runEnrollmentCli(['163'], { platform: 'win32', stdinIsTTY: false })).rejects.toThrow(/interactive/i);
  });
  it('rejects authorization codes passed as command arguments', async () => {
    await expect(runEnrollmentCli(['163', 'synthetic-code'], { platform: 'win32' })).rejects.toThrow(/interactive prompts/);
  });
});
