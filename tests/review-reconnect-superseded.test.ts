import {beforeEach,describe,expect,it,vi} from 'vitest';
import {ImapService} from '../src/services/imap-service.js';
const {clients}=vi.hoisted(()=>({clients:[] as any[]}));
vi.mock('imapflow',()=>({ImapFlow:class{
  usable=true;connect=vi.fn().mockResolvedValue(undefined);close=vi.fn();logout=vi.fn().mockResolvedValue(undefined);on=vi.fn();
  list=vi.fn().mockResolvedValue([{path:'INBOX',flags:[]}]);
  constructor(public options:any){clients.push(this);}
}}));
const SYNTHETIC_PASSWORD=['fixture','only'].join('-');
const account={id:'fixture',name:'Synthetic',host:'imap.example.test',port:993,user:'a@example.test',password:SYNTHETIC_PASSWORD,tls:true};
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
describe('review reconnect replacement ownership',()=>{
  beforeEach(()=>clients.splice(0));
  it('does not erase or close a replacement client after an older logout finishes',async()=>{
    let current={...account};const service=new ImapService();service.setAccountManager({getAccount:()=>current} as any);await service.connect(account);
    const old=clients[0];old.usable=false;const logout=deferred();old.logout.mockReturnValue(logout.promise);
    const waiting=service.listFolders(account.id).then(value=>({value,error:undefined}),error=>({value:undefined,error}));
    current={...account,host:'imap.changed.example.test'};await service.connect(current);const replacement=clients[1];
    logout.resolve();const outcome=await waiting;
    expect(outcome.error).toBeUndefined();expect(outcome.value).toHaveLength(1);
    expect((service as any).connections.get(account.id)?.client).toBe(replacement);expect(replacement.close).not.toHaveBeenCalled();expect(clients).toHaveLength(2);
  });
  it('does not downgrade a removed managed identity to a temporary account after logout',async()=>{
    let current:typeof account|undefined={...account};const service=new ImapService();service.setAccountManager({getAccount:()=>current} as any);await service.connect(account);
    clients[0].usable=false;const logout=deferred();clients[0].logout.mockReturnValue(logout.promise);
    const waiting=expect(service.listFolders(account.id)).rejects.toThrow(/removed/i);
    current=undefined;logout.resolve();await waiting;expect(clients).toHaveLength(1);
  });
  it('joins a newer revision authentication still pending when the old logout completes',async()=>{
    let resolveAuth!:(value:any)=>void;const auth=new Promise<any>(r=>resolveAuth=r);
    const resolved={kind:'password',user:account.user,password:account.password};
    const resolver={resolve:vi.fn().mockResolvedValueOnce(resolved).mockReturnValueOnce(auth)};
    let current={...account};const service=new ImapService(resolver as any);service.setAccountManager({getAccount:()=>current} as any);await service.connect(account);
    clients[0].usable=false;const logout=deferred();clients[0].logout.mockReturnValue(logout.promise);
    const waiting=service.listFolders(account.id).then(value=>({value,error:undefined}),error=>({value:undefined,error}));
    current={...account,host:'imap.changed.example.test'};const connecting=service.connect(current).then(()=>undefined,error=>error);
    logout.resolve();await Promise.resolve();resolveAuth(resolved);
    expect(await connecting).toBeUndefined();expect((await waiting).error).toBeUndefined();
    expect(resolver.resolve).toHaveBeenCalledTimes(2);expect(clients).toHaveLength(2);expect(clients[1].close).not.toHaveBeenCalled();
  });
});
