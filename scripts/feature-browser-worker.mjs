import {matchesBrowserText} from './browser-text-match.mjs';
/* Node owns CDP and ffmpeg. Frames are captured locally so remote CDP video paths are never assumed local.
   The verdict comes from the feature's assertions only. Recording problems and stray page errors are
   reported as warnings: they are evidence gaps, not proof that the feature is broken. */
import {chromium} from 'playwright-core';
import {spawn} from 'node:child_process';
import {mkdir,stat,writeFile,rename} from 'node:fs/promises';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
const input=createInterface({input:process.stdin})[Symbol.asyncIterator]();
const cfg=JSON.parse((await input.next()).value);
async function* steps(){if(!cfg.interactive){yield* cfg.steps;return;}while(true){const next=await input.next();if(next.done)throw Error('Browser controller disconnected');const cmd=JSON.parse(next.value);if(cmd.action==='finish')return;yield cmd;}}
const emit=o=>process.stdout.write(JSON.stringify(o)+'\n');
let browser,context,page,encoder,capture;let recording=false,recordError='',encoderError='',frames=0;
// Serialize captures: periodic live frames and assertion screenshots share one remote page.
let captureQueue=Promise.resolve();
const screenshot=(options)=>{const next=captureQueue.then(()=>page.screenshot({...options,timeout:15000}));captureQueue=next.catch(()=>{});return next;};
const results=[];let passed=false,failure='',failedStep,snapshot,failureScreenshot,cancelled=false;
const pageErrors=[];let unreported=[];
process.on('SIGTERM',()=>{cancelled=true;void page?.close().catch(()=>{});});
const publishFrame=async frame=>{await writeFile(cfg.outDir+'/live.tmp',frame);await rename(cfg.outDir+'/live.tmp',cfg.outDir+'/live.jpg');};
const locator=(p,s)=>s.role?p.getByRole(s.role,{name:s.name,exact:true}):s.label?p.getByLabel(s.label,{exact:true}):s.text?p.getByText(s.text,{exact:true}):p.locator(s.selector);
const pageSnapshot=async()=>{try{return (await page.locator('body').ariaSnapshot({timeout:15000})).slice(0,12000);}catch{return undefined;}};
// A video frame is best effort: a slow capture must never fail a feature step.
const recordFrame=async()=>{if(!encoder||encoderError)return;try{const frame=await screenshot({type:'jpeg',quality:65,timeout:5000});if(!encoder.stdin.write(frame))await once(encoder.stdin,'drain');frames++;}catch(e){recordError=e.message;}};
// Errors raised by the page since the last step; reported once, then cleared.
const takePageErrors=()=>{const out=unreported.slice(0,10).map(m=>m.slice(0,400));unreported=[];return out;};
let shots=0;
try{
 await mkdir(cfg.outDir,{recursive:true});
 browser=await chromium.connectOverCDP(cfg.wsEndpoint,{timeout:20000});
 const origin=new URL(cfg.base).origin;
 const state=cfg.storageState;
 if(state){for(const c of state.cookies||[]){if(['localhost','127.0.0.1','::1'].includes(c.domain?.replace(/^\./,''))){c.domain=new URL(origin).hostname;c.secure=true;}}
  for(const o of state.origins||[]){if(['localhost','127.0.0.1','[::1]'].includes(new URL(o.origin).hostname))o.origin=origin;}}
 context=await browser.newContext({viewport:{width:1280,height:800},storageState:state,ignoreHTTPSErrors:true});
 page=await context.newPage();page.setDefaultTimeout(8000);
 // Keep authenticated test requests on this app. No external OAuth/login redirects.
 await context.route('**/*',async route=>{const u=new URL(route.request().url());if(['http:','https:'].includes(u.protocol)&&u.origin!==origin&&route.request().isNavigationRequest())return route.abort();return route.continue();});
 page.on('pageerror',e=>{const m=String(e?.message||e);if(pageErrors.length<50&&!pageErrors.includes(m))pageErrors.push(m);unreported.push(m);});
 encoder=spawn('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','image2pipe','-framerate','2','-vcodec','mjpeg','-i','pipe:0','-an','-c:v','libx264','-pix_fmt','yuv420p','-movflags','frag_keyframe+empty_moov+default_base_moof',cfg.outDir+'/recording.mp4'],{stdio:['pipe','ignore','pipe']});
 encoder.on('error',e=>{encoderError=e.message;});encoder.stdin.on('error',e=>{encoderError=e.message;});encoder.stderr.on('data',d=>{encoderError+=d.toString().slice(0,1000);});
 recording=true;
 // Live frames keep flowing for the user even when the video encoder is unavailable.
 capture=(async()=>{while(recording){try{const frame=await screenshot({type:'jpeg',quality:65,timeout:5000});await publishFrame(frame);if(!encoderError){if(!encoder.stdin.write(frame))await once(encoder.stdin,'drain');frames++;}recordError='';}catch(e){recordError=e.message;}await new Promise(r=>setTimeout(r,500));}})();
 emit({type:'ready'});
 let i=-1;for await(const step of steps()){
  i++;
  if(cancelled)throw Error('Browser test cancelled');
  const assertion=step.action.startsWith('assert');
  const evidence={checkLabel:step.checkLabel,assertion,action:step.action,target:step.locator?.name||step.locator?.label||step.locator?.text||step.locator?.selector||step.path||'',expected:step.action==='assertVisible'?'Visible':assertion?String(step.value??''):''};
  let actual='';let shot;emit({type:'step-start',label:step.label,index:i+1,total:cfg.steps?.length});
  try{
   if(step.action==='snapshot'){actual=await page.locator('body').ariaSnapshot({timeout:15000});}
   else if(step.action==='screenshot'){shot=`shot-${++shots}.jpg`;await screenshot({path:cfg.outDir+'/'+shot,type:'jpeg',quality:60});actual='Screenshot saved';}
   else if(step.action==='goto'){const url=new URL(step.path,cfg.base);if(url.origin!==origin)throw Error('Off-origin navigation refused');const r=await page.goto(url.href,{waitUntil:'domcontentloaded',timeout:15000});if(!r||r.status()>=400)throw Error('Navigation HTTP '+r?.status());actual='HTTP '+r.status();}
   else{const target=locator(page,step.locator);switch(step.action){
    case 'click':await target.click();break;
    case 'fill':await target.fill(step.value);break;
    case 'select':await target.selectOption(step.value);break;
    case 'press':await target.press(step.value);break;
    case 'assertVisible':await target.waitFor({state:'visible'});actual='Visible';break;
    case 'assertText':{await target.waitFor({state:'visible'});const until=Date.now()+8000;do{actual=await target.innerText();if(matchesBrowserText(actual,step.value,step.ignoreCase))break;await new Promise(r=>setTimeout(r,200));}while(Date.now()<until);if(!matchesBrowserText(actual,step.value,step.ignoreCase))throw Error('Expected text '+JSON.stringify(step.value)+'; got '+JSON.stringify(actual.slice(0,500)));break;}
    case 'assertValue':actual=await target.inputValue();if(actual!==step.value)throw Error('Expected value '+JSON.stringify(step.value)+'; got '+JSON.stringify(actual.slice(0,500)));break;
    default:throw Error('Unsupported step');
   }}
   if(assertion){shot=`step-${i}.jpg`;await screenshot({path:cfg.outDir+'/'+shot,type:'jpeg',quality:70}).catch(()=>{shot=undefined;});}
   await recordFrame();
   const errors=takePageErrors();
   results.push({label:step.label,passed:true,...evidence,actual:actual.slice(0,1000),screenshot:shot,pageErrors:errors.length?errors:undefined});
   emit({type:'step',id:step.id,label:step.label,passed:true,...evidence,actual:actual.slice(0,1000),screenshot:shot,pageErrors:errors.length?errors:undefined,snapshot:cfg.interactive?await pageSnapshot():undefined});
  }catch(e){
   const error=e.message.slice(0,2000);const errors=takePageErrors();
   // An interaction miss (wrong locator, slow control) during a live session is returned to the
   // agent with the page as it is, so it can correct the step. Only a failed outcome assertion,
   // a scripted plan or a cancelled run ends the attempt.
   if(cfg.interactive&&!assertion&&!cancelled&&!page.isClosed()){
    shot=`shot-${++shots}.jpg`;await screenshot({path:cfg.outDir+'/'+shot,type:'jpeg',quality:60}).catch(()=>{shot=undefined;});
    await recordFrame();
    emit({type:'step',id:step.id,label:step.label,passed:false,...evidence,actual:actual.slice(0,1000),error,screenshot:shot,pageErrors:errors.length?errors:undefined,snapshot:await pageSnapshot()});
    continue;
   }
   failedStep={label:step.label,...evidence,actual:actual.slice(0,1000),error};
   results.push({...failedStep,passed:false,pageErrors:errors.length?errors:undefined});throw e;
  }
 }
 if(cfg.interactive&&!results.some(r=>r.assertion))throw Error('No browser outcome assertion was executed');
 passed=!cancelled;
 await new Promise(r=>setTimeout(r,600));
}catch(e){
 failure=!page && /certificate|local issuer|CERT_/i.test(e.message)?'Mags browser TLS certificate verification failed: the recorder could not verify the certificate issuer. No browser frames were captured.':e.message;
 if(failedStep)failure=`Step "${failedStep.label}" failed: ${failedStep.error}`;
 if(page&&!page.isClosed()){
  if(await screenshot({path:cfg.outDir+'/failure.jpg',type:'jpeg',quality:65,timeout:5000}).then(()=>true).catch(()=>false))failureScreenshot='failure.jpg';
  snapshot=await pageSnapshot();
 }
}
finally{
 recording=false;await capture?.catch(()=>{});
 if(encoder){encoder.stdin.end();let endTimer;const code=await Promise.race([new Promise(resolve=>encoder.exitCode!==null?resolve(encoder.exitCode):encoder.once('close',resolve)),new Promise(resolve=>{endTimer=setTimeout(()=>{encoder.kill('SIGKILL');resolve(-1)},10000)})]);clearTimeout(endTimer);if(code!==0&&!encoderError)encoderError='ffmpeg exited with code '+code;}
 await context?.close().catch(()=>{});await browser?.close().catch(()=>{});
}
const video=frames>0&&!encoderError&&await stat(cfg.outDir+'/recording.mp4').then(s=>s.size>1000).catch(()=>false);
const recordingWarning=video?undefined:'No video recording was saved: '+(/ENOENT|spawn ffmpeg/.test(encoderError)?'ffmpeg is not installed on the LFG server.':(encoderError||recordError||'the browser produced no frames.').slice(0,500));
emit({type:'result',passed,failure,failedStep,snapshot,failureScreenshot,results,video,recordingWarning,pageErrors:pageErrors.length?pageErrors.slice(0,20):undefined});
