import {checkLocalFeatureApp,checkPublicFeatureApp} from './feature-app-readiness.ts';
import {exposeTicketApp} from './ticket-app-url.ts';
import {RecordingArtifacts,type BrowserCheck,type BrowserStep} from './recording-artifacts.ts';
import {prepareRecordingDirectory} from './recording-storage.ts';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {mkdir,writeFile,rename,stat} from 'node:fs/promises';
import {shellQuote as q} from './preview-plan.ts';
import type {FeatureTestContext} from './ticket-feature-testing.ts';
type BrowserServices=Pick<typeof import('./mags.ts'),'startBrowserSession'|'enableHttpAccess'|'stopWorkspace'>;
/** The agent sends one browser action at a time and receives the real page snapshot. */
export class LiveFeatureBrowser {
 private child?:ChildProcessWithoutNullStreams;
 private job?:string;
 private url='';private dir='';private appUrl='';private pending?:{resolve:(v:any)=>void;reject:(e:Error)=>void};
 private artifacts?:RecordingArtifacts;
 private result:any;private timer?:ReturnType<typeof setTimeout>;private closed?:Promise<void>;
 private checks:BrowserCheck[]=[];
 private starts=0;
 private pendingStep?:BrowserStep;
 private unassignedSteps:BrowserStep[]=[];
 passed=false;started=false;applicabilityDecided=false;
 constructor(private o:Pick<FeatureTestContext,'workspaceId'|'ticketId'|'shell'|'progress'|'redact'>, private services?:BrowserServices, private artifactRoot?:string){}
 private async state(status:string,step:string){if(this.artifacts){this.artifacts.attempt=this.starts;this.artifacts.checks=this.checks.map(c=>Object.fromEntries(Object.entries(c).map(([k,v])=>[k,typeof v==='string'?this.o.redact(v):v])) as BrowserCheck);if(status==='working')await this.artifacts.state(status,this.o.redact(step));else await this.artifacts.finish(status,this.o.redact(step));return;}await writeFile(this.dir+'/status.tmp',JSON.stringify({status,attempt:this.starts,step:this.o.redact(step),appUrl:this.appUrl,checks:this.checks,updatedAt:Date.now()}));await rename(this.dir+'/status.tmp',this.dir+'/status.json');}
 async command(input:any):Promise<any>{
  if(input.action==='applicability'){if(!['api','not_applicable'].includes(input.kind)||!String(input.reason||'').trim())throw Error('Supply api or not_applicable and the ticket-specific reason');this.applicabilityDecided=true;await this.o.progress('**Feature testing:** '+input.kind+' — '+this.o.redact(input.reason));return {passed:true,decision:input.kind};}
  if(input.action==='start'){
   if(this.starts>=3){const error=new Error('Browser retry limit reached after three attempts. Review the recorded failures before starting another feature run.');error.name='BrowserRetryLimitError';throw error;}
   await this.close();
   this.starts++;this.passed=false;this.result=undefined;
   this.pendingStep=undefined;this.unassignedSteps=[];
   this.checks=Array.isArray(input.checks)?input.checks.filter((c:unknown)=>typeof c==='string'&&c.trim()).slice(0,50).map((label:string)=>({label,status:'pending'})):[];
   const local=new URL(input.appUrl);if(local.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(local.hostname)||local.username||local.password)throw Error('Use the local ticket app URL');
   this.artifacts=undefined;
   if(this.artifactRoot){this.url=`/uploads/ticket-tests/${this.o.ticketId}/${crypto.randomUUID()}`;this.dir=this.artifactRoot+this.url;}
   else {try{this.artifacts=await RecordingArtifacts.create(this.o.ticketId);this.url=this.artifacts.url;this.dir=this.artifacts.dir;}catch(e){const error=new Error('LFG recorder storage unavailable: '+(e as Error).message);error.name='RecordingStorageError';throw error;}}
   await prepareRecordingDirectory(this.dir);this.started=true;await this.state('working','Checking application readiness');
   await this.o.progress(`**Feature testing:** Checking the app before opening the live browser.\n\n[Live browser](${this.url}/status.json)`);
   try{
    await checkLocalFeatureApp({localUrl:local.href,shell:this.o.shell,progress:this.o.progress});
    const {startBrowserSession,enableHttpAccess}=this.services ?? await import('./mags.ts');
    const base=this.services
     ? await enableHttpAccess(this.o.workspaceId,Number(local.port||80))
     : await exposeTicketApp(this.o.ticketId,this.o.workspaceId,Number(local.port||80));
    const appUrl=new URL(local.pathname+local.search,base).href;this.appUrl=appUrl;if(this.artifacts)this.artifacts.appUrl=appUrl;
    await checkPublicFeatureApp(appUrl,this.o.progress);
    await this.state('working','App and public preview responded; starting browser');
    let storageState;
    if(input.authStatePath){if(!/^\/data\//.test(input.authStatePath))throw Error('Auth state must be in /data');const r=await this.o.shell('cat '+q(input.authStatePath));if(r.exitCode)throw Error('Cannot read test authentication');storageState=JSON.parse(r.output);}
    const session=await startBrowserSession({timeout:90000});this.job=session.requestId;
    const child=this.child=spawn('node',['scripts/feature-browser-worker.mjs'],{stdio:['pipe','pipe','pipe']});
    let buffer='',error='';let updates=Promise.resolve();
    let closed!:()=>void;this.closed=new Promise(resolve=>{closed=resolve;});
    child.stdout.on('data',d=>{buffer+=d;let nl;while((nl=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,nl);buffer=buffer.slice(nl+1);try{const event=JSON.parse(line);updates=updates.then(async()=>{
      if(event.type==='step-start')await this.state('working',event.label);
      if(event.type==='step'){if(this.pendingStep){this.pendingStep.status='passed';this.pendingStep.actual=this.o.redact(event.actual||'');this.pendingStep=undefined;await this.state('working',event.label);}const check=event.assertion?this.checks.find(c=>c.label===(event.checkLabel||event.label)&&c.status==='working'):undefined;if(check){check.status='passed';check.actual=this.o.redact(event.actual||'');await this.state('working',event.label);}}
      if(event.type==='result'){
       if(this.pendingStep){this.pendingStep.status=event.passed?'passed':'failed';this.pendingStep.error=this.o.redact(event.failure||'');this.pendingStep=undefined;}
       if(!event.passed)for(const check of this.checks)if(check.status==='working')check.status='failed';
       for(const result of event.results||[]){if(!result.assertion)continue;let check=this.checks.find(c=>c.label===(result.checkLabel||result.label));if(!check){check={label:result.checkLabel||result.label,status:'pending'};this.checks.push(check);}Object.assign(check,{status:result.passed?'passed':'failed',expected:this.o.redact(result.expected||''),actual:this.o.redact(result.actual||''),target:this.o.redact(result.target||''),error:this.o.redact(result.error||'')});}
       this.result=event;
       await this.state(event.passed?'passed':'failed',event.failure||'All browser assertions passed');this.passed=event.passed;
       await this.o.progress(`**Feature testing ${event.passed?'passed':'failed'}.** ${this.o.redact(event.failure||'Browser assertions passed.')}\n\n${event.video?'[Watch recording]('+this.url+'/recording.mp4)':'No recording: no browser frames were captured.'}`);
      }
      if(['ready','step','result'].includes(event.type)){clearTimeout(this.timer);const p=this.pending;this.pending=undefined;p?.resolve(event);}
     }).catch(async e=>{clearTimeout(this.timer);this.passed=false;this.pending?.reject(e);this.pending=undefined;await this.artifacts?.state('failed','Recording evidence could not be saved: '+this.o.redact(e.message)).catch(()=>{});await this.o.progress('**Feature testing failed.** Recording evidence could not be saved: '+this.o.redact(e.message)).catch(()=>{});});}catch{}}});
    child.stderr.on('data',d=>error=(error+d).slice(-1500));
    child.on('error',e=>{this.pending?.reject(e);this.pending=undefined;});
    child.on('close',()=>{void updates.then(async()=>{if(!this.result){clearTimeout(this.timer);await this.state('failed','Browser process ended: '+error);const video=await stat(this.dir+'/recording.mp4').then(s=>s.size>1000).catch(()=>false);await this.o.progress(`**Feature testing failed.** Browser process ended. ${this.o.redact(error)}${video?'\n\n[Watch recording]('+this.url+'/recording.mp4)':' No browser recording was captured.'}`);this.pending?.reject(Error('Browser process ended'));this.pending=undefined;}}).catch(e=>{this.pending?.reject(e);this.pending=undefined;}).finally(closed);});
    child.stdin.on('error',()=>{});
    const ready=this.wait();child.stdin.write(JSON.stringify({interactive:true,wsEndpoint:session.wsEndpoint,base,outDir:this.dir,storageState})+'\n');const initialized=await ready;if(initialized.type!=='ready'){if(/certificate|local issuer|CERT_/i.test(initialized.failure||'')){const error=new Error('LFG browser connection unavailable: the recorder could not verify the Mags TLS certificate. Check the LFG server CA trust bundle and the Mags certificate chain. No browser frames were captured; sandbox commands cannot repair this server connection.');error.name='BrowserInfrastructureError';throw error;}throw Error(initialized.failure||'Browser could not start');}
    return this.command({action:'goto',path:local.pathname+local.search,label:'Open existing application'});
   }catch(e){if(!this.result)await this.state('failed',(e as Error).message).catch(()=>{});await this.close();throw e;}
  }
  if(!this.child||this.result)throw Error('Start a browser attempt first');
  if(!['goto','snapshot','click','fill','select','press','assertVisible','assertText','assertValue','finish'].includes(input.action))throw Error('Unsupported browser action');
  if(input.action==='goto'&&(!input.path?.startsWith('/')||input.path.startsWith('//')))throw Error('Use app-relative paths');
  if(input.action==='finish'&&this.checks.some(c=>c.status!=='passed'))throw Error('Complete all listed browser checks before finishing');
  if(input.action.startsWith('assert')){const label=input.checkLabel||input.label;let check=this.checks.find(c=>c.label===label);if(!check){if(this.checks.length||!label||label===input.action)throw Error('Link this assertion to a planned check using checkLabel. Do not create a separate tool-name result.');check={label,status:'pending'};this.checks.push(check);}input={...input,checkLabel:check.label};check.status='working';check.expected=this.o.redact(input.action==='assertVisible'?'Visible':String(input.value??''));check.target=this.o.redact(input.locator?.name||input.locator?.label||input.locator?.text||input.locator?.selector||'');}
  if(input.action!=='finish'){
   const checkLabel=input.checkLabel||(input.action.startsWith('assert')?input.label||input.action:undefined);
   const check=this.checks.find(c=>c.label===checkLabel);
   if(input.checkLabel&&!check)throw Error('checkLabel must match a planned assertion');
   const step:BrowserStep={label:this.o.redact(input.label||input.action),action:input.action,status:'working',target:this.o.redact(input.locator?.name||input.locator?.label||input.locator?.selector||input.path||'')};
   // Input values can contain passwords: persist only assertion expectations.
   if(input.action.startsWith('assert'))step.expected=this.o.redact(input.action==='assertVisible'?'Visible':String(input.value??''));
   if(check){check.steps??=[];check.steps.push(...this.unassignedSteps,step);this.unassignedSteps=[];check.status='working';}else this.unassignedSteps.push(step);
   this.pendingStep=step;
  }
  await this.state('working',input.label||input.action);
  const reply=this.wait();this.child.stdin.write(JSON.stringify({...input,id:crypto.randomUUID(),label:input.label||input.action})+'\n');
  if(input.action==='finish')this.child.stdin.end();
  const event=await reply;
  return {passed:event.passed!==false,snapshot:event.snapshot,failure:event.failure,recording:event.type==='result'?this.url+'/recording.mp4':undefined};
 }
 private wait(){if(this.pending)throw Error('A browser command is already running');return new Promise<any>((resolve,reject)=>{this.pending={resolve,reject};this.timer=setTimeout(()=>{this.pending=undefined;reject(Error('Browser action stalled for 45 seconds'));this.child?.kill('SIGTERM');},45000);});}
 async close(){
  clearTimeout(this.timer);
  if(this.child){const child=this.child;this.child=undefined;child.stdin.end();child.kill('SIGTERM');const force=setTimeout(()=>child.kill('SIGKILL'),12000);await this.closed;clearTimeout(force);}
  if(this.job){const {stopWorkspace}=this.services ?? await import('./mags.ts');await stopWorkspace(this.job).catch(()=>{});this.job=undefined;}
 }
}
export const LIVE_BROWSER_INSTRUCTION=`Recording storage is owned by the LFG server, not this sandbox. Never try to repair recorder S3 credentials or recorder filesystem paths using sandbox shell commands. Report a recorder infrastructure error as such. You have lfg_browser, a real browser connected to the user's live view and recording. Before browser testing, report whether you reused an existing process or started it. If starting it, show the exact startup command with secrets omitted, working directory, startup result, and server log location. Confirm an HTTP response in the saved sandbox; a listening port alone is insufficient. If the server is stopped, start the existing saved app in this same sandbox using its documented command, inspect startup logs and confirm readiness. For UI work, use it after confirming the running app: action start with appUrl http://127.0.0.1:PORT/. Include checks:["specific expected outcome",...] in start, derived from ticket acceptance criteria, so the user sees the checklist immediately. On every browser action supply checkLabel with the exact planned assertion it supports; the UI groups these steps under that assertion. Each check must have a matching assertion label; use readable labels describing the expected outcome on every action. Do not spend time on a separate planning session or run HTTP scripts for UI flows. Navigate/login in this visible browser, use snapshot to inspect accessible controls, then fill/click/select/press and assertVisible/assertText/assertValue to verify outcomes. For table headings, assert each required column using role columnheader rather than concatenating the whole table header. assertText normalizes whitespace; use ignoreCase:true only when letter case is cosmetic, such as styled column headings. Reuse the exact planned check label for its assertion; do not rename it and leave the original pending. Diagnose a failed attempt before restarting; this run allows at most three browser attempts. Supply locator:{role,name} or {label} or {selector}; goto uses app-relative path. Each call returns the real page snapshot. You can supply authStatePath under /data on start for existing test cookies, or log in through visible controls. Each failed browser attempt is recorded; call start again to retry after diagnosing the failure. Call finish only after assertions pass. Your first action must be start for UI work, or applicability with kind api/not_applicable and a ticket-specific reason. Preparation without that decision is limited to two minutes. For API-only or schema-only work, explain applicability in featureTest as before; don't open an irrelevant browser. Before prolonged preparation, report the specific blocker. Do not spend the session inspecting source instead of exercising the app.`;
