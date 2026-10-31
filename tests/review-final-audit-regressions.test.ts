import {beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AccountManager} from '../src/services/account-manager.js';
import {ImapService} from '../src/services/imap-service.js';
import {unifiedSearchTools} from '../src/tools/unified-search-tools.js';
const {clients}=vi.hoisted(()=>({clients:[] as any[]}));
vi.mock('imapflow',()=>({ImapFlow:class{
  usable=true;connect=vi.fn().mockResolvedValue(undefined);logout=vi.fn().mockResolvedValue(undefined);close=vi.fn();on=vi.fn();
  mailbox={path:'INBOX',flags:new Set()};getMailboxLock=vi.fn().mockResolvedValue({release:vi.fn()});
  status=vi.fn();append=vi.fn();constructor(){clients.push(this);}
}}));
const SYNTHETIC_PASSWORD=['fixture','only'].join('-');
const account={id:'a',name:'A',host:'imap.example.test',port:993,user:'a@example.test',password:SYNTHETIC_PASSWORD,tls:true};
const status={messages:0,recent:0,unseen:0,uidValidity:1,uidNext:1};
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
function searchSetup(){
  const accounts=[account,{...account,id:'b',name:'B',user:'b@example.test'}];let handler:any;
  const imap={listFolders:vi.fn().mockResolvedValue([{name:'INBOX',attributes:[]}]),searchEmailPage:vi.fn().mockResolvedValue({messages:[],matched:0,nextCursor:{beforeUid:10,uidValidity:1}})};
  const manager={getAllAccounts:()=>accounts,resolveAccountId:(_id:unknown,name:string)=>{const a=accounts.find(a=>a.name===name);if(!a)throw new Error('Unknown account');return a.id;}};
  unifiedSearchTools({registerTool:(_n:any,_s:any,h:any)=>handler=h} as any,imap as any,manager as any,{maxPagesPerFolder:1});
  return {imap,call:async(args:any)=>JSON.parse((await handler(args)).content[0].text)};
}
describe('independent final audit regression gates',()=>{
  beforeEach(()=>clients.splice(0));
  it('adds an explicit empty SMTP password successfully and remains consistent after restart',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'mail-final-empty-'));const previous=process.env.IMAP_MCP_CONFIG_DIR;process.env.IMAP_MCP_CONFIG_DIR=dir;
    try{
      const manager=new AccountManager();const {id:ignored,...candidate}=account;
      const added=await manager.addAccount({...candidate,smtp:{host:'smtp.example.test',port:465,secure:true,password:''}});
      expect(added.smtp?.password).toBe('');expect(new AccountManager().getAccount(added.id)).toEqual(added);
    }finally{if(previous===undefined)delete process.env.IMAP_MCP_CONFIG_DIR;else process.env.IMAP_MCP_CONFIG_DIR=previous;await rm(dir,{recursive:true,force:true});}
  });
  it.each(['messages','recent','unseen','uidValidity','uidNext'])('rejects missing STATUS %s rather than inventing zero',async key=>{
    const service=new ImapService();await service.connect(account);const incomplete={...status};delete (incomplete as any)[key];clients[0].status.mockResolvedValue(incomplete);
    await expect(service.getFolderStatus(account.id,'INBOX')).rejects.toThrow(/status|missing|invalid/i);
    await expect(service.getFolderStatusSnapshot(account.id,'INBOX')).rejects.toThrow(/status|missing|invalid/i);
  });
  it.each([NaN,-1,Infinity,1.5])('rejects invalid STATUS count %s',async messages=>{
    const service=new ImapService();await service.connect(account);clients[0].status.mockResolvedValue({...status,messages});
    await expect(service.getFolderStatusSnapshot(account.id,'INBOX')).rejects.toThrow(/status|invalid/i);
  });
  it('retains real zero STATUS counters',async()=>{
    const service=new ImapService();await service.connect(account);clients[0].status.mockResolvedValue(status);
    expect(await service.getFolderStatus(account.id,'INBOX')).toEqual(status);expect((await service.getFolderStatusSnapshot(account.id,'INBOX')).status).toEqual(status);
  });
  it.each(['uidValidity','uidNext'])('rejects zero STATUS identity field %s',async key=>{
    const service=new ImapService();await service.connect(account);clients[0].status.mockResolvedValue({...status,[key]:0});
    await expect(service.getFolderStatus(account.id,'INBOX')).rejects.toThrow(/status|invalid/i);
  });
  it('labels a timed out APPEND already started as unknown even if it finishes later, without retry',async()=>{
    const service=new ImapService();await service.connect(account);vi.spyOn(service,'findSpecialUseFolder').mockResolvedValue('Sent');
    const append=deferred<any>();clients[0].append.mockReturnValue(append.promise);
    const result=await service.appendToSentFolder(account.id,'fixture',undefined,10);
    expect(clients[0].append).toHaveBeenCalledTimes(1);expect((result as any).outcomeUnknown).toBe(true);expect(result.error).toMatch(/unknown|uncertain/i);
    append.resolve({uid:1});await Promise.resolve();expect(clients[0].append).toHaveBeenCalledTimes(1);expect(clients[0].close).not.toHaveBeenCalled();
  });
  it('does not begin APPEND after a pre-APPEND timeout',async()=>{
    const service=new ImapService();await service.connect(account);const discovery=deferred<string>();vi.spyOn(service,'findSpecialUseFolder').mockReturnValue(discovery.promise);
    const result=await service.appendToSentFolder(account.id,'fixture',undefined,10);expect((result as any).outcomeUnknown).not.toBe(true);
    discovery.resolve('Sent');await Promise.resolve();await Promise.resolve();expect(clients[0].append).not.toHaveBeenCalled();
  });
  it('labels a started APPEND throwing without confirmation as unknown and never retries',async()=>{
    const service=new ImapService();await service.connect(account);vi.spyOn(service,'findSpecialUseFolder').mockResolvedValue('Sent');
    clients[0].append.mockRejectedValue(new Error('Synthetic transport loss after write'));
    const result=await service.appendToSentFolder(account.id,'fixture',undefined,100);
    expect(result.saved).toBe(false);expect((result as any).outcomeUnknown).toBe(true);expect(result.error).toMatch(/unknown|uncertain/i);
    expect(clients[0].append).toHaveBeenCalledTimes(1);expect(clients[0].close).not.toHaveBeenCalled();
  });
  it.each([{initialNames:['A']},{initialNames:['A','B']}])('rejects cursor scope exclusion before network: %j',async({initialNames})=>{
    const {imap,call}=searchSetup();const initial=await call({accountNames:initialNames});imap.listFolders.mockClear();imap.searchEmailPage.mockClear();
    const narrowed=initialNames.length===1?['B']:['A'];
    await expect(call({accountNames:narrowed,cursors:initial.cursors})).rejects.toThrow(/cursor|scope|account/i);
    expect(imap.listFolders).not.toHaveBeenCalled();expect(imap.searchEmailPage).not.toHaveBeenCalled();
  });
  it('continues only pending cursor accounts within the original account range',async()=>{
    const {imap,call}=searchSetup();const initial=await call({accountNames:['A','B']});const pending=initial.cursors.filter((c:any)=>c.accountId==='b');
    imap.searchEmailPage.mockClear();const continued=await call({accountNames:['A','B'],cursors:pending});
    expect(continued.accounts.map((a:any)=>a.accountId)).toEqual(['b']);expect(imap.searchEmailPage.mock.calls.every((c:any)=>c[0]==='b')).toBe(true);
  });
  it('allows different ordering of the same cursor account scope',async()=>{
    const {call}=searchSetup();const initial=await call({accountNames:['A','B']});
    expect((await call({accountNames:['B','A'],cursors:[...initial.cursors].reverse()})).accounts.map((a:any)=>a.accountId).sort()).toEqual(['a','b']);
  });
});
