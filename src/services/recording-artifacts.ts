import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
export type BrowserStep={label:string;action:string;status:string;target?:string;expected?:string;actual?:string;error?:string};
export type BrowserCheck={steps?:BrowserStep[];label:string;status:string;expected?:string;actual?:string;target?:string;error?:string};
export type ArtifactStore={put:(key:string,body:Buffer,type:string)=>Promise<void>;putFile?:(key:string,path:string,type:string)=>Promise<void>};
function storageError(message:string){const error=new Error('LFG recorder storage unavailable: '+message);error.name='RecordingStorageError';return error;}
async function configuredStore():Promise<ArtifactStore>{
 const storage=await import('./s3.ts');
 if(!storage.isS3Enabled)throw storageError('Feature recording requires configured S3/R2 object storage (FILE_STORAGE_TYPE=s3). Local permanent storage is disabled.');
 return {put:storage.uploadBinary,putFile:storage.uploadBinaryFile};
}
/** Local files exist only while encoding. All user-facing artifacts use object storage. */
export class RecordingArtifacts {
 appUrl?:string;
 attempt=1;
 checks:BrowserCheck[]=[];
 private timer?:ReturnType<typeof setInterval>;private pending=Promise.resolve();private uploading=false;private completed=false;
 private constructor(readonly dir:string,readonly url:string,private store:ArtifactStore){}
 static async create(ticketId:string,store?:ArtifactStore){
  store??=await configuredStore();
  const url=`/uploads/ticket-tests/${ticketId}/${crypto.randomUUID()}`;
  const artifacts=new RecordingArtifacts(await mkdtemp(tmpdir()+'/lfg-recording-'),url,store);
  try{await artifacts.state('working','Starting browser');}catch(e){await rm(artifacts.dir,{recursive:true,force:true});throw e;}
  artifacts.timer=setInterval(()=>{if(artifacts.uploading)return;artifacts.uploading=true;artifacts.pending=artifacts.frame().catch(()=>{}).finally(()=>{artifacts.uploading=false;});},1500);
  artifacts.timer.unref?.();return artifacts;
 }
 private async put(name:string,body:Buffer){
  let error;for(let attempt=0;attempt<3;attempt++){try{await this.store.put(this.url.slice('/uploads/'.length)+'/'+name,body,name.endsWith('.mp4')?'video/mp4':name.endsWith('.jpg')?'image/jpeg':'application/json');return;}catch(e){error=e;}}
  throw storageError('Recording upload failed: '+(error as Error).message);
 }
 private async frame(){const bytes=await readFile(this.dir+'/live.jpg').catch(()=>null);if(bytes)await this.put('live.jpg',bytes);}
 async state(status:string,step:string){await this.put('status.json',Buffer.from(JSON.stringify({status,attempt:this.attempt,step,appUrl:this.appUrl,checks:this.checks,updatedAt:Date.now()})));}
 async finish(status:string,step:string){
  if(this.completed)return;
  clearInterval(this.timer);await this.pending;
  try{
  // Publish the terminal status last: a completed status guarantees uploaded evidence.
  for(const file of await readdir(this.dir))if(/^(recording\.mp4|live\.jpg|failure\.jpg|step-\d+\.jpg)$/.test(file)){if(file==='recording.mp4' && this.store.putFile){let error;for(let attempt=0;attempt<3;attempt++){try{await this.store.putFile(this.url.slice('/uploads/'.length)+'/'+file,this.dir+'/'+file,'video/mp4');error=undefined;break;}catch(e){error=e;}}if(error)throw storageError('Recording upload failed: '+(error as Error).message);}else await this.put(file,await readFile(this.dir+'/'+file));}
  await this.state(status,step);await rm(this.dir,{recursive:true,force:true});this.completed=true;
  }catch(error){await this.state('failed','Recording evidence upload failed; temporary evidence retained for recovery. '+(error as Error).message).catch(()=>{});throw error;}
 }
 async abort(step:string){return this.finish('failed',step);}
}
