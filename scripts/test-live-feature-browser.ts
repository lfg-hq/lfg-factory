// LiveFeatureBrowser end to end against local Chrome: the agent receives screenshots it can read,
// interaction misses keep the attempt open, and the user-facing report names the failing step.
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {LiveFeatureBrowser} from '../src/services/live-feature-browser.ts';

const html='<label>Team<input aria-label="Team"></label><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save</button><output role="status"></output>';
const app=createServer((_,res)=>{res.setHeader('Content-Type','text/html');res.end(html);});
await new Promise<void>(r=>app.listen(0,'127.0.0.1',()=>r()));
const port=(app.address() as {port:number}).port;
const chrome=spawn(process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--remote-debugging-port=0','--no-first-run','--user-data-dir='+await mkdtemp(tmpdir()+'/live-chrome-')],{stdio:['ignore','ignore','pipe']});
let out='';const wsEndpoint=await new Promise<string>((resolve,reject)=>{chrome.stderr!.on('data',d=>{out+=d;const m=out.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m)resolve(m[1]!)});chrome.on('error',reject)});
// The "sandbox" is a temp directory standing in for /data.
const sandbox=await mkdtemp(tmpdir()+'/live-sandbox-');
const shell=async(command:string)=>new Promise<{exitCode:number;output:string}>(resolve=>{const c=spawn('bash',['-c',command.replaceAll('/data/',sandbox+'/')]);let o='';c.stdout.on('data',d=>o+=d);c.stderr.on('data',d=>o+=d);c.on('close',code=>resolve({exitCode:code??1,output:o}));});
const messages:string[]=[];
const artifactRoot=await mkdtemp(tmpdir()+'/live-artifacts-');
const browser=new LiveFeatureBrowser({workspaceId:'w',ticketId:'ticket-1',shell,progress:async m=>{messages.push(m);},redact:s=>s},
 {startBrowserSession:async()=>({requestId:'job',wsEndpoint,cdpHttpUrl:''}) as any,enableHttpAccess:async()=>`http://127.0.0.1:${port}/`,stopWorkspace:async()=>{}} as any,artifactRoot);
const assert=(ok:unknown,message:string,detail?:unknown)=>{if(!ok)throw Error(message+(detail!==undefined?': '+JSON.stringify(detail).slice(0,1500):''));console.log('ok -',message);};
try{
 await browser.command({action:'start',appUrl:`http://localhost:${port}/`,checks:['Team is saved','Saved team shows Design']});
 const miss=await browser.command({action:'click',locator:{role:'button',name:'Submit'},label:'Save (guessed)'});
 assert(miss.passed===false&&!miss.attemptEnded&&miss.screenshotPath,'a wrong locator keeps the attempt open and returns a screenshot',miss);
 assert((await stat(miss.screenshotPath.replace('/data/',sandbox+'/'))).size>1000,'the screenshot is readable in the sandbox');
 await browser.command({action:'fill',locator:{label:'Team'},value:'Platform',label:'Enter team',checkLabel:'Team is saved'});
 await browser.command({action:'click',locator:{role:'button',name:'Save'},label:'Save',checkLabel:'Team is saved'});
 const ok=await browser.command({action:'assertText',locator:{role:'status'},value:'Platform',label:'Team is saved',checkLabel:'Team is saved'});
 assert(ok.passed&&ok.screenshotPath,'a passing assertion returns its screenshot',ok);
 const bad=await browser.command({action:'assertText',locator:{role:'status'},value:'Design',label:'Saved team shows Design',checkLabel:'Saved team shows Design'});
 assert(bad.passed===false&&bad.attemptEnded&&bad.failedStep?.actual==='Platform'&&bad.screenshotPath,'a failed assertion ends the attempt with the observed value and a screenshot',bad);
 const report=messages.find(m=>m.startsWith('**Feature testing failed.**'))||'';
 assert(report.includes('Failed at **Saved team shows Design**')&&report.includes('Expected: Design')&&report.includes('Observed: Platform'),'the report pinpoints the failing step',report);
 assert(report.includes('1 of 2 checks confirmed')&&/\[screenshot\]\(\/uploads\/ticket-tests\/ticket-1\/[^)]+\/step-\d+\.jpg\)/.test(report),'the report lists checks with screenshots',report);
 assert(/\[Watch recording\]/.test(report)&&/\[Failure screenshot\]/.test(report),'the report links the recording and failure screenshot',report);
 assert(!report.includes('Accessible page'),'no page dump in the report');
 assert(browser.unconfirmed().includes('Saved team shows Design'),'the run failure names the unconfirmed check',browser.unconfirmed());
 const dir=report.match(/\(\/uploads\/ticket-tests\/ticket-1\/([^/]+)\//)![1];
 const status=JSON.parse(await readFile(`${artifactRoot}/uploads/ticket-tests/ticket-1/${dir}/status.json`,'utf8'));
 assert(status.status==='failed'&&status.failureScreenshot?.endsWith('/failure.jpg')&&status.checks.find((c:any)=>c.label==='Team is saved')?.screenshot,'status.json carries the screenshots the checklist shows',status);
 console.log('Live feature browser: all checks passed.');
}finally{await browser.close().catch(()=>{});chrome.kill();app.close();}
process.exit(0);
