import {checkLocalFeatureApp,checkPublicFeatureApp} from './feature-app-readiness.ts';
import {exposeTicketApp} from './ticket-app-url.ts';
import {RecordingArtifacts} from './recording-artifacts.ts';
import {prepareRecordingDirectory} from './recording-storage.ts';
import {spawn} from 'node:child_process';
import {mkdir,readFile,stat,writeFile,rename} from 'node:fs/promises';
import {featureTestPlanSchema, type FeatureTestPlan} from './feature-test-plan.ts';
import {shellQuote as q} from './preview-plan.ts';
export type FeatureTestContext={workspaceId:string;ticketId:string;root:string;appUrl?:string;plan:FeatureTestPlan;deadline:number;cancelled?:()=>boolean;check:(command:string)=>Promise<{exitCode:number;output:string}>;shell:(command:string)=>Promise<{exitCode:number;output:string}>;progress:(message:string)=>Promise<void>;redact:(s:string)=>string};
export function apiTestCommand(call:FeatureTestPlan['calls'][number],o:Pick<FeatureTestContext,'root'|'appUrl'|'plan'>,index:number){
 const base=new URL(o.appUrl!);if(!['127.0.0.1','localhost','[::1]'].includes(base.hostname)||base.protocol!=='http:')throw Error('API tests must target the local ticket app');
 const url=new URL(call.path,base);if(url.origin!==base.origin)throw Error('API test escaped app origin');
 const body=`${o.root}/api-${index}.body`,status=`${o.root}/api-${index}.status`;
 const auth=[o.plan.cookieJarPath?`--cookie ${q(o.plan.cookieJarPath)}`:'',o.plan.headerFilePath?`--header ${q('@'+o.plan.headerFilePath)}`:''].join(' ');
 const spec=Buffer.from(JSON.stringify({expectedStatus:call.expectedStatus,includes:call.includes,jsonEquals:call.jsonEquals})).toString('base64');
 return `set -e\ncurl --silent --show-error --connect-timeout 5 --max-time 25 -X ${call.method} ${auth} -H 'Content-Type: application/json' ${call.body!==undefined?'--data-raw '+q(call.body):''} -o ${q(body)} -w '%{http_code}' ${q(url.href)} > ${q(status)}\npython3 - ${q(body)} ${q(status)} ${q(spec)} <<'PY'
import json,sys,base64
body=open(sys.argv[1]).read(); status=int(open(sys.argv[2]).read()); spec=json.loads(base64.b64decode(sys.argv[3])); errors=[]
if status!=spec['expectedStatus']: errors.append('Unexpected HTTP status')
if spec.get('includes') is not None and spec['includes'] not in body: errors.append('Expected response text missing')
if spec.get('jsonEquals') is not None:
 try:
  data=json.loads(body)
  for key,value in spec['jsonEquals'].items():
   actual=data
   for part in key.split('.'): actual=actual[int(part)] if isinstance(actual,list) else actual[part]
   if actual!=value: errors.append('Response field '+key+' did not match')
 except (ValueError,KeyError,TypeError,IndexError): errors.append('Invalid JSON or missing response field')
print(json.dumps({'passed':not errors,'expected':spec,'actualStatus':status,'response':body[:2500],'errors':errors}))
sys.exit(1 if errors else 0)
PY`;
}
export async function runTicketFeatureTesting(o:FeatureTestContext){
 try { return await executeFeatureTesting(o); }
 catch(error){
  await o.progress(`**Feature testing failed.** ${o.redact((error as Error).message).slice(0,2500)}\n\nBrowser recordings are attached to their attempts above when frames were captured. Setup and API failures have diagnostic output rather than a screen recording.`);
  throw error;
 }
}
async function executeFeatureTesting(o:FeatureTestContext){
 const plan=featureTestPlanSchema.parse(o.plan);
 const explain=plan.applicability.map(a=>`- ${a.criterion}: ${a.applicable?'Applicable':'Not applicable'} — ${a.reason}`).join('\n');
 await o.progress(`**Feature testing:** ${plan.kind==='not_applicable'?'Not applicable':plan.kind==='browser'?'Browser interactions and recording':'API requests'}\n\n${plan.reason}\n\n${explain}`);
 if(plan.kind==='not_applicable'){await o.progress(`**Feature testing not applicable.** ${plan.reason}`);return;}
 if(!o.appUrl)throw Error('Feature testing requires the running app URL');
 if(plan.kind==='api'){
  for(let i=0;i<plan.calls.length;i++){
   if(o.cancelled?.()||Date.now()>=o.deadline)throw Error('Feature testing cancelled or deadline reached');
   const call=plan.calls[i]!;await o.progress(`**Feature testing:** ${call.label} — ${call.method} ${call.path}; expected HTTP ${call.expectedStatus}.`);
   const result=await o.check(apiTestCommand(call,o,i));
   await o.progress(`**API test result:** ${call.label}\n\n\`\`\`json\n${o.redact(result.output).slice(0,5000)}\n\`\`\``);
   if(result.exitCode!==0)throw Error(`Feature testing failed: ${call.label}\n${o.redact(result.output)}`);
  }
  await o.progress('**Feature testing passed.** All applicable API response assertions passed.');return;
 }
 const {startBrowserSession,stopWorkspace}=await import('./mags.ts');
 const local=new URL(o.appUrl);if(local.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(local.hostname))throw Error('Browser app must be the local ticket app');
 await o.progress('**Feature testing:** Connecting the existing app to the browser.');
 await checkLocalFeatureApp({localUrl:local.href,shell:o.shell,progress:o.progress});
 const base=await exposeTicketApp(o.ticketId,o.workspaceId,Number(local.port||80));
 await checkPublicFeatureApp(new URL(local.pathname+local.search,base).href,o.progress);
 let storageState: unknown;
 if(plan.authStatePath){const r=await o.shell(`cat ${q(plan.authStatePath)}`);if(r.exitCode!==0)throw Error('Cannot read test authentication state');try{storageState=JSON.parse(r.output);}catch{throw Error('Test authentication state is not valid JSON');}}
 await o.progress('**Feature testing:** Starting Mags browser. No recording exists until the browser connects.');

 const artifacts=await RecordingArtifacts.create(o.ticketId);const url=artifacts.url;const outDir=artifacts.dir;
 artifacts.appUrl=new URL(local.pathname+local.search,base).href;
 artifacts.checks=plan.steps.filter(s=>s.action.startsWith('assert')).map(s=>({label:o.redact(s.label),status:'pending'}));
 await prepareRecordingDirectory(outDir);
 let session;try{session=await startBrowserSession({timeout:Math.min(360000,Math.max(1000,o.deadline-Date.now()))});}catch(e){await artifacts.abort((e as Error).message);throw e;}
 let result:any;
 const state=async(status:string,step:string)=>{await writeFile(outDir+'/status.tmp',JSON.stringify({status,step:o.redact(step),updatedAt:Date.now()}));await rename(outDir+'/status.tmp',outDir+'/status.json');await artifacts.state(status,o.redact(step));};
 try{
  await mkdir(outDir,{recursive:true});
  await state('working','Connecting browser and starting recording');
  await o.progress(`**Feature testing:** Live browser

[Live browser](${url}/status.json)`);
  result=await new Promise<any>((resolve,reject)=>{
   const child=spawn('node',[process.cwd()+'/scripts/feature-browser-worker.mjs'],{stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32'});let buffer='',stderr='',done:any;let updates=Promise.resolve();
   const kill=()=>{try{if(process.platform==='win32')child.kill('SIGKILL');else if(child.pid)process.kill(-child.pid,'SIGKILL');}catch{}};
   let stopping=false;let force:ReturnType<typeof setTimeout>|undefined;
   const stop=()=>{if(stopping)return;stopping=true;child.kill('SIGTERM');force=setTimeout(kill,15000);};
   const abort=setInterval(()=>{if(o.cancelled?.()||Date.now()>=o.deadline)stop();},500);
   const timer=setTimeout(stop,Math.min(360000,Math.max(1000,o.deadline-Date.now())));
   child.stdout.on('data',d=>{buffer+=d.toString();let pos;while((pos=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,pos);buffer=buffer.slice(pos+1);try{const msg=JSON.parse(line);if(msg.type==='result')done=msg;else if(msg.type==='step-start')updates=updates.then(()=>{const check=artifacts.checks.find(c=>c.label===o.redact(msg.label));if(check)check.status='working';return state('working',`Step ${msg.index}/${msg.total}: ${msg.label}`);}).catch(()=>{});else if(msg.type==='step')updates=updates.then(async()=>{const check=artifacts.checks.find(c=>c.label===o.redact(msg.label));if(check)check.status='passed';await state('working',msg.label);await o.progress('**Feature testing:** Passed — '+o.redact(msg.label));}).catch(()=>{});}catch{}}});
   child.stderr.on('data',d=>stderr=(stderr+d.toString()).slice(-2000));
   child.on('error',e=>{clearInterval(abort);clearTimeout(timer);clearTimeout(force);reject(e);});
   child.on('close',code=>{clearInterval(abort);clearTimeout(timer);clearTimeout(force);if(code===0&&done)void updates.then(()=>resolve(done));else reject(Error('Browser test worker stopped before completing: '+o.redact(stderr)));});
   child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({wsEndpoint:session.wsEndpoint,base,outDir,storageState,steps:plan.steps}));
  });
 }catch(error){result={passed:false,failure:o.redact((error as Error).message),results:[],video:await stat(outDir+'/recording.mp4').then(s=>s.size>0).catch(()=>false)};}finally{await stopWorkspace(session.requestId).catch(()=>{});}

 for(const entry of result.results||[]){if(!entry.assertion)continue;const check=artifacts.checks.find(c=>c.label===o.redact(entry.label));if(check)Object.assign(check,{status:entry.passed?'passed':'failed',expected:o.redact(entry.expected||''),actual:o.redact(entry.actual||''),target:o.redact(entry.target||''),error:o.redact(entry.error||'')});}
 let evidence='';
 if(result.video && await stat(outDir+'/recording.mp4').then(s=>s.size>0).catch(()=>false))evidence=`\n\n[Watch recording](${url}/recording.mp4)`;
 for(let i=0;i<plan.steps.length;i++)if(plan.steps[i]!.action.startsWith('assert')&&await stat(outDir+`/step-${i}.jpg`).then(()=>true).catch(()=>false))evidence+=`\n[Assertion screenshot ${i+1}](${url}/step-${i}.jpg)`;
 await o.progress(`**Feature testing ${result.passed?'passed':'failed'}.**\n\n${(result.results||[]).map((r:any)=>`- ${r.passed?'Passed':'Failed'}: ${r.label}${r.actual?' — '+o.redact(r.actual):''}`).join('\n')}${!result.passed?'\n\n'+o.redact(result.failure).slice(0,2000):''}${evidence || '\n\nNo recording was captured: the browser did not produce video frames.'}`);
 if(!result.passed){
  for(const check of artifacts.checks)if(check.status==='working')check.status='failed';
  let imageHint='';
  const image=await readFile(outDir+'/failure.jpg').catch(()=>null);
  if(image){const target=o.root+'/browser-failure.jpg';await o.shell(`printf %s ${q(image.toString('base64'))} | base64 -d > ${q(target)}`);imageHint=`\nInspect screenshot with your read tool: ${target}`;}
  await artifacts.finish('failed',o.redact(result.failure));
  throw Error('Feature testing failed: '+o.redact(result.failure).slice(0,12000)+imageHint);
 }
 await artifacts.finish('passed','All browser checks passed');
}
