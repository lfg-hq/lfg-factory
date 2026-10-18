// Small live compatibility check. Credentials stay server-side and are never logged.
import {chromium} from 'playwright-core';
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {File} from 'node:buffer';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const match=readFileSync('.env.prod','utf8').match(/^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s#]+))/m);
const key=(match?.[1] || match?.[2] || match?.[3] || '').trim();
if(!key)throw new Error('No production environment key configured');
const dir=mkdtempSync(join(tmpdir(),'lfg-dictation-'));
let service;
try {const path=join(dir,'dictation.mjs');execFileSync('bun',['build','src/services/dictation.ts','--target=node','--outfile='+path],{stdio:'ignore'});service=await import(pathToFileURL(path));}
finally{rmSync(dir,{recursive:true,force:true});}
try {
 const text=await service.transcribeDictation(new File([readFileSync('/tmp/lfg-dictation-check.wav')],'sample.wav',{type:'audio/wav'}),key,AbortSignal.timeout(60000),{keywords:['API']});
 console.log(JSON.stringify({fileTranscription:true,text}));
} catch(e){console.log(JSON.stringify({fileTranscription:false,status:e.statusCode||null}));process.exitCode=1;}
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
try {
 const page=await browser.newPage();
 await page.route('https://dictation.test/**',async r=>{
  if(r.request().url().endsWith('/session')){
   try{const answer=await service.connectDictation(r.request().postData(),key,AbortSignal.timeout(25000),{keywords:['API']});return r.fulfill({body:answer});}
   catch(e){console.log(JSON.stringify({realtimeSession:false,status:e.statusCode||null}));return r.fulfill({status:502,body:'Provider connection failed'});}
  }
  return r.fulfill({body:'<html>Dictation transport check</html>',contentType:'text/html'});
 });
 await page.goto('https://dictation.test/');
 const result=await page.evaluate(async()=>{
  const peer=new RTCPeerConnection(),stream=await navigator.mediaDevices.getUserMedia({audio:true});
  stream.getTracks().forEach(t=>{t.enabled=false;peer.addTrack(t,stream);});
  const channel=peer.createDataChannel('dictation-events');
  let settle;const ready=new Promise(r=>settle=r);const timer=setTimeout(()=>settle({timeout:true}),35000);
  channel.onopen=()=>settle({channelOpen:true});
  channel.onmessage=e=>{const d=JSON.parse(e.data);if(d.type==='error')settle({error:d.error?.code});};
  try{const offer=await peer.createOffer();await peer.setLocalDescription(offer);
   const response=await fetch('/session',{method:'POST',body:offer.sdp});if(!response.ok)return {sessionFailed:true};
   await peer.setRemoteDescription({type:'answer',sdp:await response.text()});return await ready;
  }finally{clearTimeout(timer);peer.close();stream.getTracks().forEach(t=>t.stop());}
 });
 console.log(JSON.stringify(result));if(!result.channelOpen)process.exitCode=1;
}finally{await browser.close();}
