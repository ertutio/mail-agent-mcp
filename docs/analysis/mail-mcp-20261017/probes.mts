// Archived analysis script: historical workspace layout required; not a product/CI entry.
// Analysis-only synthetic probes. No AccountManager instance, credentials, sockets or mailbox access.
import { createRequire } from 'node:module';
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { unifiedSearchTools } from '../../work/mail-agent-audit/src/tools/unified-search-tools.ts';
import { safeSendTools } from '../../work/mail-agent-audit/src/tools/safe-send-tools.ts';
import { ImapService } from '../../work/mail-agent-audit/src/services/imap-service.ts';
const repo = new URL('../../work/mail-agent-audit/', import.meta.url);
const require = createRequire(new URL('package.json', repo));
const {z}=require('zod');
const fixture = () => {
  const tools=new Map<string,any>();
  return {server:{registerTool:(n:string,c:any,h:any)=>tools.set(n,{c,h})},call:async(n:string,a:any)=>{
    const {c,h}=tools.get(n); const args=z.object(c.inputSchema).parse(a);
    return JSON.parse((await h(args)).content[0].text);
  }};
};
const accounts=[{id:'synthetic-a',name:'alpha'},{id:'synthetic-b',name:'beta'}];
const manager={getAllAccounts:()=>accounts,resolveAccountId:(_id:any,n:string)=>{
  const a=accounts.find(a=>a.name===n);if(!a)throw Error('missing synthetic account');return a.id;
}};
const results:any[]=[];
{
  const service:any=new ImapService();let selected='';let releaseStatus:()=>void;
  let enteredStatus:()=>void;const entered=new Promise<void>(r=>enteredStatus=r);
  const gate=new Promise<void>(r=>releaseStatus=r);let movedFrom='';let releases=0;
  const client={usable:true,getMailboxLock:async(folder:string)=>{selected=folder;return {release:()=>{releases++;}};},
    mailboxOpen:async(folder:string)=>{selected=folder;return {path:folder};},
    status:async()=>{enteredStatus();await gate;return {uidValidity:123};},
    messageMove:async()=>{movedFrom=selected;return {path:selected,destination:'Trash'};}};
  service.ensureConnected=async()=>client;service.resolveTrashFolder=async()=>'Trash';
  const deletion=service.bulkDelete('synthetic-a','INBOX',[7],50,undefined,123,false);
  await entered;await service.selectFolder('synthetic-a','Archive');releaseStatus!();
  const result=await deletion;
  results.push({id:'MAIL-01',observation:'unlocked-select-switches-folder-during-held-UID-operation',
    intendedFolder:'INBOX',actualCommandFolder:movedFrom,reportedDeleted:result.deleted,releases,
    scope:'deterministic in-memory IMAP state/lock model; zero server commands'});
}
{
  const f=fixture();let visited:string[]=[];
  const imap={listFolders:async()=>[{name:'INBOX',attributes:[]}],abortConnection:()=>{},
    searchEmailPage:async(id:string)=>{visited.push(id);return {messages:[],matched:0,nextCursor:{beforeUid:7,uidValidity:1}};}};
  unifiedSearchTools(f.server as any,imap as any,manager as any,{maxPagesPerFolder:1});
  const first=await f.call('imap_search_all_accounts',{accountNames:['alpha']});
  const cursor=first.cursors[0];visited=[];
  const next=await f.call('imap_search_all_accounts',{cursors:[{...cursor,accountName:'beta'}]});
  results.push({id:'N-02',observation:'cursor-account-name-rebinding-accepted',visited,
    accepted:next.accounts[0].accountId==='synthetic-b',sameFilterKey:cursor.filterKey===next.cursors[0].filterKey,
    scope:'synthetic handler with real Zod input validation; proves no identity binding, not unauthorized account access'});
}
{
  const f=fixture();
  unifiedSearchTools(f.server as any,{listFolders:async()=>{throw Error('synthetic discovery failure');},abortConnection:()=>{}} as any,manager as any);
  const out=await f.call('imap_search_all_accounts',{accountNames:['alpha']});
  results.push({id:'SA-04',observation:'discovery-failure-has-no-continuation',success:out.success,partial:out.partial,status:out.accounts[0].status,cursorCount:out.cursors.length});
}
{
  const f=fixture();let live:any={id:'synthetic-a',name:'alpha',user:'before@example.test',email:'before@example.test',saveToSent:false};let sent:any;
  const manager={resolveAccountId:()=>live.id,getAccount:()=>live};
  safeSendTools(f.server as any,{} as any,manager as any,{sendEmail:async(_id:any,account:any,composer:any)=>{
    sent={accountUser:account.user,composerFrom:composer.from};return {};
  }} as any);
  const p=await f.call('imap_preview_send_email',{to:'recipient@example.test',subject:'synthetic',text:'synthetic'});
  live={...live,user:'after@example.test',email:'after@example.test'};
  const out=await f.call('imap_confirm_send',{draftId:p.draftId,confirmed:true});
  results.push({id:'N-01',observation:'preview-identity-change-still-executes',status:out.status,
    identityMismatch:sent.accountUser!==sent.composerFrom,scope:'all sends mocked; zero SMTP/IMAP requests'});
}
{
  const service:any=new ImapService();let calls=0;
  service.ensureConnected=async()=>({append:async()=>{calls++;return false;}});
  const sent=await service.appendToSentFolder('synthetic-a',Buffer.from('synthetic'),'Sent');
  const draft=await service.appendMessage('synthetic-a','Drafts',Buffer.from('synthetic'));
  const version=JSON.parse(readFileSync(new URL('node_modules/imapflow/package.json',repo),'utf8')).version;
  results.push({id:'N-03',observation:'append-false-is-reported-success',sentSaved:sent.saved,draftSaved:draft,calls,imapflowVersion:version,
    scope:'mocked dependency return; reachability of false verified separately in locked dependency source'});
}
const files=['src/tools/unified-search-tools.ts','src/tools/safe-send-tools.ts','src/services/imap-service.ts'];
const hashes=files.map(file=>({file,sha256:createHash('sha256').update(readFileSync(new URL(file,repo))).digest('hex')}));
const out={observedAt:new Date().toISOString(),sourceCommit:'524e1b34c89ebe2834a27b948371227f142d346d',kind:'executed-synthetic-observation',
  meaning:'Observation success means the described gap is present, not that a future safety regression passes.',sourceHashes:hashes,results};
writeFileSync(new URL('./probe-results.json',import.meta.url),JSON.stringify(out,null,2)+'\n');
console.log(JSON.stringify(out));
