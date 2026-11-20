/** Feature testing against real Mags infrastructure: a throwaway sandbox serves a tiny app,
 * the real ticket URL exposure, Mags browser session, recorder and evidence storage run
 * exactly as in a ticket. Only the AI agent is replaced by the scripted commands below.
 * Run: set -a; source .env; set +a; SANDBOX_BACKEND=mags bun scripts/test-live-feature-mags.ts
 * (creates and deletes a VM; evidence goes to S3 or local storage, copies land in EVIDENCE_DIR;
 * APP_PORT picks the app port. SANDBOX_BACKEND=docker does not work yet: see the commit message.)
 */
import {mkdir,writeFile} from 'node:fs/promises';
import {newWorkspace,stopWorkspace,deleteWorkspace} from '../src/services/mags.ts';
import {validationShell} from '../src/services/validation-sandbox.ts';
import {LiveFeatureBrowser} from '../src/services/live-feature-browser.ts';
import {downloadBinary,isS3Enabled} from '../src/services/s3.ts';

const PORT=Number(process.env.APP_PORT||3000);
const name='lfg-ft-'+crypto.randomUUID().slice(0,8);
const ticketId='live-mags-'+crypto.randomUUID().slice(0,8);
const messages:string[]=[];
const assert=(ok:unknown,message:string,detail?:unknown)=>{if(!ok)throw Error(message+(detail!==undefined?': '+JSON.stringify(detail).slice(0,2000):''));console.log('ok -',message);};
// An unrelated script throws on load; the feature itself works.
const html=`<!doctype html><title>Team settings</title><script>setTimeout(()=>{throw new Error('analytics widget crashed')},50)</script>
<main><h1>Team settings</h1><label>Team <input aria-label="Team"></label> <button onclick="document.querySelector('output').textContent='Saved: '+document.querySelector('input').value">Save</button><p><output role="status"></output></p></main>`;
console.log('Creating sandbox',name);
const {jobId}=await newWorkspace(name,{noSync:true,idleMinutes:20});
const shell=(command:string)=>validationShell(name,command,60_000);
let browser:LiveFeatureBrowser|undefined;
try{
 const html64=Buffer.from(html).toString('base64');
 const up=await shell(`mkdir -p /data/app && echo ${html64} | base64 -d > /data/app/index.html && cd /data/app && (nohup python3 -m http.server ${PORT} --bind 0.0.0.0 >/tmp/app.log 2>&1 &) ; for i in $(seq 1 20); do curl -sf http://127.0.0.1:${PORT}/ >/dev/null && echo UP && break; sleep 0.5; done`);
 assert(up.output.includes('UP'),'the ticket app is running in the sandbox',up.output);
 browser=new LiveFeatureBrowser({workspaceId:name,ticketId,shell,progress:async m=>{messages.push(m);console.log('  progress:',m.split('\n')[0].slice(0,160));},redact:s=>s});
 const started=await browser.command({action:'start',appUrl:`http://localhost:${PORT}/`,checks:['Team is saved','Saved team shows Design']});
 assert(started.passed!==false,'the Mags browser opened the app',started);
 const miss=await browser.command({action:'click',locator:{role:'button',name:'Submit'},label:'Save (guessed name)'});
 assert(miss.passed===false&&!miss.attemptEnded&&miss.screenshotPath,'a wrong locator keeps the attempt open and returns a screenshot',miss);
 const seen=await shell(`stat -c %s ${miss.screenshotPath}`);
 assert(Number(seen.output.trim())>1000,'the screenshot was copied into the sandbox for the agent',seen.output);
 await browser.command({action:'fill',locator:{label:'Team'},value:'Platform',label:'Enter team',checkLabel:'Team is saved'});
 await browser.command({action:'click',locator:{role:'button',name:'Save'},label:'Save',checkLabel:'Team is saved'});
 const look=await browser.command({action:'screenshot',label:'Look at the saved form'});
 assert(look.passed!==false&&look.screenshotPath,'screenshot action works on the remote browser',look);
 const ok=await browser.command({action:'assertText',locator:{role:'status'},value:'Saved: Platform',label:'Team is saved',checkLabel:'Team is saved'});
 assert(ok.passed,'a correct assertion passes despite the page error',ok);
 const bad=await browser.command({action:'assertText',locator:{role:'status'},value:'Saved: Design',label:'Saved team shows Design',checkLabel:'Saved team shows Design'});
 assert(bad.passed===false&&bad.attemptEnded&&bad.failedStep?.actual==='Saved: Platform','a deliberate wrong expectation fails with the observed value',bad);
 const report=messages.find(m=>m.startsWith('**Feature testing failed.**'))||'';
 console.log('\n----- report shown in the ticket chat -----\n'+report+'\n-------------------------------------------\n');
 assert(report.includes('Failed at **Saved team shows Design**')&&report.includes('Observed: Saved: Platform'),'the report pinpoints the failing step',report);
 const base=report.match(/\((\/uploads\/ticket-tests\/[^)]+?)\/(?:recording\.mp4|failure\.jpg|step-\d+\.jpg)\)/)?.[1];
 assert(base,'the report links stored evidence',report);
 // Evidence is complete once the attempt is closed and the recording uploaded.
 await browser.close();browser=undefined;
 const out=process.env.EVIDENCE_DIR||'/tmp/lfg-live-evidence';await mkdir(out,{recursive:true});
 const get=async(n:string)=>{const {body}=await downloadBinary(base!.slice('/uploads/'.length)+'/'+n);if(body.length)await writeFile(out+'/'+n,body);return body;};
 const status=JSON.parse((await get('status.json')).toString()||'{}');
 console.log('Evidence store:',isS3Enabled?'S3':'local storage','| status.json:',JSON.stringify({status:status.status,checks:status.checks?.map((c:any)=>({label:c.label,status:c.status,screenshot:!!c.screenshot})),failureScreenshot:status.failureScreenshot,warnings:status.warnings,video:status.video},null,1));
 assert(status.status==='failed'&&status.checks?.find((c:any)=>c.label==='Team is saved')?.screenshot,'status.json carries per-check screenshots',status);
 assert((await get('failure.jpg')).length>1000,'failure screenshot stored');
 const shot=status.checks.find((c:any)=>c.label==='Team is saved').screenshot.split('/').pop();
 assert((await get(shot)).length>1000,'passing check screenshot stored');
 const video=(await get('recording.mp4')).length;
 assert(video>1000||status.warnings?.some((w:string)=>/video/i.test(w)),'the recording is stored, or its absence is explained',{video,warnings:status.warnings});
 console.log('recording.mp4 bytes:',video,'| copies saved to',out);
 console.log('Live Mags feature test: all checks passed.');
}finally{
 await browser?.close().catch(()=>{});
 await stopWorkspace(jobId).catch(()=>{});await deleteWorkspace(name).catch(()=>{});
}
process.exit(0);
