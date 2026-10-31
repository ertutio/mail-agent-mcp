import { beforeEach,describe,it,expect,vi } from 'vitest';
import { guardedDeletion } from '../src/tools/guarded-delete-tools.js';
import { emailTools } from '../src/tools/email-tools.js';
import { spamTools } from '../src/tools/spam-tools.js';
import { ImapService } from '../src/services/imap-service.js';
describe('frozen deletion and batch validation',()=>{
  let handlers:Map<string,any>; let imap:any; let now:number;
  const parse=(r:any)=>JSON.parse(r.content[0].text);
  beforeEach(()=>{
    now=0; handlers=new Map();
    imap={searchEmails:vi.fn(async()=>[{uid:7,from:'sender@example.test',subject:'fixture'}]),bulkDelete:vi.fn(async()=>({deleted:1,failed:0,errors:[]})),deleteEmail:vi.fn(),getFolderStatus:vi.fn(async()=>({uidValidity:123})),resolveTrashFolder:vi.fn(async()=>'Trash'),getAccountRevision:vi.fn(async()=>'synthetic-rev-0')};
    const server={registerTool:(n:string,_c:any,h:any)=>handlers.set(n,h)};
    const guarded=guardedDeletion(server as any,imap,()=>now);
    emailTools(guarded.server,guarded.imap,{resolveAccountId:()=> 'synthetic'} as any,{} as any);
    spamTools(guarded.server,guarded.imap,{checkEmails:()=>({spam:[{uid:7,confidence:'high'}]})} as any);
  });
  it.each(['imap_delete_email','imap_bulk_delete','imap_bulk_delete_by_search','imap_delete_spam','imap_delete_by_domain'])('%s never deletes without a frozen confirmation',async name=>{
    const r=parse(await handlers.get(name)({accountId:'synthetic',folder:'INBOX',uid:7,uids:[7],chunkSize:50,from:'sender@example.test',domain:'example.test',limit:50,minConfidence:'high',dryRun:false}));
    expect(r.previewOnly).toBe(true); expect(r.operations[0].uids).toEqual([7]);
    expect(imap.bulkDelete).not.toHaveBeenCalled(); expect(imap.deleteEmail).not.toHaveBeenCalled();
    await handlers.get('imap_confirm_delete')({previewId:r.previewId,confirmed:true});
    expect(imap.bulkDelete).toHaveBeenCalledExactlyOnceWith('synthetic','INBOX',[7],50,undefined,123,false,'synthetic-rev-0');
    await expect(handlers.get('imap_confirm_delete')({previewId:r.previewId,confirmed:true})).rejects.toThrow(/used|unknown/i);
  });
  it('freezes matching UIDs and reports permanent Trash deletion',async()=>{
    const r=parse(await handlers.get('imap_bulk_delete_by_search')({accountId:'synthetic',folder:'Trash',from:'sender@example.test',chunkSize:50,dryRun:true}));
    expect(r.operations[0].permanent).toBe(true);
    imap.searchEmails.mockResolvedValue([{uid:99}]);
    await handlers.get('imap_confirm_delete')({previewId:r.previewId,confirmed:true});
    expect(imap.bulkDelete).toHaveBeenCalledWith('synthetic','Trash',[7],50,undefined,123,true,'synthetic-rev-0');expect(imap.searchEmails).toHaveBeenCalledOnce();
  });
  it('rejects UIDVALIDITY changes before deletion',async()=>{
    const r=parse(await handlers.get('imap_delete_email')({accountId:'synthetic',folder:'INBOX',uid:7}));
    imap.getFolderStatus.mockResolvedValue({uidValidity:456});
    await expect(handlers.get('imap_confirm_delete')({previewId:r.previewId,confirmed:true})).rejects.toThrow(/UIDVALIDITY/);
    expect(imap.bulkDelete).not.toHaveBeenCalled();
  });
  it('rejects expired or unconfirmed previews',async()=>{
    const r=parse(await handlers.get('imap_delete_email')({accountId:'synthetic',folder:'INBOX',uid:7}));
    await expect(handlers.get('imap_confirm_delete')({previewId:r.previewId,confirmed:false})).rejects.toThrow(/confirmation/);
    now=300001;
    await expect(handlers.get('imap_confirm_delete')({previewId:r.previewId,confirmed:true})).rejects.toThrow(/expired/);
    expect(imap.bulkDelete).not.toHaveBeenCalled();
  });
  it('rejects UID reuse during selection and a stale known-UID preview',async()=>{
    imap.getFolderStatus.mockResolvedValueOnce({uidValidity:123}).mockResolvedValueOnce({uidValidity:456});
    await expect(handlers.get('imap_bulk_delete_by_search')({accountId:'synthetic',folder:'INBOX',from:'sender@example.test',chunkSize:50})).rejects.toThrow(/Mailbox changed/);
    await expect(handlers.get('imap_delete_email')({accountId:'synthetic',folder:'INBOX',uid:7,uidValidity:456})).rejects.toThrow(/Mailbox changed/);
    expect(imap.bulkDelete).not.toHaveBeenCalled();
  });
  it.each([0,-1,0.5,1001])('rejects chunkSize=%s before connecting',async size=>{
    const service=new ImapService(); const connect=vi.spyOn(service as any,'ensureConnected');
    await expect(service.bulkDelete('synthetic','INBOX',[7],size)).rejects.toThrow(/chunkSize/);
    expect(connect).not.toHaveBeenCalled();
  });
  it('stops remaining batches if validity changes after reconnection',async()=>{
    const move=vi.fn();const client={capabilities:new Map([['MOVE',true]]),getMailboxLock:async()=>({release(){}}),status:async()=>({uidValidity:456}),messageMove:move};
    const service=new ImapService();vi.spyOn(service as any,'ensureConnected').mockResolvedValue(client);vi.spyOn(service,'resolveTrashFolder').mockResolvedValue('Trash');
    const result=await service.bulkDelete('synthetic','INBOX',[7,8],1,undefined,123);
    expect(result.failed).toBe(2);expect(result.deleted).toBe(0);expect(move).not.toHaveBeenCalled();
  });
  it('does not turn a previewed Trash move into permanent deletion',async()=>{
    const remove=vi.fn();const service=new ImapService();vi.spyOn(service as any,'ensureConnected').mockResolvedValue({messageDelete:remove});vi.spyOn(service,'resolveTrashFolder').mockResolvedValue('INBOX');
    await expect(service.bulkDelete('synthetic','INBOX',[7],50,undefined,123,false)).rejects.toThrow(/Trash mapping changed/);
    expect(remove).not.toHaveBeenCalled();
  });
});

// T37 / MAIL-07: the IMAP FROM search is a substring match, so the raw
// candidate list contains look-alike domains (user@example.test.evil.net)
// and quoted display names that merely contain the domain text. Only
// addresses whose parsed domain equals the requested domain may be frozen
// into the deletion set — both in the preview and at confirm time.
describe('T37: delete-by-domain freezes an exact-domain candidate set',()=>{
  let handlers:Map<string,any>; let imap:any;
  const parse=(r:any)=>JSON.parse(r.content[0].text);
  beforeEach(()=>{
    handlers=new Map();
    imap={
      searchEmails:vi.fn(async()=>[
        {uid:1,from:'a@example.test'},
        {uid:2,from:'a@example.test.evil.net'},
        {uid:3,from:'"x@example.test" <x@other.test>'},
        {uid:4,from:'Friend <f@example.test>'},
      ]),
      bulkDelete:vi.fn(async()=>({deleted:2,failed:0,errors:[]})),
      deleteEmail:vi.fn(),
      getFolderStatus:vi.fn(async()=>({uidValidity:123})),
      resolveTrashFolder:vi.fn(async()=>'Trash'),
      fetchHeadersForUids:vi.fn(async()=>new Map()),
      getAccountRevision:vi.fn(async()=>'synthetic-rev-0'),
    };
    const server={registerTool:(n:string,_c:any,h:any)=>handlers.set(n,h)};
    const guarded=guardedDeletion(server as any,imap,()=>0);
    emailTools(guarded.server,guarded.imap,{resolveAccountId:()=> 'synthetic'} as any,{} as any);
    spamTools(guarded.server,guarded.imap,{checkEmails:()=>({spam:[]})} as any);
  });

  it('T37-EXACT-SET: the preview freezes only exact-domain matches',async()=>{
    const r=parse(await handlers.get('imap_delete_by_domain')({accountId:'synthetic',folder:'INBOX',domain:'example.test',dryRun:false}));
    expect(r.operations[0].uids).toEqual([1,4]);
    expect(r.total).toBe(2);
  });

  it('T37-FROZEN-CONFIRM: confirmation deletes exactly the frozen set, no re-search',async()=>{
    const r=parse(await handlers.get('imap_delete_by_domain')({accountId:'synthetic',folder:'INBOX',domain:'example.test',dryRun:false}));
    await handlers.get('imap_confirm_delete')({previewId:r.previewId,confirmed:true});
    expect(imap.bulkDelete).toHaveBeenCalledExactlyOnceWith('synthetic','INBOX',[1,4],50,undefined,123,false,'synthetic-rev-0');
    expect(imap.searchEmails).toHaveBeenCalledOnce();
  });

  it('T37R-DECOY-DISPLAY-NAME: a decoy inside the display name never wins', async () => {
    imap.searchEmails.mockResolvedValue([
      {uid:1,from:'"Bob <decoy@example.test>" <real@other.test>'},
      {uid:2,from:'Plain <plain@sub.example.test>'},
      {uid:3,from:'Exact <exact@example.test>'},
    ]);
    const r=parse(await handlers.get('imap_delete_by_domain')({accountId:'synthetic',folder:'INBOX',domain:'example.test',dryRun:false}));
    expect(r.operations[0].uids).toEqual([3]);
    expect(r.total).toBe(1);
  });
});
