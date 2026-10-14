import {describe,it,expect} from 'vitest';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AccountManager} from '../src/services/account-manager.js';
describe('atomic account-store mutations',()=>{
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
