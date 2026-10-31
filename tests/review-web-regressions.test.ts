import {describe,it,expect,vi} from 'vitest';
import {WebUIServer} from '../src/web/server.js';
import type {AddressInfo} from 'node:net';
const SYNTHETIC_PASSWORD=['fixture','only'].join('-');
describe('review temporary connection ownership',()=>{
  it('uses unique temporary identities even when two requests share a clock tick',async()=>{
    const ids:string[]=[];let release!:()=>void;const held=new Promise<void>(r=>release=r);
    const imap={connect:vi.fn(async(account:any)=>{ids.push(account.id);if(ids.length===2)release();await held;}),listFolders:vi.fn().mockResolvedValue([]),disconnect:vi.fn().mockResolvedValue(undefined)};
    const wizard=new WebUIServer(0,{accountManager:{} as any,imapService:imap as any});const app=wizard.getApp();
    const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
    const token=new URL(wizard.getSetupUrl()).hash.slice(1);const session=new URLSearchParams(token).get('session')!;
    const clock=vi.spyOn(Date,'now').mockReturnValue(123456789);
    try{
      const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/test-connection`;
      const responses=await Promise.all(['a','b'].map(user=>fetch(url,{method:'POST',headers:{'content-type':'application/json','x-mail-agent-session':session},body:JSON.stringify({host:'imap.example.test',imapUsername:user,password:SYNTHETIC_PASSWORD})})));
      expect(responses.map(r=>r.status)).toEqual([200,200]);expect(new Set(ids).size).toBe(2);expect(imap.disconnect).toHaveBeenCalledTimes(2);
    }finally{clock.mockRestore();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
  });
});
