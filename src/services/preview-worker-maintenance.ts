import type {BackgroundProcess} from './preview-workers.ts';

/** Temporary process ownership for one data operation; never starts an already-stopped worker. */
export class PreviewWorkerMaintenance {
 private restoreWorkers:BackgroundProcess[]|null=null;
 private paused=false;
 constructor(private workers:BackgroundProcess[],private control:(action:'status'|'stop'|'start',workers:BackgroundProcess[])=>Promise<any>){}
 async status(){return this.control('status',this.workers);}
 async pause(){
  if(this.paused)return {paused:true,workers:this.restoreWorkers!.map(w=>w.name)};
  if(!this.restoreWorkers){
   const state=await this.status();
   const running=(state.workers||[]).filter((w:any)=>w.running);
   if(running.some((w:any)=>!w.environmentMatches))throw Error('Worker environment differs from selected preview; restart the prepared app before changing its data.');
   this.restoreWorkers=this.workers.filter(w=>running.some((r:any)=>r.name===w.name));
  }
  await this.control('stop',this.workers);
  this.paused=true;
  return {paused:true,workers:this.restoreWorkers.map(w=>w.name)};
 }
 async resume(){
  if(!this.restoreWorkers)return {resumed:[],message:'No workers paused by this operation'};
  const previous=this.restoreWorkers;
  if(previous.length)await this.control('start',previous);
  this.restoreWorkers=null;
  this.paused=false;
  return {resumed:previous.map(w=>w.name)};
 }
}
