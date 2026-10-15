import {open,stat} from 'node:fs/promises';
export const MAX_MESSAGE_BYTES=25*1024*1024;
export const MAX_BODY_CHARS=100000;
export const MAX_ATTACHMENT_COUNT=20;
export const boundedSource={start:0,maxLength:MAX_MESSAGE_BYTES+1};
export function assertMessageSize(source:Buffer,size?:number):void {
  if(source.length>MAX_MESSAGE_BYTES||(size!==undefined&&size>MAX_MESSAGE_BYTES)) throw new Error('Message exceeds the 25 MiB processing limit');
}
export async function readBoundedFile(path:string):Promise<Buffer>{
  const handle=await open(path,'r');
  try{
    const info=await handle.stat();
    if(!info.isFile()||info.size>MAX_MESSAGE_BYTES) throw new Error('Attachment exceeds the processing limit');
    const buffer=Buffer.alloc(info.size+1);let total=0;
    while(total<buffer.length){const {bytesRead}=await handle.read(buffer,total,buffer.length-total,total);if(!bytesRead)break;total+=bytesRead;}
    if(total>info.size)throw new Error('Attachment changed during preview; try again');
    return buffer.subarray(0,total);
  }finally{await handle.close();}
}
export async function materializeBoundedAttachments<T extends {content?:string|Buffer;path?:string}>(inputs:T[]):Promise<Array<T&{content:Buffer;path:undefined}>>{
  if(inputs.length>MAX_ATTACHMENT_COUNT) throw new Error('Too many attachments; maximum is 20');
  const sizes=await Promise.all(inputs.map(async a=>a.path?(await stat(a.path)).size:Buffer.isBuffer(a.content)?a.content.length:Math.ceil((a.content?.length??0)*3/4)));
  if(sizes.reduce((a,b)=>a+b,0)>MAX_MESSAGE_BYTES)throw new Error('Attachments exceed the aggregate 25 MiB limit');
  return Promise.all(inputs.map(async a=>({...a,path:undefined,content:a.path?await readBoundedFile(a.path):Buffer.isBuffer(a.content)?a.content:Buffer.from(a.content??'','base64')})));
}
