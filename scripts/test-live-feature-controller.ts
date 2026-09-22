/** Real LFG controller -> recording worker -> Chromium -> authenticated test app.
 * Only the cloud provisioning adapter is replaced by a local CDP endpoint.
 * Run: bun scripts/test-live-feature-controller.ts
 */
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {LiveFeatureBrowser} from '../src/services/live-feature-browser.ts';
import {recordingResponse} from '../src/services/test-recording-response.ts';
const root=await mkdtemp(tmpdir()+'/lfg-controller-');
const app=Bun.serve({port:0,fetch(req){
 if(!req.headers.get('cookie')?.includes('test_session=valid'))return new Response('Login required',{status:401});
 return new Response(`<label>Team<input aria-label="Team"></label><button onclick="localStorage.setItem('team',document.querySelector('input').value);document.querySelector('output').textContent=localStorage.getItem('team')">Save</button><output role="status"></output><script>document.querySelector('output').textContent=localStorage.getItem('team')||''</script>`,{headers:{'Content-Type':'text/html'}});
}});
const chrome=spawn(process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--remote-debugging-port=0','--no-first-run','--user-data-dir='+root+'/chrome'],{stdio:['ignore','ignore','pipe']});
let buffer='';const ws=await new Promise<string>((resolve,reject)=>{chrome.stderr.on('data',d=>{buffer+=d;const match=buffer.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match)resolve(match[1]!);});chrome.on('error',reject);});
const recordings:string[]=[];
const logs:string[]=[];let starts=0,stops=0;
const controller=new LiveFeatureBrowser({workspaceId:'fixture',ticketId:'fixture-ticket',redact:s=>s,progress:async message=>{logs.push(message)},shell:async command=>command.startsWith('curl ') ? await (async()=>{const process=Bun.spawn(['sh','-c',command],{stdout:'pipe',stderr:'pipe'});return {exitCode:await process.exited,output:await new Response(process.stdout).text()};})() : ({exitCode:0,output:JSON.stringify({cookies:[{name:'test_session',value:'valid',domain:'127.0.0.1',path:'/',expires:-1,httpOnly:true,secure:false,sameSite:'Lax'}],origins:[]})})},{startBrowserSession:async()=>{starts++;return {requestId:'fixture',wsEndpoint:ws,cdpHttpUrl:''}},enableHttpAccess:async()=>app.url.href,stopWorkspace:async()=>{stops++;}},root);
try{
 await controller.command({action:'start',appUrl:app.url.href,authStatePath:'/data/test-auth.json',checks:['Unfinished check']});
 const priorUrl=logs.slice().reverse().find(m=>m.includes('[Live browser]'))!.match(/\[Live browser\]\((.*?)\/status.json\)/)![1]!;
 for(const expected of ['Engineering','Deliberate mismatch']){
  const opened=await controller.command({action:'start',appUrl:app.url.href,authStatePath:'/data/test-auth.json',checks:['Saved team persists after reload']});
  const prior=JSON.parse(await readFile(root+priorUrl+'/status.json','utf8'));
  if(prior.status!=='failed'||prior.attempt!==1||prior.checks[0].label!=='Unfinished check')throw Error('Restart overwrote previous attempt evidence');
  if(!opened.passed||!opened.snapshot.includes('Save'))throw Error('Authenticated app did not open');
  let rejected=false;try{await controller.command({action:'assertVisible',locator:{role:'button',name:'Save'}});}catch(e){rejected=String(e).includes('checkLabel');}if(!rejected)throw Error('Unlinked assertion was accepted');
  await controller.command({action:'fill',checkLabel:'Saved team persists after reload',locator:{label:'Team'},value:'Engineering'});
  await controller.command({action:'click',locator:{role:'button',name:'Save'}});
  await controller.command({action:'goto',path:'/',label:'Reload to verify persistence'});
  const assertion=await controller.command({action:'assertText',checkLabel:'Saved team persists after reload',locator:{role:'status'},value:expected});
  if(expected==='Engineering'){if(!assertion.passed)throw Error(assertion.failure);await controller.command({action:'finish'});}
  else if(assertion.passed)throw Error('False success on failed assertion');
  const url=logs.slice().reverse().find(m=>m.includes('[Live browser]'))!.match(/\[Live browser\]\((.*?)\/status.json\)/)![1]!;
  const state=JSON.parse(await readFile(root+url+'/status.json','utf8'));
  if(state.status!==(expected==='Engineering'?'passed':'failed'))throw Error('Incorrect persisted status');
  if(state.checks.length!==1)throw Error('Assertion created a duplicate tool-name check');
  if(state.checks?.[0]?.status!==(expected==='Engineering'?'passed':'failed'))throw Error('Checklist did not reflect actual assertion result');
  if(state.checks[0].expected!==expected || state.checks[0].actual!=='Engineering')throw Error('Expected/actual assertion evidence was lost');
  if(!state.checks[0].steps?.some((step:any)=>step.action==='fill'&&step.status==='passed'))throw Error('Assertion steps were not persisted');
  if(state.checks[0].steps.at(-1).status!==(expected==='Engineering'?'passed':'failed'))throw Error('Incorrect assertion step outcome');
  if((await stat(root+url+'/live.jpg')).size<100)throw Error('Missing live frame');
  const file=Bun.file(root+url+'/recording.mp4');if(file.size<1000)throw Error('Missing recording');
  const response=recordingResponse(file,'bytes=0-1023');if(response.status!==206||(await response.arrayBuffer()).byteLength!==1024)throw Error('Playback seeking failed');
  recordings.push(root+url+'/recording.mp4');
  console.log(JSON.stringify({expected,status:state.status,recording:root+url+'/recording.mp4'}));
 }
 let capped=false;try{await controller.command({action:'start',appUrl:app.url.href});}catch(e){capped=(e as Error).name==='BrowserRetryLimitError';}if(!capped)throw Error('Retry limit was not enforced');
 await controller.close();
 const playback=spawn('node',['scripts/test-recording-playback.mjs',...recordings],{stdio:'inherit'});
 if(await new Promise(resolve=>playback.on('close',resolve))!==0)throw Error('Recording playback failed');
}finally{await controller.close();chrome.kill();app.stop(true);}
if(starts!==3||stops!==3)throw Error('Browser sessions were not cleaned up');
console.log('LFG controller passed: test login, navigation, persistence assertion, failure evidence, video ranges, retry and cleanup.');
