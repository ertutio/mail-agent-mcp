import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { WebUIServer } from '../src/web/server.js';
let server: Server;
afterEach(async()=>{server?.closeAllConnections();if(server) await new Promise<void>(r=>server.close(()=>r()));});
async function setup(){
  const manager={addAccount:vi.fn(async (account:any)=>({...account,id:'fixture'})),updateAccount:vi.fn(async (id:string,updates:any)=>({id,...updates}))};
  const wizard=new WebUIServer(0,{accountManager:manager as any,imapService:{} as any});
  server=wizard.getApp().listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${(server.address() as any).port}`;
  const token=new URL(wizard.getSetupUrl()).hash.slice('#session='.length);
  const request=(method:string,path:string,body:any)=>fetch(base+path,{method,headers:{'content-type':'application/json','x-mail-agent-session':token},body:JSON.stringify(body)});
  return {manager,request};
}
describe('browser account settings replace removed chat configuration tools',()=>{
  it('preserves Sent folder and default BCC settings through local account creation',async()=>{
    const {manager,request}=await setup();
    const response=await request('POST','/api/accounts',{name:'fixture',email:'fixture@example.test',host:'imap.example.test',password:['fixture','-only'].join(''),sentFolder:'Sent Mail',defaultBcc:'archive@example.test'});
    expect(response.status).toBe(200);
    expect(manager.addAccount).toHaveBeenCalledWith(expect.objectContaining({sentFolder:'Sent Mail',defaultBcc:'archive@example.test'}));
  });
  it('updates and clears optional settings without a model-facing credential tool',async()=>{
    const {manager,request}=await setup();
    expect((await request('PUT','/api/accounts/fixture',{sentFolder:'Sent Mail',defaultBcc:['archive@example.test']})).status).toBe(200);
    expect(manager.updateAccount).toHaveBeenLastCalledWith('fixture',expect.objectContaining({sentFolder:'Sent Mail',defaultBcc:['archive@example.test']}));
    expect((await request('PUT','/api/accounts/fixture',{sentFolder:'',defaultBcc:''})).status).toBe(200);
    expect(manager.updateAccount).toHaveBeenLastCalledWith('fixture',expect.objectContaining({sentFolder:undefined,defaultBcc:undefined}));
  });
});
