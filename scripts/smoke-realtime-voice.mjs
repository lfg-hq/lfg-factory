// Explicit opt-in live check. The API key stays in Node; Chrome gets only SDP.
import {chromium} from 'playwright-core';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const buildDir=mkdtempSync(join(tmpdir(),'lfg-voice-smoke-'));
let connectRealtimeVoice;
try {
 const entry=join(buildDir,'realtime.mjs');
 execFileSync('bun',['build','src/services/voice-realtime.ts','--target=node','--outfile='+entry],{stdio:'ignore'});
 ({connectRealtimeVoice}=await import(pathToFileURL(entry).href));
} finally {rmSync(buildDir,{recursive:true,force:true});}
if(!process.env.OPENAI_API_KEY)throw new Error('OPENAI_API_KEY is required');
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
try {
 const page=await browser.newPage();
 await page.route('https://voice.test/**',async route=>{
  if(route.request().url().endsWith('/session')){
   try {const answer=await connectRealtimeVoice(route.request().postData(),process.env.OPENAI_API_KEY.trim(),AbortSignal.timeout(25000));await route.fulfill({body:answer,contentType:'application/sdp'});}
   catch(error){console.log(JSON.stringify({stage:'session',status:error.statusCode||null,error:'Connection failed'}));await route.fulfill({status:502,body:'Connection failed'});}return;
  }
  await route.fulfill({contentType:'text/html',body:'<html><body>Voice transport check</body></html>'});
 });
 await page.goto('https://voice.test/');
 const result=await page.evaluate(async()=>{
  const pc=new RTCPeerConnection(),audio=new Audio();audio.autoplay=true;
  const stream=await navigator.mediaDevices.getUserMedia({audio:true});
  stream.getTracks().forEach(t=>{t.enabled=false;pc.addTrack(t,stream);});
  pc.ontrack=e=>{audio.srcObject=e.streams[0];audio.play().catch(()=>{});};
  const channel=pc.createDataChannel('oai-events');
  let resolve;const done=new Promise(r=>resolve=r),seen=[];
  pc.onconnectionstatechange=()=>seen.push('peer:'+pc.connectionState);
  pc.oniceconnectionstatechange=()=>seen.push('ice:'+pc.iceConnectionState);
  channel.onerror=()=>seen.push('channel:error');
  channel.onclose=()=>seen.push('channel:closed');
  const timer=setTimeout(()=>resolve({timeout:true,events:seen}),45000);
  channel.onmessage=e=>{const d=JSON.parse(e.data);if(!seen.includes(d.type))seen.push(d.type);if(d.type==='error')resolve({errorCode:d.error?.code,events:seen});if(d.type==='output_audio_buffer.stopped')resolve({audioCompleted:true,events:seen});};
  channel.onopen=()=>{
   seen.push('channel:open');
   channel.send(JSON.stringify({type:'conversation.item.create',item:{type:'message',role:'user',content:[{type:'input_text',text:'Say only: The live voice connection works.'}]}}));
   channel.send(JSON.stringify({type:'response.create'}));
  };
  try {
   const offer=await pc.createOffer();await pc.setLocalDescription(offer);
   const r=await fetch('/session',{method:'POST',body:offer.sdp});if(!r.ok)return {sessionStatus:r.status};
   await pc.setRemoteDescription({type:'answer',sdp:await r.text()});
   const outcome=await done;let audioBytes=0;for(const stat of (await pc.getStats()).values())if(stat.type==='inbound-rtp'&&stat.kind==='audio')audioBytes+=stat.bytesReceived||0;
   return {...outcome,audioBytes};
  }finally{clearTimeout(timer);channel.close();pc.close();stream.getTracks().forEach(t=>t.stop());audio.srcObject=null;}
 });
 console.log(JSON.stringify(result));
 if(!result.audioCompleted || !result.audioBytes)process.exitCode=1;
}finally{await browser.close();}
