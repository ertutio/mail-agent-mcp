import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ImapService } from '../services/imap-service.js';

const DELETE_TOOLS = new Set(['imap_delete_email','imap_bulk_delete','imap_bulk_delete_by_search','imap_delete_spam','imap_delete_by_domain']);
interface Operation { accountId:string; folder:string; uids:number[]; chunkSize:number; uidValidity:number; permanent:boolean }
interface Preview { expiresAt:number; state:'pending'|'executing'|'finished'|'ambiguous'; operations:Operation[] }
interface Collection { operations:Array<Omit<Operation,'permanent'>>; versions:Map<string,number>; expectedValidity?:number }
const response = (value:unknown) => ({content:[{type:'text' as const,text:JSON.stringify(value,null,2)}]});

/** Legacy deletion handlers can select messages, but cannot mutate inside a preview. */
export function guardedDeletion(server:McpServer, imap:ImapService, clock:()=>number=Date.now) {
  const context = new AsyncLocalStorage<Collection>();
  const previews = new Map<string,Preview>();
  const capture = async(accountId:string,folder:string,uids:number[],chunkSize=50) => {
    if (!Number.isInteger(chunkSize)||chunkSize<1||chunkSize>1000) throw new Error('chunkSize must be an integer from 1 to 1000');
    if (!uids.every(uid=>Number.isInteger(uid)&&uid>0&&uid<=0xffffffff)) throw new Error('Invalid email UID');
    const collection = context.getStore();
    if (!collection) throw new Error('Deletion requires a guarded preview');
    const key=JSON.stringify([accountId,folder]);
    const status=await imap.getFolderStatus(accountId,folder);
    const expected=collection.versions.get(key)??collection.expectedValidity??status.uidValidity;
    if(status.uidValidity!==expected)throw new Error('Mailbox changed during deletion selection; create a new preview');
    collection.operations.push({accountId,folder,uids:[...new Set(uids)],chunkSize,uidValidity:expected});
  };
  const previewImap = new Proxy(imap,{get(target,prop){
    if(prop==='deleteEmail') return async(a:string,f:string,u:number)=>{await capture(a,f,[u]);};
    if(prop==='bulkDelete') return async(a:string,f:string,u:number[],c?:number)=>{await capture(a,f,u,c);return {deleted:0,failed:0,errors:[]};};
    if(prop==='searchEmails') return async(a:string,f:string,...args:any[])=>{
      const collection=context.getStore();
      if(!collection)return (imap.searchEmails as any)(a,f,...args);
      const before=await imap.getFolderStatus(a,f);
      const result=await (imap.searchEmails as any)(a,f,...args);
      const after=await imap.getFolderStatus(a,f);
      if(before.uidValidity!==after.uidValidity)throw new Error('Mailbox changed during deletion selection; create a new preview');
      collection.versions.set(JSON.stringify([a,f]),before.uidValidity);return result;
    };
    const value=Reflect.get(target,prop); return typeof value==='function'?value.bind(target):value;
  }});
  const prune = () => { for(const [id,p] of previews) if(p.state!=='executing'&&(p.expiresAt<=clock()||p.state==='finished')) previews.delete(id); };
  const previewServer = new Proxy(server,{get(target,prop){
    if(prop==='registerTool') return (name:string,config:any,handler:any)=> {
      if(!DELETE_TOOLS.has(name)) return (target.registerTool as any)(name,config,handler);
      return (target.registerTool as any)(name,{...config,annotations:{readOnlyHint:true,destructiveHint:false},inputSchema:{...config.inputSchema,uidValidity:z.number().int().positive().optional().describe('UIDVALIDITY from the earlier mailbox read, when deleting known UIDs')},description:'Preview deletion only: freeze selected UIDs and return samples. Nothing is deleted until imap_confirm_delete is called after explicit user approval. '+config.description},async(args:any)=>{
        prune(); if(previews.size>=100) throw new Error('Too many pending deletion previews');
        const collection:Collection={operations:[],versions:new Map(),expectedValidity:args.uidValidity};
        const oldResult=await context.run(collection,()=>handler({...args,dryRun:false}));
        const operations=collection.operations.filter(op=>op.uids.length);
        if(!operations.length) return oldResult;
        if(operations.reduce((sum,op)=>sum+op.uids.length,0)>5000) throw new Error('Deletion preview exceeds 5000 messages; narrow the selection');
        const frozen:Operation[]=[];
        for(const op of operations){
          const status=await imap.getFolderStatus(op.accountId,op.folder);
          if(!Number.isInteger(status.uidValidity)||status.uidValidity<=0) throw new Error('Cannot freeze deletion without UIDVALIDITY');
          if(status.uidValidity!==op.uidValidity)throw new Error('Mailbox changed during deletion selection; create a new preview');
          const trash=await imap.resolveTrashFolder(op.accountId);
          frozen.push({...op,uidValidity:status.uidValidity,permanent:op.folder===trash});
        }
        const previewId=randomUUID(); const expiresAt=clock()+300000;
        previews.set(previewId,{expiresAt,state:'pending',operations:frozen});
        const samples=[];
        if(typeof imap.fetchHeadersForUids==='function')for(const op of frozen){
          const headers=await imap.fetchHeadersForUids(op.accountId,op.folder,op.uids.slice(0,20));
          for(const [uid,h] of headers)samples.push({accountId:op.accountId,folder:op.folder,uid,subject:(h.subject??'').slice(0,1000),from:(h.from??'').slice(0,1000),date:(h.date??'').slice(0,100)});
        }
        return response({success:true,previewOnly:true,previewId,expiresAt,total:frozen.reduce((sum,op)=>sum+op.uids.length,0),operations:frozen,samples,message:'No mail changed. Review samples, account, folder, UIDs and permanent status, then explicitly approve imap_confirm_delete.'});
      });
    };
    const value=Reflect.get(target,prop);return typeof value==='function'?value.bind(target):value;
  }});
  server.registerTool('imap_confirm_delete',{
    description:'Execute a frozen deletion preview only after explicit user approval. Rejects expired or already used previews and changed UIDVALIDITY; no search is repeated.',
    inputSchema:{previewId:z.string().uuid(),confirmed:z.literal(true)},
    annotations:{readOnlyHint:false,destructiveHint:true},
  },async({previewId,confirmed})=>{
    if(confirmed!==true) throw new Error('Explicit deletion confirmation required');
    const preview=previews.get(previewId);
    if(!preview||preview.expiresAt<=clock()||preview.state!=='pending') throw new Error('Deletion preview expired, already used, or unknown');
    preview.state='executing';
    try{
      for(const op of preview.operations){
        const status=await imap.getFolderStatus(op.accountId,op.folder);
        if(status.uidValidity!==op.uidValidity) throw new Error('Mailbox UIDVALIDITY changed; create a new preview');
        if((op.folder===await imap.resolveTrashFolder(op.accountId))!==op.permanent) throw new Error('Trash mapping changed; create a new preview');
      }
      const results=[];
      for(const op of preview.operations) results.push(await imap.bulkDelete(op.accountId,op.folder,op.uids,op.chunkSize,undefined,op.uidValidity,op.permanent));
      preview.state='finished'; previews.delete(previewId);
      return response({success:results.every(r=>r.failed===0),results});
    }catch(error){preview.state='ambiguous';throw error;}
  });
  return {server:previewServer,imap:previewImap};
}
