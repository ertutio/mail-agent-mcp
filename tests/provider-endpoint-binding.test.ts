import { describe, it, expect, vi } from 'vitest';
import { AccountAuthResolver, accountForPersistence } from '../src/credentials/account-auth.js';
import { credentialTarget } from '../src/credentials/credential-backend.js';
import type { ImapAccount } from '../src/types/index.js';

describe('credential-bound provider endpoints', () => {
  const make = (provider: 'qq'|'gmail'): ImapAccount => ({ id:'synthetic',name:provider,user:'owner@example.test',password:'',host:`imap.${provider}.com`,port:993,tls:true,smtp:{host:`smtp.${provider}.com`,port:465,secure:true},auth: provider==='qq' ? {kind:'credential',provider,credentialTarget:credentialTarget(provider,'owner@example.test')} : {kind:'oauth2',provider,clientId:'fixture-client',credentialTarget:credentialTarget(provider,'owner@example.test')} });
  it.each(['qq','gmail'] as const)('rejects endpoint changes for %s before reading credentials', async provider => {
    const read = vi.fn(); const exchange = vi.fn();
    const resolver = new AccountAuthResolver({read,write:vi.fn(),delete:vi.fn()},exchange);
    const account = make(provider);
    for (const changed of [{...account,host:'imap.attacker.example.test'},{...account,tls:false},{...account,port:143},{...account,smtp:{host:'smtp.attacker.example.test',port:465,secure:true}},{...account,smtp:{...account.smtp!,tls:{rejectUnauthorized:false}}}]) {
      expect(()=>accountForPersistence(changed)).toThrow(/endpoint|TLS/i);
      await expect(resolver.resolve(changed,changed.smtp?.host==='smtp.attacker.example.test'||changed.smtp?.tls ? 'smtp':'imap')).rejects.toThrow(/endpoint|TLS/i);
    }
    expect(read).not.toHaveBeenCalled(); expect(exchange).not.toHaveBeenCalled();
  });
  it('retains valid TLS endpoints and SMTP STARTTLS compatibility', () => {
    for (const provider of ['qq','gmail'] as const) {
      expect(()=>accountForPersistence(make(provider))).not.toThrow();
      expect(()=>accountForPersistence({...make(provider),smtp:{host:`smtp.${provider}.com`,port:587,secure:false}})).not.toThrow();
    }
  });
});
