import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImapService } from '../src/services/imap-service.js';
import type { ImapAccount } from '../src/types/index.js';

// Records the options every ImapFlow is constructed with so we can assert on
// the TLS parameters the service hands to imapflow.
const constructorOptions: any[] = [];

vi.mock('imapflow', () => ({
  ImapFlow: class {
    constructor(options: any) {
      constructorOptions.push(options);
    }
    connect() {
      return Promise.resolve();
    }
    logout() {
      return Promise.resolve();
    }
    list() {
      return Promise.resolve([]);
    }
    status() {
      return Promise.resolve({ messages: 0 });
    }
    on() {}
  },
}));

describe('ImapService TLS host for local bridges', () => {
  let service: ImapService;

  const account = (host: string): ImapAccount => ({
    id: 'bridge',
    name: 'Bridge',
    host,
    port: 1143,
    user: 'user@example.com',
    password: 'secret',
    tls: false,
  });

  beforeEach(() => {
    constructorOptions.length = 0;
    service = new ImapService();
  });

  // A local bridge (e.g. ProtonMail Bridge) listens on 127.0.0.1 with a cert
  // bound to that IP and upgrades via STARTTLS. imapflow's upgrade path passes
  // no `host` to Node's TLS layer, so without an explicit tls.host Node checks
  // the cert against the default `localhost` and rejects the 127.0.0.1 cert.
  it('passes the account host to the TLS layer so cert validation targets 127.0.0.1', async () => {
    await service.connect(account('127.0.0.1'));

    expect(constructorOptions).toHaveLength(1);
    expect(constructorOptions[0].host).toBe('127.0.0.1');
    expect(constructorOptions[0].tls?.host).toBe('127.0.0.1');
  });
});

// T02 / SEC-02: one transport policy for every ImapFlow entry point. Implicit
// TLS when the account asks for it; otherwise a REQUIRED STARTTLS upgrade
// before authentication (imapflow fails the connect when the server does not
// advertise STARTTLS or the upgrade fails), so no path can send credentials
// in cleartext or downgrade opportunistically.
describe('T02: all three IMAP entry points share one transport policy (SEC-02)', () => {
  let service: ImapService;

  const account = (tls: boolean): ImapAccount => ({
    id: 'acc-t02',
    name: 'T02',
    host: 'imap.synth.test',
    port: tls ? 993 : 143,
    user: 'user@synth.test',
    password: ['t02-', 'synthetic', '-pw'].join(''),
    tls,
  });

  beforeEach(() => {
    constructorOptions.length = 0;
    service = new ImapService();
  });

  it('T02-POLICY-IMPLICIT: tls accounts use implicit TLS and never set doSTARTTLS', async () => {
    await service.connect(account(true));
    await service.authenticateOnly(account(true));
    await service.testConnection(account(true));

    expect(constructorOptions).toHaveLength(3);
    for (const options of constructorOptions) {
      expect(options.secure).toBe(true);
      expect(options.doSTARTTLS).toBeUndefined();
      expect(options.tls?.host).toBe('imap.synth.test');
    }
  });

  it('T02-POLICY-STARTTLS: cleartext accounts require STARTTLS at every entry point', async () => {
    await service.connect(account(false));
    await service.authenticateOnly(account(false));
    await service.testConnection(account(false));

    expect(constructorOptions).toHaveLength(3);
    for (const options of constructorOptions) {
      expect(options.secure).toBe(false);
      expect(options.doSTARTTLS).toBe(true);
      expect(options.tls?.host).toBe('imap.synth.test');
    }
  });
});
