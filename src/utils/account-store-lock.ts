import {promises as fs} from 'fs';
import {join} from 'node:path';

export async function withAccountStoreLock<T>(directory:string,action:()=>Promise<T>):Promise<T>{
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  const lock=join(directory,'.accounts.lock'); const deadline=Date.now()+5000;
  let handle;
  while(!handle){
    try{handle=await fs.open(lock,'wx',0o600);}
    catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      if(Date.now()>=deadline)throw new Error('Account store is locked. Wait for the other configuration process; after an abnormal exit, verify no writer remains before removing .accounts.lock.');
      await new Promise(r=>setTimeout(r,25));
    }
  }
  try{await handle.writeFile(JSON.stringify({pid:process.pid}));return await action();}
  finally{await handle.close();await fs.unlink(lock);}
}
