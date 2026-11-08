import { describe, it, expect, vi } from 'vitest';
import { ImapService } from '../src/services/imap-service.js';
import { emailTools } from '../src/tools/email-tools.js';

// B5: appendMessage collapsed every error into `false`, and the draft
// handler reported a definite failure — but a disconnect (or timeout)
// AFTER the APPEND was submitted leaves the outcome unknown: the server
// may already hold the draft, and an automatic retry would duplicate it.
// The result now distinguishes confirmed / definite failure / unknown,
// and the handler tells the user to check the Drafts folder first.

const harness = (append?: () => Promise<unknown>, connect?: () => Promise<unknown>) => {
  const svc = new ImapService();
  vi.spyOn(svc as any, 'ensureConnected').mockImplementation(connect ?? vi.fn(async () => ({
    append: append ?? vi.fn(async () => ({ uid: 12, uidValidity: 1n })),
  })));
  return svc;
};

describe('B5: appendMessage distinguishes confirmed, rejected and unknown outcomes', () => {
  it('B5-DRAFT-CONFIRMED: a real append result is saved', async () => {
    const svc = harness();
    const result = await svc.appendMessage('acc1', 'Drafts', 'raw', ['\\Draft']);
    expect(result.saved).toBe(true);
    expect(result.outcomeUnknown).toBeUndefined();
  });

  it('B5-DRAFT-REJECTED: a server NO is a definite failure, not unknown', async () => {
    const svc = harness(() => Promise.resolve(false));
    const result = await svc.appendMessage('acc1', 'Drafts', 'raw', ['\\Draft']);
    expect(result.saved).toBe(false);
    expect(result.outcomeUnknown).toBeUndefined();
    expect(result.errorCategory).toBe('append_failed');
  });

  it('B5-DRAFT-DISCONNECT-AFTER-WRITE: a drop after submission reports the outcome as unknown', async () => {
    const svc = harness(() => Promise.reject(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })));
    const result = await svc.appendMessage('acc1', 'Drafts', 'raw', ['\\Draft']);
    expect(result.saved).toBe(false);
    expect(result.outcomeUnknown).toBe(true);
    expect(result.error).toMatch(/may have been saved/i);
  });

  it('B5-DRAFT-CONNECT-FAIL: failing before the APPEND is a definite failure', async () => {
    const svc = harness(undefined, () => Promise.reject(new Error('auth failed')));
    const result = await svc.appendMessage('acc1', 'Drafts', 'raw', ['\\Draft']);
    expect(result.saved).toBe(false);
    expect(result.outcomeUnknown).toBeUndefined();
    expect(result.error).toMatch(/auth failed/);
  });

  it('B5-DRAFT-TIMEOUT-AFTER-START: a timeout after submission is unknown', async () => {
    const svc = harness(() => new Promise(() => {}));
    const result = await svc.appendMessage('acc1', 'Drafts', 'raw', ['\\Draft'], 20);
    expect(result.saved).toBe(false);
    expect(result.outcomeUnknown).toBe(true);
    expect(result.errorCategory).toBe('timeout');
  });

  it('B5-DRAFT-TIMEOUT-BEFORE-START: a timeout during connect is a definite failure', async () => {
    const svc = harness(undefined, () => new Promise(() => {}));
    const result = await svc.appendMessage('acc1', 'Drafts', 'raw', ['\\Draft'], 20);
    expect(result.saved).toBe(false);
    expect(result.outcomeUnknown).toBeUndefined();
    expect(result.errorCategory).toBe('timeout');
  });
});

describe('B5: imap_save_draft reports unknown APPEND outcomes without inviting a blind retry', () => {
  const handlers = new Map<string, Function>();
  const imapService: any = {
    findDraftsFolder: vi.fn(async () => 'Drafts'),
    appendMessage: vi.fn(),
  };
  const manager: any = {
    resolveAccountId: (id?: string) => id ?? 'acc1',
    getAccount: vi.fn(async () => ({ id: 'acc1', name: 'T', email: 'user@synth.test', user: 'user@synth.test', saveToSent: false })),
  };

  emailTools(
    { registerTool: (name: string, _def: unknown, handler: Function) => handlers.set(name, handler) } as any,
    imapService,
    manager,
    { composeRaw: vi.fn(async () => Buffer.from('raw')) } as any,
  );

  const call = async (appendResult: any, appendThrows = false) => {
    imapService.appendMessage.mockImplementation(appendThrows
      ? () => Promise.reject(new Error('boom'))
      : () => Promise.resolve(appendResult));
    return handlers.get('imap_save_draft')!({ accountId: 'acc1', to: 'r@synth.test', subject: 's', text: 'b' });
  };

  it('B5-DRAFT-HANDLER-SAVED: a confirmed append still reports success', async () => {
    const result = JSON.parse((await call({ saved: true, folder: 'Drafts' })).content[0].text);
    expect(result.success).toBe(true);
    expect(result.folder).toBe('Drafts');
  });

  it('B5-DRAFT-HANDLER-UNKNOWN: an unknown outcome returns guidance to check the folder, not a failure to retry', async () => {
    const result = JSON.parse((await call({ saved: false, outcomeUnknown: true, folder: 'Drafts', error: 'socket hang up' })).content[0].text);
    expect(result.success).toBe(false);
    expect(result.outcomeUnknown).toBe(true);
    expect(result.message).toMatch(/check the folder before retrying/i);
    expect(result.message).toMatch(/may have been saved/i);
  });

  it('B5-DRAFT-HANDLER-FAILED: a definite failure still throws', async () => {
    await expect(call({ saved: false, folder: 'Drafts', errorCategory: 'append_failed', error: 'server said NO' }))
      .rejects.toThrow(/server said NO/);
  });
});
