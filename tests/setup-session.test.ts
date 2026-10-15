import {describe,it,expect,vi} from 'vitest';
import {WebUIServer} from '../src/web/server.js';
describe('setup session and exact origin boundary',()=>{
  it('requires a session token and rejects other loopback origins',async()=>{
    const update=vi.fn(async()=>({id:'fixture',name:'fixture'}));
    const wizard=new WebUIServer(0,{accountManager:{updateAccount:update,getAllAccounts:()=>[]} as any,imapService:{} as any});
    const server=wizard.getApp().listen(0,'127.0.0.1');
    await new Promise<void>(r=>server.once('listening',r));
    const base=`http://127.0.0.1:${(server.address() as any).port}`;
    try{
      expect((await fetch(base+'/api/accounts')).status).toBe(403);
      const session=await fetch(base+'/api/session');
      expect(session.status).toBe(403);
      const sessionToken=new URLSearchParams(new URL(wizard.getSetupUrl()).hash.slice(1)).get('session')!;
      expect(session.headers.get('cache-control')).toBe('no-store');
      const headers={'x-mail-agent-session':sessionToken,'content-type':'application/json'};
      expect((await fetch(base+'/api/accounts/fixture',{method:'PUT',headers:{...headers,origin:'http://localhost:54321'},body:'{"name":"fixture"}'})).status).toBe(403);
      expect(update).not.toHaveBeenCalled();
      expect((await fetch(base+'/api/accounts/fixture',{method:'PUT',headers:{...headers,origin:base},body:'{"name":"fixture"}'})).status).toBe(200);
      expect(update).toHaveBeenCalledOnce();
    }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
  });
});
