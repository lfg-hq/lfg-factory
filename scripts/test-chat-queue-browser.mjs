import {chromium} from 'playwright-core';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const source=readFileSync('public/js/chat.js','utf8');
const queue=source.slice(source.indexOf('    function renderChatQueue('),source.indexOf('    // Function to create and show stop button'));
const buttons=source.slice(source.indexOf('    let turnActive = false;'),source.indexOf('    // Function to reset streaming state completely'));
const submit=source.slice(source.indexOf('    let composerSubmission ='),source.indexOf('    // Function to handle the actual WebSocket message sending'));
const composer=execFileSync('bun',['-e',`import {ChatInput} from './src/templates/components/chat-input.tsx';console.log(String(await ChatInput({placeholder:'Message',models:[],selectedModelKey:'Model'})));`],{encoding:'utf8'});
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 const page=await browser.newPage();
 for(const theme of ['light','dark'])for(const width of [390,900]) {
  await page.setViewportSize({width,height:800});
  await page.setContent(`<html data-theme="${theme}"><body><div class="chat-container"><div class="chat-messages"><div class="message-container">An agent is working</div></div>${composer}</div></body></html>`);
  for(const path of ['public/css/theme-variables.css','public/css/common.css','public/css/chat.css','public/css/polish.css','public/css/light/light-mode.css'])await page.addStyleTag({content:readFileSync(path,'utf8')});
  await page.addStyleTag({content:'body{margin:0;font-family:Arial}.chat-container{height:800px}.chat-input-container{width:100%;box-sizing:border-box}.settings-dropdown{display:none}'});
  await page.addScriptTag({content:`(()=>{
   const chatForm=document.getElementById('chat-form'),chatInput=document.getElementById('chat-input'),sendBtn=document.getElementById('send-btn'),messageContainer=document.querySelector('.message-container');
   let stopBtn=null,buttonTransitionTimeout=null,isStreaming=false,currentButtonState='send',activeTrail={};
   const ButtonState={SEND:'send',STOP:'stop',TRANSITIONING:'transitioning'};
   const trailStep=()=>{},finishMessageDisplay=()=>{};
   window.sent=[];const socket={readyState:1,send:text=>window.sent.push(JSON.parse(text))};const stopGeneration=()=>socket.send(JSON.stringify({type:'stop_generation'}));
   ${queue}${buttons}
   window.drawQueue=renderChatQueue;window.busy=showStopButton;window.idle=hideStopButton;
   let currentConversationId='chat',currentProjectId='project',conversationLoadVersion=0;
   const sendMessageToServer=(message,files,opts)=>window.sent.push({message,files,opts});
   window.attachedFiles=[];window.syncPrimaryAttachedFile=()=>{};
   ${submit}
   window.submitFollowup=sendMessage;
  })();`});
  await page.evaluate(()=>{window.busy();window.drawQueue([{id:'a',message:'Please use the existing ticket and preserve the environment settings.'},{id:'b',message:'Also check the mobile layout <img src=x>',files:[{name:'screenshot.png'}]}]);});
  await page.locator('#chat-input').fill('I can still type while this runs');
  assert.equal(await page.locator('#chat-input').isEnabled(),true);
  assert.equal(await page.locator('#send-btn').isVisible(),true);
  assert.equal(await page.locator('#stop-btn').isVisible(),true);
  const bounds=await page.evaluate(()=>{
   const q=document.getElementById('chat-followup-queue'),input=document.getElementById('chat-input-box');
   const send=document.getElementById('send-btn').getBoundingClientRect(),stop=document.getElementById('stop-btn').getBoundingClientRect();
   return {above:q.getBoundingClientRect().bottom<=input.getBoundingClientRect().top,overflow:q.scrollWidth>q.clientWidth,buttonsApart:send.right<=stop.left || stop.right<=send.left};
  });
  assert.ok(bounds.above,JSON.stringify(bounds));assert.equal(bounds.overflow,false);assert.ok(bounds.buttonsApart);
  assert.equal(await page.locator('#chat-followup-queue img').count(),0);
  await page.getByRole('button',{name:'Steer now',exact:true}).nth(1).click();
  assert.equal(await page.getByRole('button',{name:'Steering…',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Remove queued message',exact:true}).first().click();
  assert.deepEqual(await page.evaluate(()=>window.sent),[{type:'queue_steer',id:'b'},{type:'queue_remove',id:'a'}]);
  await page.screenshot({path:`/tmp/lfg-chat-queue-${theme}-${width}.png`});
  await page.evaluate(()=>{window.idle();window.idle();window.busy();window.idle();});
  assert.equal(await page.locator('#send-btn').count(),1);assert.equal(await page.locator('#send-btn').isVisible(),true);assert.equal(await page.locator('#stop-btn').count(),0);
  // Slow first upload must not let a second typed follow-up overtake it.
  await page.evaluate(async()=>{
   window.sent=[];let resolveUpload;
   const file={name:'spec.docx',uploadPromise:new Promise(resolve=>resolveUpload=resolve)};
   window.attachedFiles=[file];const first=window.submitFollowup('first');
   const second=window.submitFollowup('second');
   file.id='uploaded';resolveUpload();await Promise.all([first,second]);
  });
  const sent=await page.evaluate(()=>window.sent);
  assert.deepEqual(sent.map(x=>x.message),['first','second']);assert.equal(sent[0].files[0].id,'uploaded');assert.equal(sent[1].files.length,0);
 }
 console.log('PASS: editable composer, separate Send/Stop, compact queue, steering/removal, ordered attachments in both themes at 390/900px');
} finally {await browser.close();}
