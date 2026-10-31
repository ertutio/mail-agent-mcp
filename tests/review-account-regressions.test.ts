import {describe,it,expect,vi} from 'vitest';
import {promises as fs} from 'fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {AccountManager} from '../src/services/account-manager.js';
import {validateAccountCandidate} from '../src/utils/account-candidate.js';
import {AccountEnrollmentService} from '../src/credentials/account-enrollment.js';
const SYNTHETIC_PASSWORD=['fixture','only'].join('-');
const candidate={name:'Synthetic',host:'imap.example.test',port:993,user:'a@example.test',password:SYNTHETIC_PASSWORD,tls:true};
describe('review account regression gates',()=>{
  it.each([
    {kind:'oauth2',provider:'gmail',credentialTarget:'synthetic',endpoints:{password:SYNTHETIC_PASSWORD}},
    {kind:'credential',provider:'qq',credentialTarget:'synthetic',clientId:'inapplicable'},
    {kind:'credential',provider:'qq',credentialTarget:'synthetic',endpoints:{clientSecretTarget:'inapplicable'}},
  ])('rejects nested/provider-inapplicable auth before persistence: %j',auth=>{
    expect(()=>validateAccountCandidate({...candidate,password:'',auth})).toThrow();
  });
  it.each([false,true])('external reads see only durable identities during replacement (failure=%s)',async failure=>{
    const dir=await mkdtemp(join(tmpdir(),'mail-review-isolation-'));const previous=process.env.IMAP_MCP_CONFIG_DIR;process.env.IMAP_MCP_CONFIG_DIR=dir;
    let release!:()=>void;let entered!:()=>void;const held=new Promise<void>(r=>release=r);const reached=new Promise<void>(r=>entered=r);
    try{
      const manager=new AccountManager();const original=await manager.addAccount(candidate);const rename=fs.rename.bind(fs);
      const spy=vi.spyOn(fs,'rename').mockImplementationOnce(async(...args)=>{expect(manager.getAccount(original.id)?.name).toBe('Changed');entered();await held;if(failure)throw new Error('Synthetic durable failure');return rename(...args);});
      const writing=manager.updateAccount(original.id,{name:'Changed'});const settled=writing.then(()=>undefined,e=>e);await reached;
      try{expect(manager.getAccount(original.id)?.name).toBe('Synthetic');expect(manager.getAllAccounts().map(a=>a.name)).toEqual(['Synthetic']);}
      finally{release();await settled;spy.mockRestore();}
      expect(manager.getAccount(original.id)?.name).toBe(failure?'Synthetic':'Changed');
    }finally{if(previous===undefined)delete process.env.IMAP_MCP_CONFIG_DIR;else process.env.IMAP_MCP_CONFIG_DIR=previous;await rm(dir,{recursive:true,force:true});}
  });
  it('an inherited async context cannot bypass a later transaction lock after its transaction ends',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'mail-review-context-'));const previous=process.env.IMAP_MCP_CONFIG_DIR;process.env.IMAP_MCP_CONFIG_DIR=dir;
    let release!:()=>void;const held=new Promise<void>(r=>release=r);let late!:Promise<any>;
    try{
      const manager=new AccountManager();await manager.withStoreTransaction(async()=>{late=held.then(()=>manager.addAccount({...candidate,name:'Late'}));});
      const original=await manager.addAccount(candidate);release();await late;
      expect(manager.getAllAccounts().map(a=>a.name).sort()).toEqual(['Late','Synthetic']);expect(manager.getAccount(original.id)?.name).toBe('Synthetic');
    }finally{release();if(previous===undefined)delete process.env.IMAP_MCP_CONFIG_DIR;else process.env.IMAP_MCP_CONFIG_DIR=previous;await rm(dir,{recursive:true,force:true});}
  });
  it('keeps durable-save failure inside enrollment credential rollback',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'mail-review-enrollment-'));const previous=process.env.IMAP_MCP_CONFIG_DIR;process.env.IMAP_MCP_CONFIG_DIR=dir;
    const values=new Map<string,string>();const backend={read:(target:string)=>{const value=values.get(target);return value===undefined?undefined:{read:()=>value,dispose:()=>{}};},write:(target:string,value:string)=>{values.set(target,value);},delete:(target:string)=>values.delete(target)};
    try{
      const manager=new AccountManager(backend);const enrollment=new AccountEnrollmentService(backend,manager,async()=>{});
      const rename=vi.spyOn(fs,'rename').mockRejectedValueOnce(new Error('Synthetic durable failure'));
      try{await expect(enrollment.enrollQq({email:'fixture@qq.com',name:'Synthetic QQ',authorizationCode:SYNTHETIC_PASSWORD})).rejects.toThrow(/durable failure/);}finally{rename.mockRestore();}
      expect(values.size).toBe(0);expect(manager.getAllAccounts()).toEqual([]);
    }finally{if(previous===undefined)delete process.env.IMAP_MCP_CONFIG_DIR;else process.env.IMAP_MCP_CONFIG_DIR=previous;await rm(dir,{recursive:true,force:true});}
  });
  it('a caught failed save cannot be resurrected by the next save in the same outer transaction',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'mail-review-caught-'));const previous=process.env.IMAP_MCP_CONFIG_DIR;process.env.IMAP_MCP_CONFIG_DIR=dir;
    try{
      const manager=new AccountManager();const original=await manager.addAccount(candidate);
      await manager.withStoreTransaction(async()=>{
        const rename=vi.spyOn(fs,'rename').mockRejectedValueOnce(new Error('Synthetic durable failure'));
        try{await expect(manager.updateAccount(original.id,{name:'Failed identity'})).rejects.toThrow(/durable failure/);}finally{rename.mockRestore();}
        await manager.addAccount({...candidate,name:'Second durable'});
      });
      expect(manager.getAccount(original.id)?.name).toBe('Synthetic');
      expect(manager.getAllAccounts().map(a=>a.name).sort()).toEqual(['Second durable','Synthetic']);
    }finally{if(previous===undefined)delete process.env.IMAP_MCP_CONFIG_DIR;else process.env.IMAP_MCP_CONFIG_DIR=previous;await rm(dir,{recursive:true,force:true});}
  });
});
