import { describe, it, expect, vi } from 'vitest';
import { AccountEnrollmentService } from '../src/credentials/account-enrollment.js';
import { AccountAuthResolver } from '../src/credentials/account-auth.js';

describe('secure NetEase enrollment', () => {
  it.each([
    ['163', 'imap.163.com', 'smtp.163.com', 465],
    ['126', 'imap.126.com', 'smtp.126.com', 465],
    ['yeah', 'imap.yeah.net', 'smtp.yeah.net', 465],
    ['netease-enterprise', 'imaphz.qiye.163.com', 'smtphz.qiye.163.com', 994],
  ])('stores %s authorization only in the vault and binds endpoints', async (provider, host, smtpHost, smtpPort) => {
    const vault = { read: vi.fn().mockReturnValue(undefined), write: vi.fn(), delete: vi.fn() };
    const addAccount = vi.fn().mockImplementation(async (account) => ({ ...account, id: 'one' }));
    const secret = ['synthetic', '-authorization'].join('');
    const enrolled = await new AccountEnrollmentService(vault, { addAccount }).enrollNetease({ provider: provider as any, email: 'owner@example.test', name: provider as string, authorizationCode: secret });
    expect(enrolled).toMatchObject({ host, tls: true, port: 993, password: '', smtp: { host: smtpHost, port: smtpPort, secure: true }, auth: { provider: 'netease' } });
    expect(JSON.stringify(addAccount.mock.calls)).not.toContain(secret); expect(vault.write).toHaveBeenCalledWith(expect.any(String), secret);
    const handle = { read: () => secret, dispose: vi.fn() }; vault.read.mockReturnValue(handle as any);
    await expect(new AccountAuthResolver(vault).resolve(enrolled)).resolves.toMatchObject({ password: secret });
    const modified = { ...enrolled, host: 'imap.other.example.test' }; vault.read.mockClear();
    await expect(new AccountAuthResolver(vault).resolve(modified)).rejects.toThrow(/endpoint/i); expect(vault.read).not.toHaveBeenCalled();
  });
});
