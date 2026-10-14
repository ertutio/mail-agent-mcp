import {describe,it,expect,vi} from 'vitest';
import {promises as fs} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AccountManager} from '../src/services/account-manager.js';
describe('atomic account-store mutations',()=>{
  it('serializes separate writer processes',async()=>{
    const root=await mkdtemp(join(tmpdir(),'mail-process-fixture-'));
    const helper=new URL('../src/utils/account-store-lock.ts',import.meta.url).href;
    const code=`import {withAccountStoreLock} from ${JSON.stringify(helper)};import{readFile,writeFile}from'node:fs/promises';import{join}from'node:path';const root=${JSON.stringify(root)};await withAccountStoreLock(root,async()=>{let n=0;try{n=Number(await readFile(join(root,'counter'),'utf8'));}catch{}await new Promise(r=>setTimeout(r,50));await writeFile(join(root,'counter'),String(n+1));});`;
    try{await Promise.all([promisify(execFile)(process.execPath,['--experimental-strip-types','--input-type=module','-e',code]),promisify(execFile)(process.execPath,['--experimental-strip-types','--input-type=module','-e',code])]);expect(await readFile(join(root,'counter'),'utf8')).toBe('2');}
    finally{await rm(root,{recursive:true,force:true});}
  });
  it('preserves the committed file and memory when atomic replacement fails',async()=>{
    const root=await mkdtemp(join(tmpdir(),'mail-rename-fixture-'));const previous=process.env.IMAP_MCP_CONFIG_DIR;process.env.IMAP_MCP_CONFIG_DIR=root;
    try{
      const manager=new AccountManager();const account={host:'imap.example.test',port:993,user:'a@example.test',password:['fixture','-only'].join(''),tls:true};
      await manager.addAccount({...account,name:'A'});const file=join(root,'accounts.json');const original=await readFile(file,'utf8');
      const rename=vi.spyOn(fs,'rename').mockRejectedValueOnce(new Error('Synthetic atomic replacement failure'));
      try{await expect(manager.addAccount({...account,name:'B'})).rejects.toThrow(/replacement failure/);}finally{rename.mockRestore();}
      expect(await readFile(file,'utf8')).toBe(original);expect(manager.getAllAccounts().map(a=>a.name)).toEqual(['A']);
    }finally{if(previous===undefined)delete process.env.IMAP_MCP_CONFIG_DIR;else process.env.IMAP_MCP_CONFIG_DIR=previous;await rm(root,{recursive:true,force:true});}
  });
  it('preserves independent manager writes and refuses corrupt-store replacement',async()=>{
    const root=await mkdtemp(join(tmpdir(),'mail-store-fixture-'));const previous=process.env.IMAP_MCP_CONFIG_DIR;
    process.env.IMAP_MCP_CONFIG_DIR=root;
    try{
      const a=new AccountManager();const b=new AccountManager();
      const account={host:'imap.example.test',port:993,user:'owner@example.test',password:['fixture','-only'].join(''),tls:true};
      await Promise.all([a.addAccount({...account,name:'A'}),b.addAccount({...account,name:'B'})]);
      expect(new AccountManager().getAllAccounts().map(a=>a.name).sort()).toEqual(['A','B']);
      const file=join(root,'accounts.json'); await writeFile(file,'not-json');
      await expect(a.addAccount({...account,name:'C'})).rejects.toThrow();
      expect(await readFile(file,'utf8')).toBe('not-json');
    }finally{if(previous===undefined)delete process.env.IMAP_MCP_CONFIG_DIR;else process.env.IMAP_MCP_CONFIG_DIR=previous;await rm(root,{recursive:true,force:true});}
  });
});
