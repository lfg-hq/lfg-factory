import {chromium} from 'playwright-core';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const source=readFileSync('public/js/chat.js','utf8');
const scrollCode=source.slice(source.indexOf('    // Smart scroll management'),source.indexOf('    // Function to handle tool progress updates'));
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 const page=await browser.newPage();
 await page.setContent('<div id="chat-messages" tabindex="0" style="height:300px;overflow:auto;overflow-anchor:none"><div id="message-container" style="height:1200px"></div></div>');
 await page.addScriptTag({content:`(()=>{const chatMessages=document.getElementById('chat-messages'),messageContainer=document.getElementById('message-container');${scrollCode};window.follow=scrollToBottom;window.grow=()=>{messageContainer.style.height=(messageContainer.offsetHeight+20)+'px';scrollToBottom();};scrollToBottom(true);})();`});
 const top=()=>page.locator('#chat-messages').evaluate(el=>el.scrollTop);
 const frame=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 await frame();
 const initial=await top();
 await page.evaluate(()=>{follow();const el=document.getElementById('chat-messages');el.dispatchEvent(new WheelEvent('wheel',{deltaY:-10}));el.scrollTop-=10;grow();});
 await frame();assert.equal(await top(),initial-10,'A small upward scroll cancels the pending follow frame');
 for(let i=0;i<10;i++) {await page.evaluate(()=>grow());await frame();}
 assert.equal(await top(),initial-10,'Incoming chunks preserve reading position');
 await page.evaluate(()=>{const el=document.getElementById('chat-messages');el.dispatchEvent(new WheelEvent('wheel',{deltaY:300}));el.scrollTop=el.scrollHeight;});
 await frame();await page.evaluate(()=>grow());await frame();
 assert.equal(await page.locator('#chat-messages').evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight),0,'Following resumes at bottom');
 await page.evaluate(()=>{const el=document.getElementById('chat-messages');el.dispatchEvent(new KeyboardEvent('keydown',{key:'PageUp',bubbles:true}));el.scrollTop-=100;grow();});
 await frame();const keyboardTop=await top();await page.evaluate(()=>grow());await frame();assert.equal(await top(),keyboardTop);
 await page.evaluate(()=>follow(true));await frame();
 assert.equal(await page.locator('#chat-messages').evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight),0,'Explicit send/history reset resumes following');
 // Exercise the actual ticket refresh handler with settings arriving after tab rendering.
 const ticketSource=readFileSync('public/js/ticket-agent.js','utf8');
 const refresh=ticketSource.slice(ticketSource.indexOf('  async function refreshTicketState()'),ticketSource.indexOf("  window.addEventListener('focus'"));
 const result=await page.evaluate(async code=>{
  let ticketId='ticket',curMeta={},currentLogRows=[{message:'history'}],rendered;
  const PID=()=> 'project',setBuildUI=()=>{},renderAll=rows=>{rendered={rows,meta:curMeta};};
  const fetch=async()=>({ok:true,json:async()=>({ticket:{validationEnabled:false,featureTestingEnabled:false}})});
  await eval('(async()=>{'+code+';await refreshTicketState();})()');return rendered;
 },refresh);
 assert.equal(result.meta.validationEnabled,false);assert.equal(result.meta.featureTestingEnabled,false);assert.equal(result.rows[0].message,'history');
 console.log('PASS: small scroll during queued frame, streaming position, bottom resume, keyboard, explicit reset, delayed ticket settings redraw');
} finally {await browser.close();}
