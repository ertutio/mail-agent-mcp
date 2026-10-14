import {describe,it,expect,vi} from 'vitest';
import {ImapService} from '../src/services/imap-service.js';
import {unifiedSearchTools} from '../src/tools/unified-search-tools.js';
describe('bounded resumable unified search',()=>{
  it('restricts server SEARCH to a 200-UID window and rejects changed validity',async()=>{
    const search=vi.fn(async()=>[999]);const client={mailbox:{uidNext:1001,uidValidity:123},getMailboxLock:async()=>({release(){}}),search,fetch:async function*(){yield {uid:999,internalDate:new Date('2026-10-01'),envelope:{subject:'fixture'},flags:[]};}};
    const service=new ImapService();vi.spyOn(service as any,'ensureConnected').mockResolvedValue(client);
    const result=await service.searchEmailPage('synthetic','INBOX',{});
    expect(search).toHaveBeenCalledWith(expect.objectContaining({uid:'801:1000'}),{uid:true});
    expect(result.nextCursor).toEqual({beforeUid:800,uidValidity:123});
    await expect(service.searchEmailPage('synthetic','INBOX',{}, {beforeUid:800,uidValidity:456})).rejects.toThrow(/UIDVALIDITY/);
    expect(search).toHaveBeenCalledOnce();
  });
  it('retains top results within a bound and resumes partial folders without changing filters',async()=>{
    let handler:any;const account={id:'synthetic',name:'fixture'};
    const imap={listFolders:vi.fn(async()=>[{name:'INBOX'}]),abortConnection:vi.fn(),searchEmailPage:vi.fn(async(_a:string,_f:string,_c:any,cursor:any)=>({messages:[{uid:cursor?1:2,date:new Date(cursor?'2026-10-05':'2026-10-01'),from:'a@example.test',to:[],subject:'fixture',flags:[]}],matched:1,...(!cursor?{nextCursor:{beforeUid:1,uidValidity:123}}:{})}))};
    unifiedSearchTools({registerTool:(_n:any,_c:any,h:any)=>handler=h} as any,imap as any,{getAllAccounts:()=>[account],resolveAccountId:()=>account.id} as any,{maxPagesPerFolder:1});
    const parse=(r:any)=>JSON.parse(r.content[0].text);
    const first=parse(await handler({limit:1,query:'fixture'}));
    expect(first.partial).toBe(true);expect(first.cursors).toHaveLength(1);expect(first.messages).toHaveLength(1);
    const next=parse(await handler({limit:1,query:'fixture',cursors:first.cursors}));
    expect(next.partial).toBe(false);expect(next.cursors).toHaveLength(0);expect(next.messages[0].uid).toBe(1);
    await expect(handler({query:'changed',cursors:first.cursors})).rejects.toThrow(/filters changed/);
    await expect(handler({query:'fixture',limit:2,cursors:first.cursors})).rejects.toThrow(/filters changed/);
  });
});
