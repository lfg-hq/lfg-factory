// Feature-test worker resilience: problems that are not the feature must not fail the feature,
// and a real failure must say exactly which step broke, with a screenshot.
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,stat,mkdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';

// An unrelated script (analytics, HMR, a widget) throws once at load; the feature still works.
const html='<script>setTimeout(()=>{throw new Error("analytics widget crashed")},50)</script><label>Team<input aria-label="Team"></label><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save</button><output role="status"></output>';
const app=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(html);});
await new Promise(r=>app.listen(0,'127.0.0.1',r));
const chrome=spawn(process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--remote-debugging-port=0','--no-first-run','--user-data-dir='+await mkdtemp(tmpdir()+'/feature-chrome-')],{stdio:['ignore','ignore','pipe']});
let chromeOut='';const ws=await new Promise((resolve,reject)=>{chrome.stderr.on('data',d=>{chromeOut+=d;const m=chromeOut.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m)resolve(m[1])});chrome.on('error',reject)});
const base=`http://127.0.0.1:${app.address().port}`;
function worker(env){
 const child=spawn('node',['scripts/feature-browser-worker.mjs'],{stdio:['pipe','pipe','inherit'],env:{...process.env,...env}});
 let buffer='';const queued=[];let waiter;
 child.stdout.on('data',d=>{buffer+=d;let p;while((p=buffer.indexOf('\n'))>=0){const e=JSON.parse(buffer.slice(0,p));buffer=buffer.slice(p+1);if(['ready','step','result'].includes(e.type)){if(waiter){const w=waiter;waiter=null;w(e)}else queued.push(e)}}});
 const next=()=>queued.length?Promise.resolve(queued.shift()):new Promise(r=>waiter=r);
 return {child,send:cmd=>{child.stdin.write(JSON.stringify(cmd)+'\n');return next();}};
}
const assert=(ok,message,detail)=>{if(!ok)throw Error(message+(detail?': '+JSON.stringify(detail).slice(0,1500):''));console.log('ok -',message);};
try{
 // 1. Unrelated page error + working feature → passes, error is reported as a warning.
 {
  const outDir=await mkdtemp(tmpdir()+'/resilience-');const {child,send}=worker();
  await send({interactive:true,wsEndpoint:ws,base,outDir});
  const opened=await send({action:'goto',path:'/',label:'Open app'});
  await new Promise(r=>setTimeout(r,200));
  const fill=await send({action:'fill',locator:{label:'Team'},value:'Platform',label:'Fill team'});
  assert(fill.passed!==false,'a stray page error does not fail the next step',fill);
  assert([...(opened.pageErrors||[]),...(fill.pageErrors||[])].some(e=>e.includes('analytics widget crashed')),'the page error is reported to the agent',fill);
  const miss=await send({action:'click',locator:{role:'button',name:'Submit'},label:'Save (guessed name)'});
  assert(miss.type==='step' && miss.passed===false && /shot-\d+\.jpg/.test(miss.screenshot||'') && miss.snapshot?.includes('Save'),'a wrong locator returns the page to the agent instead of ending the attempt',miss);
  await send({action:'click',locator:{role:'button',name:'Save'},label:'Save'});
  const shot=await send({action:'screenshot',label:'Look at the saved form'});
  assert(shot.passed!==false && /^shot-\d+\.jpg$/.test(shot.screenshot||''),'screenshot action saves a named image',shot);
  assert((await stat(outDir+'/'+shot.screenshot)).size>1000,'screenshot file has image data');
  const check=await send({action:'assertText',locator:{role:'status'},value:'Platform',label:'Team saved',checkLabel:'Team saved'});
  assert(check.passed!==false && /^step-\d+\.jpg$/.test(check.screenshot||''),'assertions return their evidence screenshot',check);
  const result=await send({action:'finish'});child.stdin.end();
  assert(result.passed===true,'feature passes despite the unrelated page error',result);
  assert((result.pageErrors||[]).length>0,'final result lists page errors as warnings',result);
 }
 // 2. Real failure → pinpointed step, expected/observed, failure screenshot, no snapshot dump in the message.
 {
  const outDir=await mkdtemp(tmpdir()+'/resilience-');const {child,send}=worker();
  await send({interactive:true,wsEndpoint:ws,base,outDir});
  await send({action:'goto',path:'/',label:'Open app'});
  await send({action:'fill',locator:{label:'Team'},value:'Platform',label:'Fill team'});
  await send({action:'click',locator:{role:'button',name:'Save'},label:'Save'});
  const failed=await send({action:'assertText',locator:{role:'status'},value:'Design',label:'Team saved as Design',checkLabel:'Team saved as Design'});
  child.stdin.end();await new Promise(r=>child.on('close',r));
  assert(failed.type==='result' && failed.passed===false,'a wrong outcome fails the test',failed);
  assert(failed.failedStep?.label==='Team saved as Design' && failed.failedStep.expected==='Design' && failed.failedStep.actual==='Platform','failure pinpoints the step with expected and observed values',failed.failedStep);
  assert(!/Accessible page:/.test(failed.failure),'user-facing failure text is not a page dump',failed.failure);
  assert(typeof failed.snapshot==='string' && failed.snapshot.includes('Save'),'page snapshot is returned separately for the agent');
  assert(failed.failureScreenshot==='failure.jpg' && (await stat(outDir+'/failure.jpg')).size>1000,'failure screenshot is captured');
 }
 // 3. No ffmpeg on the server → assertions still decide the outcome; missing video is a warning.
 {
  const bin=await mkdtemp(tmpdir()+'/no-ffmpeg-');await mkdir(bin,{recursive:true});await symlink(process.execPath,bin+'/node');
  const outDir=await mkdtemp(tmpdir()+'/resilience-');const {child,send}=worker({PATH:bin});
  await send({interactive:true,wsEndpoint:ws,base,outDir});
  await send({action:'goto',path:'/',label:'Open app'});
  await send({action:'fill',locator:{label:'Team'},value:'Platform',label:'Fill team'});
  await send({action:'click',locator:{role:'button',name:'Save'},label:'Save'});
  await send({action:'assertText',locator:{role:'status'},value:'Platform',label:'Team saved',checkLabel:'Team saved'});
  const result=await send({action:'finish'});child.stdin.end();await new Promise(r=>child.on('close',r));
  assert(result.passed===true && result.video===false,'missing video does not fail a passing feature',result);
  assert(/recording/i.test(result.recordingWarning||''),'missing video is explained',result);
 }
 console.log('Feature browser resilience: all checks passed.');
}finally{chrome.kill();app.close();}
