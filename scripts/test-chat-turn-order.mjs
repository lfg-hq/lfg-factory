import {chromium} from 'playwright-core';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const source=readFileSync('public/js/chat.js','utf8');
const block=source.slice(source.indexOf("            if (data.type === 'message_started')"),source.indexOf("            if (data.type === 'background_resume')"));
assert.ok(source.includes('showStopButton(!opts.renderOnStart)'));
assert.ok(source.includes("if (showActivity && !activeTrail) trailStep({ detail: 'Checking…'"));
assert.ok(!source.includes('Waiting for the agent'));
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage();await page.setContent('<div id="messages"><div id="previous">Previous response</div><div id="trail">Working</div></div>');
 await page.addScriptTag({content:`let currentStreamingEl=null,stopRequested=false;let activeTrail=document.getElementById('trail');const messageContainer=document.getElementById('messages');const showStopButton=()=>{};function addMessageToChat(role,text){const el=document.createElement('div');el.className=role;el.textContent=text;messageContainer.append(el);return el;}window.receive=data=>{${block}};`});
 await page.evaluate(()=>window.receive({type:'message_started',render_on_start:true,message:'Reset my preview password'}));
 assert.deepEqual(await page.locator('#messages > div').allTextContents(),['Previous response','Reset my preview password','Working']);
 await page.evaluate(()=>{activeTrail=null;window.receive({type:'message_started',render_on_start:true,message:'Next turn'});});
 assert.deepEqual(await page.locator('#messages > div').allTextContents(),['Previous response','Reset my preview password','Working','Next turn']);
 console.log('PASS: acknowledged prompt precedes its provisional activity indicator; earlier turns stay in place');
}finally{await browser.close();}
