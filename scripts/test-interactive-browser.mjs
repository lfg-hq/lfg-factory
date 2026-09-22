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
 const outDir=await mkdtemp(tmpdir()+'/interactive-video-');
 const child=spawn('node',['scripts/feature-browser-worker.mjs'],{stdio:['pipe','pipe','inherit']});
 let buffer='';const queued=[];let waiter;
 child.stdout.on('data',d=>{buffer+=d;let p;while((p=buffer.indexOf('\n'))>=0){const e=JSON.parse(buffer.slice(0,p));buffer=buffer.slice(p+1);if(['ready','step','result'].includes(e.type)){if(waiter){const w=waiter;waiter=null;w(e)}else queued.push(e)}}});
 const next=()=>queued.length?Promise.resolve(queued.shift()):new Promise(r=>waiter=r);
 const send=async cmd=>{child.stdin.write(JSON.stringify(cmd)+'\n');return next();};
 await send({interactive:true,wsEndpoint:ws,base:`http://127.0.0.1:${app.address().port}`,outDir});
 const page=await send({action:'goto',path:'/',label:'Open app'});
 if(!page.snapshot.includes('Save'))throw Error('Real snapshot missing');
 await send({action:'fill',locator:{label:'Team'},value:'Interactive team',label:'Fill team'});
 await send({action:'click',locator:{role:'button',name:'Save'},label:'Save'});
 const assertion=await send({action:'assertText',locator:{role:'status'},value:'Interactive team',label:'Verify saved team'});
 if(!assertion.passed)throw Error('Assertion failed');
 const result=await send({action:'finish'});child.stdin.end();
 if(!result.passed||!result.video)throw Error(JSON.stringify(result));
 await new Promise(r=>child.on('close',r));
 console.log('Interactive browser: real snapshots, fill, click, assertion, finish and recording passed.');
}finally{chrome.kill();app.close()}
