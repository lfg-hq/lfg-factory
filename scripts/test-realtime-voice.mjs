import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 const page=await browser.newPage();
 let connections=0;
 await page.route('https://voice.test/**',r=>{
  if(r.request().url().includes('/api/voice/session')){connections++;return r.fulfill({body:'v=0\r\nanswer',contentType:'application/sdp'});}
  if(r.request().url().includes('/api/voice'))return r.fulfill({json:{natural:true}});
  return r.fulfill({contentType:'text/html',body:'<form id="chat-form"><div class="input-actions"><button id="record-audio-btn"></button></div></form>'});
 });
 await page.goto('https://voice.test/');
 await page.evaluate(()=>{
  window.sent=[];window.events=[];window.currentConversationId='one';window.busy=false;
  window.chatVoice={status:()=>({connected:true,recording:false,busy}),ready:()=>!busy,context:()=>[{role:'user',text:'Project context'}],send:text=>{sent.push(text);busy=true;return true;}};
  window.track={enabled:true,stopped:false,stop(){this.stopped=true;}};
  Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>({getTracks:()=>[track],getAudioTracks:()=>[track]})}});
  window.Audio=class{play(){return Promise.resolve();}pause(){}};
  window.RTCPeerConnection=class{
   constructor(){window.peer=this;this.connectionState='new';}
   addTrack(){} createDataChannel(){this.channel={readyState:'connecting',send:x=>events.push(JSON.parse(x)),close(){this.readyState='closed';this.onclose?.();}};return this.channel;}
   async createOffer(){return {sdp:'v=0\r\no=voice-test-session'};}async setLocalDescription(){}
   async setRemoteDescription(){this.channel.readyState='open';this.channel.onopen();}
   close(){this.connectionState='closed';}
  };
  window.emit=data=>peer.channel.onmessage({data:JSON.stringify(data)});
 });
 await page.addScriptTag({path:'public/js/voice-mode.js'});
 await page.click('#voice-mode-btn');
 await page.waitForFunction(()=>document.querySelector('[role="status"]').textContent==='Listening…');
 assert.equal(connections,1);assert.equal(await page.locator('select').count(),0);
 assert.equal(await page.evaluate(()=>events.filter(e=>e.type==='response.create').length),0,'silent startup');
 await page.evaluate(()=>{emit({type:'response.created'});emit({type:'response.done',response:{output:[{type:'function_call',name:'ask_project_agent',call_id:'call_1',arguments:'{"request":"Check project status"}'}]}});});
 assert.deepEqual(await page.evaluate(()=>sent),['Check project status']);
 await page.evaluate(()=>emit({type:'response.done',response:{output:[{type:'function_call',name:'ask_project_agent',call_id:'call_1',arguments:'{"request":"Check project status"}'}]}}));
 assert.equal(await page.evaluate(()=>sent.length),1);
 await page.evaluate(()=>{emit({type:'output_audio_buffer.started'});emit({type:'input_audio_buffer.speech_started'});emit({type:'output_audio_buffer.cleared'});});
 assert.equal(await page.evaluate(()=>busy),true,'interrupting speech must not stop agent work');
 await page.evaluate(()=>{emit({type:'input_audio_buffer.speech_stopped'});emit({type:'response.done',response:{output:[]}});busy=false;dispatchEvent(new CustomEvent('chat-voice-reply',{detail:{text:'Three tickets are complete.',reason:'complete'}}));});
 assert.equal(await page.evaluate(()=>events.filter(e=>e.item?.type==='function_call_output').length),1);
 assert.equal(await page.evaluate(()=>events.filter(e=>e.type==='response.create').length),1);
 await page.click('.voice-mute');assert.equal(await page.evaluate(()=>track.enabled),false);
 await page.click('.voice-mute');assert.equal(await page.evaluate(()=>track.enabled),true);
 await page.click('.voice-end');assert.equal(await page.evaluate(()=>track.stopped),true);
 assert.equal(await page.locator('.voice-session').isHidden(),true);
 await page.click('#voice-mode-btn');await page.waitForFunction(()=>document.querySelector('[role="status"]').textContent==='Listening…');
 await page.evaluate(()=>dispatchEvent(new PageTransitionEvent('pagehide')));
 assert.equal(await page.evaluate(()=>peer.connectionState),'closed');
 // Closing during microphone permission must release a late-arriving stream.
 await page.evaluate(()=>{window.lateResolve=null;navigator.mediaDevices.getUserMedia=()=>new Promise(r=>lateResolve=r);});
 await page.click('#voice-mode-btn');
 await page.click('.voice-end');
 await page.evaluate(()=>{track.stopped=false;lateResolve({getTracks:()=>[track],getAudioTracks:()=>[track]});});
 await page.waitForFunction(()=>track.stopped);
 assert.equal(await page.locator('.voice-session').isHidden(),true);
 // A fresh or disconnected chat should connect before requesting the microphone.
 await page.evaluate(()=>{
  window.chatReady=false;window.resolveChat=null;window.micRequests=0;
  chatVoice.status=()=>({connected:chatReady,recording:false});
  chatVoice.ensureConnected=({signal})=>new Promise(resolve=>{
   window.resolveChat=resolve;signal.addEventListener('abort',()=>resolve(false),{once:true});
  });
  navigator.mediaDevices.getUserMedia=async()=>{micRequests++;return {getTracks:()=>[track],getAudioTracks:()=>[track]};};
 });
 await page.click('#voice-mode-btn');
 assert.equal(await page.locator('[role="status"]').textContent(),'Connecting to chat…');
 assert.equal(await page.evaluate(()=>micRequests),0);
 await page.evaluate(()=>resolveChat(true));
 await page.waitForFunction(()=>document.querySelector('[role="status"]').textContent==='Listening…');
 assert.equal(await page.evaluate(()=>micRequests),1);
 await page.click('.voice-end');
 await page.click('#voice-mode-btn');await page.click('.voice-end');
 await page.evaluate(()=>resolveChat(true));
 assert.equal(await page.evaluate(()=>micRequests),1,'cancel during chat connection must not start microphone');
 await page.click('#voice-mode-btn');await page.evaluate(()=>resolveChat(false));
 await page.waitForFunction(()=>document.querySelector('[role="status"]').textContent.includes('Could not connect to chat'));
 assert.equal(await page.evaluate(()=>micRequests),1,'failed chat must not start microphone');
 await page.reload();await page.addScriptTag({path:'public/js/voice-mode.js'});
 assert.equal(await page.locator('.voice-session').isHidden(),true);
 assert.equal(await page.locator('#voice-mode-btn').getAttribute('aria-pressed'),'false');
 console.log('PASS: silent startup, Realtime delegation, duplicate-call protection, interruption preserves work, result handoff, mute/end, refresh cleanup.');
} finally {await browser.close();}
