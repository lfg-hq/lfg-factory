import {StringDecoder} from 'node:string_decoder';
import {shellQuote as q} from './preview-plan.ts';
import {piTerminationScript} from './pi-termination.ts';

export type RpcProcess={outputFile:string;backgroundPid?:string};
export type RpcDependencies={
 start:()=>Promise<RpcProcess>;
 exec:(script:string)=>Promise<{exitCode:number;output:string}>;
 wait:()=>Promise<void>;
 now:()=>number;
 cancelled?:()=>boolean;
 log?:(message:string)=>void;
 browser?:(input:any)=>Promise<any>;
 browserReplyDir?:string;
 preparationReady?:()=>boolean;
};

export class PiSessionInfrastructureError extends Error {
 constructor(message:string){super(message);this.name='PiSessionInfrastructureError';}
}

/** One live Pi process, one persisted session, one budget across verification feedback. */
export class PiRepairSession {
 private process?:RpcProcess;
 private offset=0;
 private pending='';
 private decoder=new StringDecoder('utf8');
 private restarts=0;
 private asking=false;
 private uncertain=false;
 constructor(private fifo:string,private deadline:number,private d:RpcDependencies){}
 private guard(){if(this.d.cancelled?.())throw new Error('Ticket run cancelled');if(this.d.now()>=this.deadline)throw new Error('Ticket repair reached its configured session deadline');}
 async close(){
  if(!this.process)return;
  if(!this.process.backgroundPid)throw new Error('Could not confirm Pi process cleanup: launcher PID missing');
  const r=await this.d.exec(piTerminationScript(this.process.backgroundPid));
  if(r.exitCode!==0)throw new Error('Could not confirm Pi process cleanup');
  this.process=undefined;this.uncertain=false;
 }
 async ask(message:string):Promise<string>{
  if(this.asking || this.uncertain)throw new PiSessionInfrastructureError('Validation connection is busy or uncertain. No additional repair request was sent.');
  this.asking=true;
  try{return await this.turn(message);}catch(error){this.uncertain=true;throw error;}finally{this.asking=false;}
 }
 private async poll():Promise<{offset:number;chunk:string;alive:boolean}>{
  // Reading the same offset is safe to retry. Never resend a prompt on a read timeout.
  for(let attempt=0;attempt<3;attempt++){
   this.guard();
   try{
    const r=await this.d.exec(rpcPollScript(this.process!,this.offset));
    if(r.exitCode!==0)throw new Error('Agent output could not be read');
    const state=JSON.parse(r.output);
    if(!Number.isSafeInteger(state.offset)||state.offset<this.offset||typeof state.chunk!=='string'||typeof state.alive!=='boolean')throw new Error('Invalid agent output response');
    return state;
   }catch(error){
    if(attempt===2)throw new PiSessionInfrastructureError('Validation connection interrupted: could not read the existing agent after three attempts. This is a controller connection problem, not a failed feature check. Saved work is retained; no additional repair request was sent.');
    this.d.log?.('Reconnecting to the existing validation agent; waiting for its current work.');
    await this.d.wait();
   }
  }
  throw new PiSessionInfrastructureError('Validation connection interrupted');
 }
 private async turn(message:string):Promise<string>{
  this.guard();
  if(!this.process){this.process=await this.d.start();this.offset=0;this.pending='';this.decoder=new StringDecoder('utf8');}
  const id=crypto.randomUUID();
  const payload=Buffer.from(JSON.stringify({id,type:'prompt',message})+'\n').toString('base64');
  let sent=false;
  while(!sent){
   this.guard();
   let r;
   try{r=await this.d.exec(`python3 - ${q(this.fifo)} ${q(payload)} <<'PY'
import os,sys,base64,errno
try:
 fd=os.open(sys.argv[1],os.O_WRONLY|os.O_NONBLOCK)
 data=base64.b64decode(sys.argv[2]);os.set_blocking(fd,True)
 while data: data=data[os.write(fd,data):]
 os.close(fd)
except OSError as e:
 sys.exit(75 if e.errno in (errno.ENXIO,errno.ENOENT) else 1)
PY`);}catch{throw new PiSessionInfrastructureError('Validation request delivery could not be confirmed. The agent may still be working; no duplicate request was sent.');}
   if(r.exitCode===0)sent=true;
   else if(r.exitCode!==75)throw new PiSessionInfrastructureError('Validation request delivery could not be confirmed; no duplicate request was sent.');
   else {
    const state=await this.poll();
    if(!state.alive){
     if(this.restarts++>=2)throw new Error('Pi process exited repeatedly before accepting feedback');
     await this.close();return this.turn(message);
    }
    await this.d.wait();
   }
  }
  let answer='';let error='';let lastProgress=this.d.now();let lastActivity=this.d.now();let current='Waiting for agent response';let lastLabel='';const preparationStarted=this.d.now();
  while(true){
   this.guard();
   if(this.d.preparationReady && !this.d.preparationReady() && this.d.now()-preparationStarted>=120000){await this.close();throw new Error('Feature preparation stalled: no browser started or API/schema applicability decision after two minutes.');}
   const state=await this.poll();
   this.offset=state.offset;
   this.pending+=this.decoder.write(Buffer.from(state.chunk,'base64'));
   const lines=this.pending.split('\n');this.pending=lines.pop()!;
   for(const line of lines){
    let event:any;try{event=JSON.parse(line);}catch{continue;}
    if(['tool_execution_start','tool_execution_end','message_update','message_end','lfg_browser_request'].includes(event.type))lastActivity=this.d.now();
    if(event.type==='lfg_browser_request' && this.d.browser && this.d.browserReplyDir && /^[a-f0-9-]{36}$/.test(event.id)){
     let reply;try{reply=await this.d.browser(event.input);}catch(e){if(['RecordingStorageError','BrowserInfrastructureError','BrowserRetryLimitError'].includes((e as Error).name)){await this.close();throw e;}reply={passed:false,failure:(e as Error).message};}
     const path=this.d.browserReplyDir+'/'+event.id+'.json';const data=Buffer.from(JSON.stringify(reply)).toString('base64');
     await this.d.exec(`mkdir -p ${q(this.d.browserReplyDir)}; printf %s ${q(data)} | base64 -d > ${q(path+'.tmp')}; mv ${q(path+'.tmp')} ${q(path)}`);
     lastActivity=this.d.now();
    }
    if(event.type==='response' && event.id===id && event.success===false)throw new PiSessionInfrastructureError('Validation request rejected by the agent: '+event.error+'. No further repair request was sent.');
    if(event.type==='message_end' && event.message?.role==='assistant'){
     const msg=event.message;
     answer=(msg.content??[]).filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('\n');
     error=msg.stopReason==='error' ? msg.errorMessage || 'Model request failed' : '';
     if(answer)this.d.log?.(answer.slice(-2000));
    }
    if(event.type==='tool_execution_start'){const label=rpcOperationLabel(event);if(label){current=label;if(label!==lastLabel)this.d.log?.(label);lastLabel=label;}}
    if(event.type==='tool_execution_end' && event.isError)this.d.log?.('Command failed; its result was returned to the same agent for repair.');
    if(event.type==='agent_end'){
     if(error)throw new Error(error);
     return answer;
    }
   }
   if(!state.alive && !state.chunk){
    if(this.restarts++>=2)throw new Error('Pi process exited repeatedly; saved session and work are retained');
    await this.close();
    this.d.log?.('Pi exited. Resuming its saved conversation without restarting development.');
    return this.turn('The prior Pi process exited. Resume the saved work and inspect any in-flight command before rerunning it. Current controller request:\n'+message);
   }
   const idle=this.d.now()-lastActivity;
   if(idle>=360_000){await this.close();throw new Error('Agent stalled: no tool or model activity for six minutes. Last operation: '+current);}
   if(idle>=60_000 && this.d.now()-lastProgress>=60_000){this.d.log?.(current+' — no new activity for '+Math.floor(idle/1000)+' seconds.');lastProgress=this.d.now();}
   await this.d.wait();
  }
 }
}
export function rpcPollScript(proc:RpcProcess,offset:number):string{
 if(!proc.backgroundPid || !/^[1-9][0-9]*$/.test(proc.backgroundPid))throw new Error('Pi launcher PID missing');
 return `python3 - ${q(proc.outputFile)} ${offset} ${proc.backgroundPid} <<'PY'
import os,sys,json,base64
chunk=b'';offset=int(sys.argv[2])
try:
 with open(sys.argv[1],'rb') as f:
  f.seek(offset);chunk=f.read(262144);offset=f.tell()
except FileNotFoundError:pass
try:
 os.kill(int(sys.argv[3]),0)
 state=open('/proc/'+sys.argv[3]+'/stat').read().rsplit(')',1)[1].split()[0]
 alive=state!='Z'
except (OSError,IndexError):alive=False
print(json.dumps(dict(offset=offset,chunk=base64.b64encode(chunk).decode(),alive=alive)))
PY`;
}

export function rpcOperationLabel(event:any):string {
 const input=event.args || event.input || {};
 if(event.toolName==='lfg_browser')return 'Browser: '+String(input.label || input.action || 'inspecting page').slice(0,120);
 if(event.toolName==='bash'){
  const command=String(input.command || '');
  const labels:[RegExp,string][]=[[/dotnet\s+restore/,'Restoring .NET dependencies'],[/dotnet\s+(build|publish)/,'Compiling the application'],[/docker\s+(start|run|compose)/,'Starting development services'],[/docker\s+(ps|inspect|logs)/,'Inspecting database containers'],[/curl\b/,'Checking an HTTP response'],[/sqlcmd\b/,'Checking the database'],[/git\b/,'Inspecting the saved checkout'],[/\b(ss|netstat)\b/,'Checking app listeners'],[/\b(df|du|free|ps)\b/,'Checking sandbox resources']];
  return labels.find(([pattern])=>pattern.test(command))?.[1] || '';
 }
 return ({read:'Reading application files',edit:'Editing a file',write:'Writing a file',grep:'Searching application code',find:'Locating files'} as Record<string,string>)[event.toolName] || 'Running '+event.toolName;
}
