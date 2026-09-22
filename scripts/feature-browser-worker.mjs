import {matchesBrowserText} from './browser-text-match.mjs';
/* Node owns CDP and ffmpeg. Frames are captured locally so remote CDP video paths are never assumed local. */
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
const results=[];let passed=false,failure='',cancelled=false;
process.on('SIGTERM',()=>{cancelled=true;void page?.close().catch(()=>{});});
const publishFrame=async frame=>{await writeFile(cfg.outDir+'/live.tmp',frame);await rename(cfg.outDir+'/live.tmp',cfg.outDir+'/live.jpg');};
const locator=(p,s)=>s.role?p.getByRole(s.role,{name:s.name,exact:true}):s.label?p.getByLabel(s.label,{exact:true}):s.text?p.getByText(s.text,{exact:true}):p.locator(s.selector);
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
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 encoder=spawn('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','image2pipe','-framerate','2','-vcodec','mjpeg','-i','pipe:0','-an','-c:v','libx264','-pix_fmt','yuv420p','-movflags','frag_keyframe+empty_moov+default_base_moof',cfg.outDir+'/recording.mp4'],{stdio:['pipe','ignore','pipe']});
 encoder.on('error',e=>{encoderError=e.message;});encoder.stdin.on('error',e=>{encoderError=e.message;});encoder.stderr.on('data',d=>{encoderError+=d.toString().slice(0,1000);});
 recording=true;
 capture=(async()=>{while(recording){try{const frame=await screenshot({type:'jpeg',quality:65,timeout:5000});if(!encoder.stdin.write(frame))await once(encoder.stdin,'drain');frames++;await publishFrame(frame);recordError='';}catch(e){recordError=e.message;if(encoderError)break;}await new Promise(r=>setTimeout(r,500));}})();
 emit({type:'ready'});
 let i=-1;for await(const step of steps()){
  i++;
  if(cancelled)throw Error('Browser test cancelled');
  const evidence={checkLabel:step.checkLabel,assertion:step.action.startsWith('assert'),action:step.action,target:step.locator?.name||step.locator?.label||step.locator?.text||step.locator?.selector||'',expected:step.action==='assertVisible'?'Visible':step.action.startsWith('assert')?String(step.value??''):''};
  let actual='';emit({type:'step-start',label:step.label,index:i+1,total:cfg.steps?.length});
  try{
   if(step.action==='snapshot'){actual=await page.locator('body').ariaSnapshot({timeout:15000});}
   else if(step.action==='goto'){const url=new URL(step.path,cfg.base);if(url.origin!==origin)throw Error('Off-origin navigation refused');const r=await page.goto(url.href,{waitUntil:'domcontentloaded',timeout:15000});if(!r||r.status()>=400)throw Error('Navigation HTTP '+r?.status());actual='HTTP '+r.status();}
   else{const target=locator(page,step.locator);switch(step.action){
    case 'click':await target.click();break;
    case 'fill':await target.fill(step.value);break;
    case 'select':await target.selectOption(step.value);break;
    case 'press':await target.press(step.value);break;
    case 'assertVisible':await target.waitFor({state:'visible'});actual='Visible';break;
    case 'assertText':{await target.waitFor({state:'visible'});const until=Date.now()+8000;do{actual=await target.innerText();if(matchesBrowserText(actual,step.value,step.ignoreCase))break;await new Promise(r=>setTimeout(r,200));}while(Date.now()<until);if(!matchesBrowserText(actual,step.value,step.ignoreCase))throw Error('Expected text '+JSON.stringify(step.value)+'; got '+JSON.stringify(actual.slice(0,500)));break;}
    case 'assertValue':actual=await target.inputValue();if(actual!==step.value)throw Error('Expected value mismatch');break;
    default:throw Error('Unsupported step');
   }}
   if(errors.length)throw Error('Page error: '+errors.join('; ').slice(0,1200));
   if(step.action.startsWith('assert'))await screenshot({path:cfg.outDir+`/step-${i}.jpg`,type:'jpeg',quality:70});
   const frame=await screenshot({type:'jpeg',quality:65,timeout:5000});if(!encoder.stdin.write(frame))await once(encoder.stdin,'drain');frames++;
   results.push({label:step.label,passed:true,...evidence,actual:actual.slice(0,1000)});emit({type:'step',id:step.id,label:step.label,passed:true,...evidence,actual:actual.slice(0,1000),snapshot:cfg.interactive?(await page.locator('body').ariaSnapshot({timeout:15000})).slice(0,12000):undefined});
  }catch(e){results.push({label:step.label,passed:false,...evidence,actual:actual.slice(0,1000),error:e.message.slice(0,2000)});throw e;}
 }
 if(cfg.interactive&&!results.some(r=>r.assertion))throw Error('No browser outcome assertion was executed');
 passed=!cancelled;
 await new Promise(r=>setTimeout(r,600));
}catch(e){failure=!page && /certificate|local issuer|CERT_/i.test(e.message)?'Mags browser TLS certificate verification failed: the recorder could not verify the certificate issuer. No browser frames were captured.':e.message; if(page){await screenshot({path:cfg.outDir+'/failure.jpg',type:'jpeg',quality:65,timeout:5000}).catch(()=>{});try{failure+='\nAccessible page: '+(await page.locator('body').ariaSnapshot({timeout:15000})).slice(0,10000);}catch{}}}
finally{
 recording=false;await capture?.catch(()=>{});
 if(encoder){encoder.stdin.end();let endTimer;const code=await Promise.race([new Promise(resolve=>encoder.exitCode!==null?resolve(encoder.exitCode):encoder.once('close',resolve)),new Promise(resolve=>{endTimer=setTimeout(()=>{encoder.kill('SIGKILL');resolve(-1)},10000)})]);clearTimeout(endTimer);if(code!==0||frames<1){passed=false;failure+='\nVideo encoding failed: '+encoderError;}}
 await context?.close().catch(()=>{});await browser?.close().catch(()=>{});
}
const video=await stat(cfg.outDir+'/recording.mp4').then(s=>s.size>0).catch(()=>false);
if(!video||recordError){passed=false;failure+='\nRecording incomplete: '+recordError;}
emit({type:'result',passed,failure,results,video});
