import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1000,height:700}});
 let calls=0,fail=false,transcriptionGate=null,sessionGate=null;
 await page.route('https://dictation.test/**',async r=>{
  const url=r.request().url();
  if(url.includes('/dictation/transcribe')){calls++;if(transcriptionGate)await transcriptionGate;return r.fulfill({status:fail?502:200,json:fail?{error:'Try again.'}:{text:'Hello, LFG. Please check the API.'}});}
  if(url.includes('/dictation/session')){if(sessionGate)await sessionGate;return r.fulfill({body:'v=0\r\nanswer'});}
  if(url.includes('/api/voice'))return r.fulfill({json:{natural:true}});
  return r.fulfill({contentType:'text/html',body:'<html data-theme="light"><body><form id="chat-form"><div class="input-wrapper"><div class="left-actions">Attachments</div><div id="chat-input-box"><textarea id="chat-input"></textarea></div><div class="input-actions"><button type="button" id="record-audio-btn">Record</button></div></div></form></body></html>'});
 });
 await page.goto('https://dictation.test/');await page.addStyleTag({path:'public/css/styles.css'});await page.addStyleTag({path:'public/css/theme-variables.css'});await page.addStyleTag({path:'public/css/chat.css'});await page.addStyleTag({path:'public/css/light/light-mode.css'});
 await page.evaluate(()=>{
  window.scope='one';window.stopped=0;window.micCalls=0;
  window.track={enabled:true,stop(){stopped++;}};
  Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{micCalls++;return {getTracks:()=>[track],getAudioTracks:()=>[track]};}}});
  window.MediaRecorder=class extends EventTarget {
   static isTypeSupported(){return true;}state='inactive';mimeType='audio/webm';
   start(){this.state='recording';}stop(){this.state='inactive';queueMicrotask(()=>{this.ondataavailable({data:new Blob(['audio'],{type:'audio/webm'})});this.dispatchEvent(new Event('stop'));this.onstop?.();});}
  };
  window.RTCPeerConnection=class{
   constructor(){window.peer=this;}addTrack(){}createDataChannel(){return this.channel={readyState:'connecting',send(){},close(){}};}
   async createOffer(){return {sdp:'v=0\r\no=dictation-test-session'};}async setLocalDescription(){}
   async setRemoteDescription(){this.channel.readyState='open';this.channel.onopen();}close(){this.closed=true;}
  };
  window.emit=data=>peer.channel.onmessage({data:JSON.stringify(data)});
 });
 await page.addScriptTag({path:'public/js/dictation.js'});
 await page.evaluate(()=>window.controller=createDictation({button:document.querySelector('#record-audio-btn'),input:document.querySelector('#chat-input'),wrapper:document.querySelector('.input-wrapper'),onSend:()=>{window.sentDraft=document.querySelector('#chat-input').value;window.explicitSends=(window.explicitSends||0)+1;},getScope:()=>scope,getContext:()=>({projectId:'236cef6d-5f35-4ae0-a179-e49682d0afdc',keywords:['LFG']})}));
 const start=async()=>{await page.click('#record-audio-btn');await page.waitForFunction(()=>document.querySelector('.dictation-status')?.textContent==='Listening…');};
 const speak=async()=>page.evaluate(()=>emit({type:'conversation.item.input_audio_transcription.delta',item_id:'a',delta:'hello <b>lfg</b>'}));
 await page.fill('#chat-input','Existing draft.');await start();await speak();
 assert.equal(await page.locator('.live-transcription').count(),0);assert.equal(await page.locator('.left-actions').isVisible(),false);
 assert.equal(await page.locator('#chat-input-box').isVisible(),true);
 assert.equal(await page.inputValue('#chat-input'),'Existing draft.');
 assert.equal(await page.locator('.audio-recording-indicator').evaluate(el=>el.getBoundingClientRect().height),40);
 await page.screenshot({animations:'disabled',path:'/tmp/lfg-openai-dictation-light.png'});
 await page.evaluate(()=>{document.documentElement.dataset.theme='dark';document.body.style.background='#16191f';});
 await page.setViewportSize({width:390,height:740});
 assert.equal(await page.locator('.dictation-waveform').isVisible(),true);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.screenshot({animations:'disabled',path:'/tmp/lfg-openai-dictation-dark-mobile.png'});
 await page.setViewportSize({width:1000,height:700});
 await page.getByRole('button',{name:'Stop dictation and keep text',exact:true}).click();
 await page.waitForFunction(()=>!controller.active);
 assert.equal(await page.inputValue('#chat-input'),'Existing draft. Hello, LFG. Please check the API.');assert.equal(calls,1);
 assert.equal(await page.locator('#chat-input').evaluate(el=>getComputedStyle(el).maskImage),'none');
 // Transcription failure retains recording for retry, not a new microphone session.
 fail=true;await start();await speak();await page.getByRole('button',{name:'Stop dictation and keep text',exact:true}).click();
 await page.getByRole('button',{name:'Retry transcription'}).waitFor({state:'visible'});
 assert.equal(await page.evaluate(()=>micCalls),2);
 fail=false;await page.getByRole('button',{name:'Retry transcription'}).click();await page.waitForFunction(()=>!controller.active);
 assert.equal(await page.evaluate(()=>micCalls),2);assert.equal(calls,3);
 // Enter intercepts the normal chat send handler, including while finalizing.
 await page.evaluate(()=>{
  window.sends=0;
  document.querySelector('#chat-input').addEventListener('keydown',e=>{
   if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sends++;}
  });
 });
 await page.fill('#chat-input','Keyboard draft.');await start();
 await page.focus('#chat-input');
 await page.keyboard.press('Shift+Enter');
 assert.equal(await page.evaluate(()=>controller.active),true);
 await page.locator('#chat-input').dispatchEvent('keydown',{key:'Enter',isComposing:true});
 assert.equal(await page.evaluate(()=>controller.active),true);
 await page.evaluate(()=>window.sends=0);
 let releaseTranscription;
 transcriptionGate=new Promise(resolve=>{releaseTranscription=resolve;});
 const keyboardRequests=calls;
 await page.keyboard.press('Enter');
 await page.waitForFunction(()=>document.querySelector('.audio-recording-indicator')?.dataset.phase==='finalizing');
 await page.keyboard.press('Enter');
 assert.equal(await page.evaluate(()=>sends),0);
 releaseTranscription();transcriptionGate=null,sessionGate=null;
 await page.waitForFunction(()=>!controller.active);
 assert.equal(calls,keyboardRequests+1);
 assert.match(await page.inputValue('#chat-input'),/Keyboard draft\.[\s]*Hello, LFG\. Please check the API\./);
 assert.equal(await page.evaluate(()=>sends),0);
 await page.keyboard.press('Enter');
 assert.equal(await page.evaluate(()=>sends),1);
 // Enter also works with focus on the recording controls; holding it cannot send the result.
 await start();
 await page.focus('.dictation-done');
 await page.keyboard.down('Enter');
 await page.waitForFunction(()=>!controller.active);
 await page.keyboard.down('Enter');
 assert.equal(await page.evaluate(()=>sends),1);
 await page.keyboard.up('Enter');
 // Cancel discards this recording without changing the existing editable draft or transcribing.
 const draft=await page.inputValue('#chat-input'), requests=calls;
 await start();await speak();await page.getByRole('button',{name:'Cancel dictation',exact:true}).click();
 assert.equal(await page.inputValue('#chat-input'),draft);assert.equal(calls,requests);
 assert.equal(await page.evaluate(()=>controller.active),false);
 // Navigation aborts without inserting into another conversation.
 await start();await page.evaluate(()=>document.querySelector('#chat-input').value='Other draft.');
 const before=await page.inputValue('#chat-input');
 await page.evaluate(()=>{scope='two';dispatchEvent(new Event('chat-conversation-changed'));});
 assert.equal(await page.evaluate(()=>controller.active),false);assert.equal(await page.inputValue('#chat-input'),before);
 // A slow remote handshake does not prevent recording, typing, or explicit Send.
 let releaseSession;sessionGate=new Promise(resolve=>releaseSession=resolve);
 await page.fill('#chat-input','Initial draft.');await start();
 await page.fill('#chat-input','Edited while recording.');
 await page.getByRole('button',{name:'Transcribe and send message',exact:true}).click();
 await page.waitForFunction(()=>window.explicitSends===1);
 assert.equal(await page.evaluate(()=>sentDraft),'Edited while recording. Hello, LFG. Please check the API.');
 assert.equal(await page.evaluate(()=>controller.active),false);
 releaseSession();sessionGate=null;
 // Late microphone permissions cannot resurrect a cancelled recording.
 await page.evaluate(()=>navigator.mediaDevices.getUserMedia=()=>new Promise(r=>window.lateResolve=r));
 await page.click('#record-audio-btn');await page.waitForFunction(()=>!!window.lateResolve);
 await page.getByRole('button',{name:'Cancel dictation',exact:true}).click();
 const count=await page.evaluate(()=>stopped);
 await page.evaluate(()=>lateResolve({getTracks:()=>[track],getAudioTracks:()=>[track]}));
 await page.waitForFunction(n=>stopped>n,count);assert.equal(await page.evaluate(()=>controller.active),false);
 console.log('PASS: OpenAI live preview, safe text, finalized editable draft, recording retry, navigation and late-microphone cleanup; slow connection does not block recording; explicit Send submits the complete edited draft.');
} finally {await browser.close();}
