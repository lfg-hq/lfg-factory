import {chromium} from 'playwright-core';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
// Lazy history: older pages load above the current history on scroll-up, keep the
// reader's place, and the bar disappears once everything is loaded.
const source=readFileSync('public/js/chat.js','utf8');
const block=source.slice(source.indexOf('    const HISTORY_PAGE = 20;'),source.indexOf('    // Function to load a specific conversation'));
assert.ok(block.includes('function installHistoryLoader'));
assert.ok(source.includes("`?limit=${HISTORY_PAGE}`"));
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:800,height:600}});
 await page.setContent('<div id="chat-messages" style="height:400px;overflow:auto"><div id="messages"></div></div>');
 await page.addScriptTag({content:`
  const chatMessages=document.getElementById('chat-messages'),messageContainer=document.getElementById('messages');
  let conversationLoadVersion=1;window.loadedAll=false;const loadConversation=(id,o)=>{window.loadedAll=o&&o.all;};
  const all=Array.from({length:45},(_,i)=>({id:'m'+i,content:'Message '+i}));
  window.fetch=async url=>{const u=new URL(url,'http://test.local');const before=u.searchParams.get('before');const end=before?all.findIndex(m=>m.id===before):all.length;
   const start=Math.max(0,end-20);return new Response(JSON.stringify({messages:all.slice(start,end),has_more:start>0}));};
  function renderHistoryMessages(list){list.forEach(m=>{const d=document.createElement('div');d.className='msg';d.style.height='60px';d.textContent=m.content;messageContainer.append(d);});return list.length;}
  ${block}
  renderHistoryMessages(all.slice(25));chatMessages.scrollTop=chatMessages.scrollHeight;
  installHistoryLoader('c','m25',1);`});
 await page.waitForTimeout(100);
 assert.equal(await page.locator('.msg').count(),20,'opens with only the newest page');
 await page.evaluate(()=>{chatMessages.scrollTop=0;});
 await page.waitForFunction(()=>document.querySelectorAll('.msg').length===40);
 const order=await page.locator('.msg').allTextContents();
 assert.equal(order[0],'Message 5');assert.equal(order[19],'Message 24');assert.equal(order[20],'Message 25');
 assert.ok(await page.evaluate(()=>chatMessages.scrollTop)>1000,'reader keeps their place instead of jumping to the top');
 await page.evaluate(()=>{chatMessages.scrollTop=0;});
 await page.waitForFunction(()=>document.querySelectorAll('.msg').length===45);
 assert.equal(await page.locator('.history-loader').count(),0,'bar disappears once everything is loaded');
 assert.equal((await page.locator('.msg').allTextContents())[0],'Message 0');
 await page.evaluate(()=>{renderHistoryMessages([]);installHistoryLoader('c','m25',1);document.querySelector('.history-jump').click();});
 assert.equal(await page.evaluate(()=>window.loadedAll),true,'Jump to first message loads the full history');
 console.log('PASS: lazy history loads older pages in place and jump-to-first loads everything');
}finally{await browser.close();}
