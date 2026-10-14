import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
let active=0;
export async function extractPdfPreview(bytes:Buffer,maxChars:number):Promise<{text:string;truncated:boolean}>{
  if(bytes.length>256*1024||active>=2) throw new Error('PDF preview resource limit');
  active++;
  try{return await new Promise((resolve,reject)=>{
    const worker=new Worker(`const {parentPort,workerData}=require('node:worker_threads');(async()=>{const {PDFParse}=require(workerData.modulePath);const parser=new PDFParse({data:Buffer.from(workerData.bytes)});try{const result=await parser.getText({first:20,pageJoiner:''});parentPort.postMessage({text:result.text.slice(0,workerData.maxChars),truncated:result.text.length>workerData.maxChars||result.total>20});}finally{await parser.destroy();}})().catch(()=>parentPort.postMessage({error:true}));`,{eval:true,workerData:{bytes,maxChars,modulePath:require.resolve('pdf-parse')},resourceLimits:{maxOldGenerationSizeMb:128,maxYoungGenerationSizeMb:16,stackSizeMb:4}});
    let settled=false;
    const finish=(error?:Error,value?:any)=>{if(settled)return;settled=true;clearTimeout(timer);void worker.terminate();error?reject(error):resolve(value);};
    const timer=setTimeout(()=>finish(new Error('PDF preview timed out')),5000);
    worker.once('message',value=>value.error?finish(new Error('PDF preview failed')):finish(undefined,value));
    worker.once('error',()=>finish(new Error('PDF preview failed')));
    worker.once('exit',()=>{if(!settled)finish(new Error('PDF preview exited before completion'));});
  });}finally{active--;}
}
