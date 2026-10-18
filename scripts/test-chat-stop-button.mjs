import {chromium} from 'playwright-core';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const source=readFileSync('public/js/chat.js','utf8');
const code=source.slice(source.indexOf('    let turnActive = false;'),source.indexOf('    // Function to reset streaming state completely'));
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 const page=await browser.newPage();
 await page.setContent('<form><div class="input-actions"><button id="send">Send</button></div></form><div id="messages"></div>');
 await page.addScriptTag({content:`(()=>{const chatForm=document.querySelector('form'),sendBtn=document.getElementById('send'),messageContainer=document.getElementById('messages');const ButtonState={SEND:0,STOP:1,TRANSITIONING:2};let currentButtonState=0,stopBtn=null,buttonTransitionTimeout=null,isStreaming=false,activeTrail=true;const stopGeneration=()=>{},finishMessageDisplay=()=>{},trailStep=()=>{};${code};window.showStop=showStopButton;window.hideStop=hideStopButton;})();`});
 await page.evaluate(()=>showStop());assert.equal(await page.locator('#stop-btn').isVisible(),true);
 // A stale DOM/style must be repaired even when logical state already says STOP.
 await page.evaluate(()=>{document.getElementById('stop-btn').style.display='none';showStop();});
 assert.equal(await page.locator('#stop-btn').isVisible(),true);
 await page.evaluate(()=>{document.getElementById('stop-btn').remove();showStop();});
 assert.equal(await page.locator('.input-actions #stop-btn').count(),1);
 await page.evaluate(()=>hideStop());assert.equal(await page.locator('#send').isVisible(),true);
 await page.evaluate(()=>showStop());assert.equal(await page.locator('#stop-btn').isVisible(),true);
 console.log('PASS: stop survives hidden/detached DOM, completion, and subsequent turns');
} finally {await browser.close();}
