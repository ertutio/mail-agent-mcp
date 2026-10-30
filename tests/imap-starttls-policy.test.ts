import { describe, it, expect, afterEach } from 'vitest';
import * as net from 'node:net';
import { ImapService } from '../src/services/imap-service.js';
import type { ImapAccount } from '../src/types/index.js';

// T02 / SEC-02: no IMAP entry point may send authentication bytes over a
// cleartext transport. These tests drive the REAL imapflow against synthetic
// localhost servers and assert on the bytes that actually reach the wire.
//   T02-CLEARTEXT-NO-STARTTLS — server without STARTTLS support
//   T02-STARTTLS-REJECTED — server advertises STARTTLS but refuses the upgrade
// Both must fail the connect before any LOGIN/AUTHENTICATE leaves the client.

const SYNTHETIC_PASSWORD = ['t02-', 'synthetic', '-pw'].join('');

type ServerOptions = {
  capabilities: string;
  starttlsReply?: string; // reply to a STARTTLS command, e.g. 'NO STARTTLS refused'
};

class SyntheticImapServer {
  private server?: net.Server;
  private sockets: net.Socket[] = [];
  private chunks: Buffer[] = [];
  private sawAuthBytes = false;
  private pending = '';

  constructor(private readonly options: ServerOptions) {}

  start(): Promise<number> {
    return new Promise(resolve => {
      this.server = net.createServer(socket => {
        this.sockets.push(socket);
        socket.write('* OK synthetic ready\r\n');
        socket.on('data', chunk => {
          this.chunks.push(chunk);
          this.pending += chunk.toString('binary');
          let index: number;
          while ((index = this.pending.indexOf('\r\n')) !== -1) {
            const line = this.pending.slice(0, index);
            this.pending = this.pending.slice(index + 2);
            this.handleLine(line, socket);
          }
        });
      });
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server!.address() as net.AddressInfo;
        resolve(address.port);
      });
    });
  }

  private handleLine(line: string, socket: net.Socket): void {
    const tag = line.split(/\s+/)[0] || 'A1';
    const command = line.slice(tag.length).trim().toUpperCase();
    if (command.startsWith('CAPABILITY')) {
      socket.write(`* CAPABILITY ${this.options.capabilities}\r\n${tag} OK done\r\n`);
      return;
    }
    if (command.startsWith('STARTTLS')) {
      if (this.options.starttlsReply) {
        socket.write(`${tag} ${this.options.starttlsReply}\r\n`);
      }
      return;
    }
    if (/^(LOGIN|AUTHENTICATE)\b/.test(command)) {
      // Authentication bytes reached the wire in cleartext — record it.
      this.sawAuthBytes = true;
      socket.write(`${tag} NO rejected by synthetic server\r\n`);
      socket.end();
    }
  }

  receivedText(): string {
    return Buffer.concat(this.chunks).toString('binary');
  }

  get authReachedWire(): boolean {
    return this.sawAuthBytes;
  }

  stop(): void {
    for (const socket of this.sockets) socket.destroy();
    this.server?.close();
  }
}

const account = (port: number): ImapAccount => ({
  id: 'acc-t02',
  name: 'T02 Synthetic Account',
  host: '127.0.0.1',
  port,
  user: 'user@synth.test',
  password: SYNTHETIC_PASSWORD,
  tls: false,
});

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

describe('T02: IMAP authentication bytes never cross a cleartext transport (SEC-02)', () => {
  it('T02-CLEARTEXT-NO-STARTTLS: connect fails with no auth bytes when the server lacks STARTTLS', async () => {
    const server = new SyntheticImapServer({ capabilities: 'IMAP4rev1' });
    const port = await server.start();
    cleanup.push(() => server.stop());

    const service = new ImapService();
    await expect(service.connect(account(port))).rejects.toThrow(/STARTTLS/i);

    // Give the socket a beat to flush anything already in flight.
    await new Promise(resolve => setImmediate(resolve));

    const wire = server.receivedText();
    expect(server.authReachedWire).toBe(false);
    expect(wire).not.toMatch(/LOGIN|AUTHENTICATE/i);
    expect(wire).not.toContain(SYNTHETIC_PASSWORD);
  });

  it('T02-STARTTLS-REJECTED: connect fails with no auth bytes when the server refuses STARTTLS', async () => {
    const server = new SyntheticImapServer({
      capabilities: 'IMAP4rev1 STARTTLS',
      starttlsReply: 'NO STARTTLS refused',
    });
    const port = await server.start();
    cleanup.push(() => server.stop());

    const service = new ImapService();
    await expect(service.connect(account(port))).rejects.toThrow();

    await new Promise(resolve => setImmediate(resolve));

    const wire = server.receivedText();
    expect(server.authReachedWire).toBe(false);
    expect(wire).not.toMatch(/LOGIN|AUTHENTICATE/i);
    expect(wire).not.toContain(SYNTHETIC_PASSWORD);
  });
});
