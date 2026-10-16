import {describe,it,expect,vi} from 'vitest';
import {ImapService} from '../src/services/imap-service.js';
import {unifiedSearchTools} from '../src/tools/unified-search-tools.js';
describe('bounded resumable unified search',()=>{
  it('fetches at most 200 matching UID records and rejects changed validity',async()=>{
    const search=vi.fn(async()=>Array.from({length:201},(_,i)=>1000-i));const fetch=vi.fn(async function*(..._args:any[]){yield {uid:999,internalDate:new Date('2026-10-01'),envelope:{subject:'fixture'},flags:[]};});const client={mailbox:{uidNext:1001,uidValidity:123},getMailboxLock:async()=>({release(){}}),search,fetch};
    const service=new ImapService();vi.spyOn(service as any,'ensureConnected').mockResolvedValue(client);
    const result=await service.searchEmailPage('synthetic','INBOX',{});
    expect(search).toHaveBeenCalledWith(expect.objectContaining({uid:'1:1000'}),{uid:true});
    expect(fetch.mock.calls[0]?.[0]).toHaveLength(200);
    expect(result.nextCursor).toEqual({beforeUid:800,uidValidity:123});
    await expect(service.searchEmailPage('synthetic','INBOX',{}, {beforeUid:800,uidValidity:456})).rejects.toThrow(/UIDVALIDITY/);
    expect(search).toHaveBeenCalledOnce();
  });
  it('does not scan empty gaps between sparse high UID values',async()=>{
    const search=vi.fn(async()=>[3000000000,12345,2]);const client={mailbox:{uidNext:3000000001,uidValidity:123},getMailboxLock:async()=>({release(){}}),search,fetch:async function*(){for(const uid of [3000000000,12345,2])yield {uid,internalDate:new Date('2026-10-01'),envelope:{},flags:[]};}};
    const service=new ImapService();vi.spyOn(service as any,'ensureConnected').mockResolvedValue(client);
    const result=await service.searchEmailPage('synthetic','INBOX',{});expect(result.messages).toHaveLength(3);expect(result.nextCursor).toBeUndefined();expect(search).toHaveBeenCalledOnce();
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

function missingUidNextFixture(uids: number[], metadata: Record<string, any> = {}) {
  const release = vi.fn();
  const client = {
    mailbox: { uidValidity: 123, ...metadata } as Record<string, any>,
    status: vi.fn(async () => ({ uidValidity: 123 } as Record<string, any>)),
    getMailboxLock: vi.fn(async () => ({ release })),
    search: vi.fn(async (query: any) => {
      const upper = query.uid ? Number(query.uid.split(':')[1]) : 0xffffffff;
      return uids.filter(uid => uid <= upper);
    }),
    fetch: vi.fn(async function* (selected: number[]) {
      for (const uid of selected) yield {
        uid, internalDate: new Date('2026-10-01T12:00:00Z'),
        envelope: { subject: 'synthetic pagination fixture', from: [{ address: 'sender@example.test' }] }, flags: [],
      };
    }),
  };
  const service = new ImapService();
  vi.spyOn(service as any, 'ensureConnected').mockResolvedValue(client);
  return { service, client, release };
}

describe('pagination when SELECT and STATUS omit UIDNEXT (SA-08)', () => {
  it('pages through actual matching UIDs while preserving filters and the 200-record fetch cap', async () => {
    const ids = Array.from({ length: 405 }, (_, index) => (index + 1) * 7);
    const { service, client, release } = missingUidNextFixture(ids);
    const criteria = { since: new Date(2026, 8, 15), text: 'fixture' };
    const first = await service.searchEmailPage('synthetic', 'INBOX', criteria);
    expect(first.messages).toHaveLength(200);
    expect(first.nextCursor).toEqual({ beforeUid: ids[205]! - 1, uidValidity: 123 });
    expect(client.search).toHaveBeenCalledTimes(1);
    expect(client.search.mock.calls[0]?.[0]).toMatchObject({ since: criteria.since, text: 'fixture' });
    const second = await service.searchEmailPage('synthetic', 'INBOX', criteria, first.nextCursor);
    expect(second.messages).toHaveLength(200);
    expect(client.search.mock.calls[1]?.[0]).toMatchObject({ uid: `1:${first.nextCursor!.beforeUid}`, text: 'fixture' });
    const third = await service.searchEmailPage('synthetic', 'INBOX', criteria, second.nextCursor);
    expect(third.messages).toHaveLength(5);
    expect(third.nextCursor).toBeUndefined();
    const returned = [...first.messages, ...second.messages, ...third.messages].map(message => message.uid);
    expect(returned).toEqual([...ids].reverse());
    expect(new Set(returned).size).toBe(405);
    expect(client.fetch.mock.calls.every(call => call[0].length <= 200)).toBe(true);
    expect(release).toHaveBeenCalledTimes(3);
  });

  it('handles an empty mailbox without inventing UIDNEXT or fetching bodies', async () => {
    const { service, client, release } = missingUidNextFixture([]);
    expect(await service.searchEmailPage('synthetic', 'INBOX', {})).toEqual({ messages: [], matched: 0 });
    expect(client.fetch).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('handles sparse high UIDs in one search rather than traversing empty UID gaps', async () => {
    const { service, client } = missingUidNextFixture([2, 12345, 3000000000]);
    const result = await service.searchEmailPage('synthetic', 'INBOX', {});
    expect(result.messages.map(message => message.uid)).toEqual([3000000000, 12345, 2]);
    expect(result.nextCursor).toBeUndefined();
    expect(client.search).toHaveBeenCalledOnce();
  });

  it('keeps valid SELECT UIDVALIDITY when STATUS does not repeat it', async () => {
    const { service, client } = missingUidNextFixture([1]);
    client.status.mockResolvedValue({});
    expect((await service.searchEmailPage('synthetic', 'INBOX', {})).messages[0]?.uid).toBe(1);
  });

  it('uses STATUS validity when SELECT does not provide it', async () => {
    const { service } = missingUidNextFixture([1], { uidValidity: undefined });
    expect((await service.searchEmailPage('synthetic', 'INBOX', {})).messages[0]?.uid).toBe(1);
  });

  it('rejects conflicting SELECT/STATUS validity instead of assigning UIDs to the wrong mailbox incarnation', async () => {
    const { service, client, release } = missingUidNextFixture([1]);
    client.status.mockResolvedValue({ uidValidity: 456 });
    await expect(service.searchEmailPage('synthetic', 'INBOX', {})).rejects.toThrow(/UIDVALIDITY changed/);
    expect(client.search).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('can use STATUS UIDNEXT when SELECT omits it', async () => {
    const { service, client } = missingUidNextFixture([2]);
    client.status.mockResolvedValue({ uidNext: 3, uidValidity: 123 });
    expect((await service.searchEmailPage('synthetic', 'INBOX', {})).messages[0]?.uid).toBe(2);
    expect(client.search).toHaveBeenCalledWith(expect.objectContaining({ uid: '1:2' }), { uid: true });
  });

  it('still rejects missing UIDVALIDITY and releases the lock before issuing a search', async () => {
    const { service, client, release } = missingUidNextFixture([1], { uidValidity: undefined });
    client.status.mockResolvedValue({});
    await expect(service.searchEmailPage('synthetic', 'INBOX', {})).rejects.toThrow(/pagination metadata/);
    expect(client.search).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('rejects stale continuation validity even without UIDNEXT', async () => {
    const { service, client, release } = missingUidNextFixture([1]);
    await expect(service.searchEmailPage('synthetic', 'INBOX', {}, { beforeUid: 10, uidValidity: 456 })).rejects.toThrow(/UIDVALIDITY changed/);
    expect(client.search).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([0, -1, 1.5, NaN, 0x100000000])('rejects an invalid returned UID: %s', async invalidUid => {
    const { service, client, release } = missingUidNextFixture([]);
    client.search.mockResolvedValue([invalidUid]);
    await expect(service.searchEmailPage('synthetic', 'INBOX', {})).rejects.toThrow(/bounded UID search/);
    expect(client.fetch).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('retains the candidate processing cap and does not fetch oversized search results', async () => {
    const { service, client, release } = missingUidNextFixture([]);
    client.search.mockResolvedValue(Array.from({ length: 100001 }, (_, index) => index + 1));
    await expect(service.searchEmailPage('synthetic', 'INBOX', {})).rejects.toThrow(/processing limit/);
    expect(client.fetch).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('does not accept a server UID outside the continuation upper bound', async () => {
    const { service, client, release } = missingUidNextFixture([]);
    client.search.mockResolvedValue([11]);
    await expect(service.searchEmailPage('synthetic', 'INBOX', {}, { beforeUid: 10, uidValidity: 123 })).rejects.toThrow(/bounded UID search/);
    expect(client.fetch).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('releases the mailbox lock when SEARCH fails', async () => {
    const { service, client, release } = missingUidNextFixture([]);
    client.search.mockRejectedValue(new Error('synthetic search failure'));
    await expect(service.searchEmailPage('synthetic', 'INBOX', {})).rejects.toThrow('synthetic search failure');
    expect(release).toHaveBeenCalledOnce();
  });

  it('recovers NetEase-like accounts through the actual global-search pagination and cursor chain', async () => {
    const first = missingUidNextFixture(Array.from({ length: 205 }, (_, i) => (i + 1) * 11));
    const second = missingUidNextFixture([2, 101, 3000000000]);
    const service = new ImapService();
    const clients = new Map([['netease-163', first.client], ['netease-126', second.client]]);
    vi.spyOn(service as any, 'ensureConnected').mockImplementation(async (id: string) => clients.get(id));
    vi.spyOn(service, 'listFolders').mockResolvedValue([{ name: 'INBOX', attributes: [], delimiter: '/' }]);
    const accounts = [...clients.keys()].map(id => ({ id, name: id }));
    const manager = {
      getAllAccounts: () => accounts,
      resolveAccountId: (_id: string | undefined, name: string) => accounts.find(account => account.name === name)!.id,
    };
    let handler: any;
    unifiedSearchTools({ registerTool: (_name: string, _schema: unknown, call: any) => { handler = call; } } as any, service, manager as any,
      { maxPagesPerFolder: 1, accountTimeoutMs: 2000, overallTimeoutMs: 4000 });
    const args = { query: 'fixture', since: '2026-09-15', limit: 200 };
    const initial = JSON.parse((await handler(args)).content[0].text);
    expect(initial.success).toBe(true);
    expect(initial.partial).toBe(true);
    expect(initial.totalFound).toBe(203);
    expect(initial.messages.some((message: any) => message.accountId === 'netease-126')).toBe(true);
    expect(initial.messages.some((message: any) => message.accountId === 'netease-163')).toBe(true);
    expect(initial.accounts.find((account: any) => account.accountId === 'netease-126').status).toBe('ok');
    expect(initial.cursors).toHaveLength(1);
    const continued = JSON.parse((await handler({ ...args, cursors: initial.cursors })).content[0].text);
    expect(continued.success).toBe(true);
    expect(continued.partial).toBe(false);
    expect(continued.totalFound).toBe(5);
    expect(continued.cursors).toEqual([]);
    expect(continued.accounts.map((account: any) => account.accountId)).toEqual(['netease-163']);
    expect(first.client.fetch.mock.calls.every(call => call[0].length <= 200)).toBe(true);
  });
});
