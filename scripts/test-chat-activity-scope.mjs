import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 const page=await browser.newPage();
 await page.setContent('<body data-project-id="project"><div id="chat-ticket-activity"></div></body>');
 await page.evaluate(()=>{
  window.currentConversationId='old';
  window.fetch=async()=>({ok:true,json:async()=>({tickets:[{id:'ticket',name:'Old ticket',activityConversationId:'old',queueStatus:'stopping'}]})});
 });
 await page.addScriptTag({path:'public/js/ticket-activity.js'});
 await page.waitForSelector('.chat-ticket-activity-card');
 await page.evaluate(()=>{window.currentConversationId=null;window.dispatchEvent(new Event('chat-conversation-changed'));});
 assert.equal(await page.locator('.chat-ticket-activity-card').count(),0);
 await page.evaluate(()=>{window.currentConversationId='new';window.dispatchEvent(new Event('chat-conversation-changed'));});
 await page.waitForTimeout(100);
 assert.equal(await page.locator('.chat-ticket-activity-card').count(),0);
 // A late request from an old chat must not repopulate a newly opened chat.
 await page.evaluate(()=>{
  window.fetch=()=>new Promise(resolve=>window.releaseOld=()=>resolve({ok:true,json:async()=>({tickets:[{id:'ticket',name:'Old ticket',activityConversationId:'old',agentBusy:true}]})}));
  window.currentConversationId='old';window.dispatchEvent(new Event('chat-conversation-changed'));
 });
 await page.evaluate(()=>{window.currentConversationId=null;window.dispatchEvent(new Event('chat-conversation-changed'));window.releaseOld();});
 await page.waitForTimeout(100);
 assert.equal(await page.locator('.chat-ticket-activity-card').count(),0);
 console.log('PASS: old ticket activity and late responses cannot populate a new chat');
} finally {await browser.close();}
