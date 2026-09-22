import {chromium} from 'playwright-core';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
const app=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<label>Team<input aria-label="Team"></label><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save</button><output role="status"></output>');});
await new Promise(r=>app.listen(0,'127.0.0.1',r));
const chrome=spawn(process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--remote-debugging-port=0','--no-first-run','--user-data-dir='+await mkdtemp(tmpdir()+'/feature-chrome-')],{stdio:['ignore','ignore','pipe']});
let buffer='';const ws=await new Promise((resolve,reject)=>{chrome.stderr.on('data',d=>{buffer+=d;const match=buffer.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match)resolve(match[1])});chrome.on('error',reject)});
try{
 for(const expected of ['Engineering','Deliberate mismatch','Interrupted']){
 const outDir=await mkdtemp(tmpdir()+'/feature-video-');
 const child=spawn('node',['scripts/feature-browser-worker.mjs'],{stdio:['pipe','pipe','inherit']});let out='';let interrupted=false;child.stdout.on('data',d=>{out+=d;if(expected==='Interrupted'&&!interrupted&&out.includes('step-start')){interrupted=true;setTimeout(()=>child.kill('SIGTERM'),1500);}});
 child.stdin.end(JSON.stringify({wsEndpoint:ws,base:`http://127.0.0.1:${app.address().port}`,outDir,steps:[{label:'Open feature',action:'goto',path:'/'},{label:'Name team',action:'fill',locator:{label:'Team'},value:'Engineering'},{label:'Save team',action:'click',locator:{role:'button',name:'Save'}},{label:'Confirm saved team',action:'assertText',locator:{role:'status'},value:expected}]}));
 await new Promise(r=>child.on('close',r));const result=JSON.parse(out.trim().split('\n').at(-1));if(result.passed!==(expected==='Engineering'))throw Error(JSON.stringify(result));
 if((await stat(outDir+'/live.jpg')).size<100)throw Error('Live browser frame missing');
 const probe=spawn('ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',outDir+'/recording.mp4']);let duration='';probe.stdout.on('data',d=>duration+=d);await new Promise(r=>probe.on('close',r));if(!(Number(duration)>0))throw Error('Unplayable recording');
 console.log(JSON.stringify({expected,passed:result.passed,seconds:Number(duration),recording:outDir+'/recording.mp4'}));
 }
}finally{chrome.kill();app.close()}
