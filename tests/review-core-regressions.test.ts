import {describe,it,expect,vi,beforeEach} from 'vitest';
import {ImapService} from '../src/services/imap-service.js';
import {unifiedSearchTools} from '../src/tools/unified-search-tools.js';
import {accountRevision} from '../src/utils/account-revision.js';
const {clients}=vi.hoisted(()=>({clients:[] as any[]}));
vi.mock('imapflow',()=>({ImapFlow:class{
  usable=true; capabilities=new Set(['MOVE','UIDPLUS']); mailbox={uidValidity:1};
  connect=vi.fn().mockResolvedValue(undefined);close=vi.fn();logout=vi.fn().mockResolvedValue(undefined);
  list=vi.fn().mockResolvedValue([{path:'INBOX',flags:[]}]);on=vi.fn();
  getMailboxLock=vi.fn().mockResolvedValue({release:vi.fn()});
  search=vi.fn();messageMove=vi.fn();messageDelete=vi.fn();append=vi.fn().mockResolvedValue({uid:1});
  constructor(public options:any){clients.push(this);}
}}));
const SYNTHETIC_PASSWORD=['fixture','only'].join('-');
const NEW_SYNTHETIC_PASSWORD=['new','fixture'].join('-');
const account={id:'synthetic',name:'Synthetic',host:'imap.example.test',port:993,user:'a@example.test',password:SYNTHETIC_PASSWORD,tls:true};
function deferred<T=void>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
describe('review core regression gates',()=>{
  beforeEach(()=>clients.splice(0));
  it('flattens structured To, Cc, and multiple Reply-To mailboxes without splitting quoted names',async()=>{
    const source=Buffer.from('From: "Sender, One" <sender@example.test>\r\nTo: "Last, First" <one@example.test>, Group: two@example.test, three@example.test;\r\nCc: cc@example.test, "Other, Person" <other@example.test>\r\nReply-To: reply1@example.test, "Reply, Two" <reply2@example.test>\r\nSubject: Synthetic\r\n\r\nFixture');
    const content=await (new ImapService() as any).buildEmailContentFromSource(1,source,[]);
    expect(content.to).toEqual(['one@example.test','two@example.test','three@example.test']);expect(content.cc).toEqual(['cc@example.test','other@example.test']);
    expect(content.fromAddresses).toEqual(['sender@example.test']);expect(content.replyTo).toEqual(['reply1@example.test','reply2@example.test']);
  });
  it('aborting an authentication attempt permits a later retry and rejects its late completion',async()=>{
    const auth=deferred<any>();const resolver={resolve:vi.fn().mockReturnValueOnce(auth.promise).mockResolvedValue({kind:'password',user:account.user,password:account.password})};
    const service=new ImapService(resolver as any);const old=service.connect(account);const rejected=expect(old).rejects.toThrow(/abort|supersed/i);
    service.abortConnection(account.id);const retry=service.connect(account);auth.resolve({kind:'password',user:account.user,password:account.password});
    await rejected;await expect(retry).resolves.toBeUndefined();expect(clients).toHaveLength(1);
  });
  it('permits explicit temporary connection checks without treating absent configured identity as removal',async()=>{
    const service=new ImapService();service.setAccountManager({getAccount:()=>undefined} as any);
    await expect(service.connect({...account,id:'test-unique'})).resolves.toBeUndefined();
    await expect(service.listFolders('test-unique')).resolves.toHaveLength(1);
  });
  it('a new revision does not join or relabel an old pending authentication',async()=>{
    const auth=deferred<any>();let current={...account};
    const resolver={resolve:vi.fn().mockReturnValueOnce(auth.promise).mockResolvedValue({kind:'password',user:account.user,password:NEW_SYNTHETIC_PASSWORD})};
    const service=new ImapService(resolver as any);service.setAccountManager({getAccount:()=>({...current})} as any);
    const old=service.connect(account);const rejected=expect(old).rejects.toThrow(/abort|supersed|changed/i);
    current={...account,host:'imap.changed.example.test'};const fresh=service.listFolders(account.id);
    auth.resolve({kind:'password',user:account.user,password:account.password});await rejected;await fresh;
    expect(clients).toHaveLength(1);expect(clients[0].options.host).toBe('imap.changed.example.test');
  });
  it('Sent timeout does not abort a shared auth or append after its caller expires',async()=>{
    const auth=deferred<any>();const service=new ImapService({resolve:()=>auth.promise} as any);
    service.setAccountManager({getAccount:()=>account} as any);
    const other=service.listFolders(account.id);const expired=await service.appendToSentFolder(account.id,'synthetic','Sent',5);
    expect(expired.errorCategory).toBe('timeout');auth.resolve({kind:'password',user:account.user,password:account.password});
    await expect(other).resolves.toHaveLength(1);await new Promise(r=>setTimeout(r,5));expect(clients[0].append).not.toHaveBeenCalled();expect(clients[0].close).not.toHaveBeenCalled();
  });
  it('does not append an accepted message into a new identity after awaited Sent discovery',async()=>{
    let current={...account};const service=new ImapService();service.setAccountManager({getAccount:()=>current} as any);await service.connect(account);
    const discovery=deferred<string>();vi.spyOn(service,'findSpecialUseFolder').mockReturnValue(discovery.promise);
    const saving=service.appendToSentFolder(account.id,'synthetic',undefined,500,accountRevision(account));
    current={...account,host:'imap.changed.example.test'};discovery.resolve('Sent');
    expect((await saving).saved).toBe(false);expect(clients.every(client=>client.append.mock.calls.length===0)).toBe(true);
  });
  it('unified timeout keeps a shared cached connection alive and rejects empty dates before I/O',async()=>{
    let handler:any;const imap={listFolders:vi.fn().mockResolvedValue([{name:'INBOX',attributes:[]}]),searchEmailPage:vi.fn(()=>new Promise(()=>{})),abortConnection:vi.fn()};
    unifiedSearchTools({registerTool:(_n:any,_s:any,h:any)=>handler=h} as any,imap as any,{getAllAccounts:()=>[account]} as any,{accountTimeoutMs:5});
    await expect(handler({since:''})).rejects.toThrow(/date/i);expect(imap.listFolders).not.toHaveBeenCalled();
    const result=JSON.parse((await handler({})).content[0].text);expect(result.accounts[0].status).toBe('timeout');expect(imap.abortConnection).not.toHaveBeenCalled();
  });
  it('a timed out unified consumer leaves a real cached connection usable and stops its later pages',async()=>{
    const service=new ImapService();await service.connect(account);const page=deferred<any>();
    const search=vi.spyOn(service,'searchEmailPage').mockReturnValue(page.promise);let handler:any;
    unifiedSearchTools({registerTool:(_n:any,_s:any,h:any)=>handler=h} as any,service,{getAllAccounts:()=>[account]} as any,{accountTimeoutMs:5});
    const result=await handler({});expect(JSON.parse(result.content[0].text).accounts[0].status).toBe('timeout');
    await expect(service.listFolders(account.id)).resolves.toHaveLength(1);expect(clients).toHaveLength(1);expect(clients[0].close).not.toHaveBeenCalled();
    page.resolve({messages:[],matched:0,nextCursor:{beforeUid:3,uidValidity:1}});await new Promise(r=>setTimeout(r,5));expect(search).toHaveBeenCalledTimes(1);
  });
  it('counts only target UIDs in COPYUID and observes no-map deletion without counting missing UIDs',async()=>{
    const service=new ImapService();await service.connect(account);const client=clients[0];
    vi.spyOn(service as any,'resolveTrashFolder').mockResolvedValue('Trash');
    client.messageMove.mockResolvedValueOnce({uidMap:new Map([[1,101],[999,9999]])});
    client.search.mockResolvedValueOnce([1,2]);
    const mapped=await service.bulkDelete(account.id,'INBOX',[1,2],10);expect(mapped.deleted).toBe(1);expect(mapped.failed).toBe(1);
    client.messageMove.mockResolvedValueOnce({path:'INBOX',destination:'Trash'});client.search.mockResolvedValueOnce([1,2]).mockResolvedValueOnce([2]);
    const observed=await service.bulkDelete(account.id,'INBOX',[1,2,3],10);expect(observed.deleted).toBe(1);expect(observed.failed).toBe(2);
  });
  it('does not count a successful EXPUNGE command as every requested UID being deleted',async()=>{
    const service=new ImapService();await service.connect(account);const client=clients[0];
    vi.spyOn(service as any,'resolveTrashFolder').mockResolvedValue('Trash');client.messageDelete.mockResolvedValue(true);
    client.search.mockResolvedValueOnce([1,2]).mockResolvedValueOnce([2]);
    const result=await service.bulkDelete(account.id,'Trash',[1,2,3],10);expect(result.deleted).toBe(1);expect(result.failed).toBe(2);
  });
  it('does not mutate a new identity after waiting for a mailbox lock with the same UIDVALIDITY',async()=>{
    let current={...account};const service=new ImapService();service.setAccountManager({getAccount:()=>current} as any);await service.connect(account);
    const client=clients[0];vi.spyOn(service as any,'resolveTrashFolder').mockResolvedValue('Trash');
    client.getMailboxLock.mockImplementation(async()=>{current={...account,host:'imap.changed.example.test'};return {release:vi.fn()};});client.status=vi.fn().mockResolvedValue({uidValidity:1});
    client.messageMove.mockResolvedValue({uidMap:new Map([[1,2]])});client.search.mockResolvedValue([1]);
    const result=await service.bulkDelete(account.id,'INBOX',[1],10,undefined,1,false,accountRevision(account));
    expect(result.deleted).toBe(0);expect(client.messageMove).not.toHaveBeenCalled();
  });
});
