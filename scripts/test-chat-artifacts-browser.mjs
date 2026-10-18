import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const browser = await chromium.launch({channel:'chrome',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1024,height:900}});
 const failures=[];page.on('pageerror',e=>failures.push(e.message));
 let failDoc=false;
 await page.route('http://artifact.test/**',route=>{
  const url=route.request().url();
  if(url.endsWith('/content'))return route.fulfill({status:failDoc?404:200,json:{content:'# Requirements\n\nSaved content <script>window.pwned=true</script> <img src=x onerror=alert(1)>'}});
  if(url.includes('/tickets/'))return route.fulfill({json:{ticket:{id:'t2',ticketKey:'REC-2',name:'Consent',description:'Capture consent',acceptanceCriteria:'Explicit consent required',dependencies:['t1'],status:'backlog'}}});
  return route.fulfill({contentType:'text/html',body:'<div id="messages"></div>'});
 });
 await page.goto('http://artifact.test/');
 await page.addStyleTag({content:readFileSync('public/css/theme-variables.css','utf8')+readFileSync('public/css/chat-artifacts.css','utf8')});
 // Use the actual installed Markdown parser, without a network dependency.
 await page.addScriptTag({path:'node_modules/marked/lib/marked.umd.js'});
 await page.addScriptTag({path:'public/js/chat-artifacts.js'});
 await page.evaluate(()=>{
  const c=document.querySelector('#messages');
  ChatArtifacts.stream(c,{tool_call_id:'doc1',file_name:'Requirements',content_chunk:'# Draft\n'},'p');
  ChatArtifacts.stream(c,{tool_call_id:'doc1',content_chunk:'Live words'},'p');
 });
 assert.equal(await page.locator('.chat-artifact-card').count(),1);
 assert.match(await page.locator('.ca-excerpt').innerText(),/Live words/);
 // A streamed update between pointer-down and pointer-up must not swallow Expand.
 const expand=page.getByRole('button',{name:'Expand ↗',exact:true});
 await expand.hover();await page.mouse.down();
 await page.evaluate(()=>ChatArtifacts.stream(document.querySelector('#messages'),{tool_call_id:'doc1',content_chunk:' more'},'p'));
 await page.mouse.up();
 await page.evaluate(()=>ChatArtifacts.stream(document.querySelector('#messages'),{tool_call_id:'doc1',content_chunk:' updated'},'p'));
 assert.match(await page.locator('dialog').innerText(),/updated/);
 await page.keyboard.press('Escape');
 await page.evaluate(()=>ChatArtifacts.render(document.querySelector('#messages'),{kind:'document',id:'d1',name:'Requirements'},'p',{callId:'doc1'}));
 await page.waitForFunction(()=>document.querySelector('.ca-excerpt').textContent.includes('Saved content'));
 assert.equal(await page.locator('.chat-artifact-card').count(),1);
 assert.equal(await page.locator('.ca-excerpt script,.ca-excerpt img').count(),0);
 assert.equal(await page.evaluate(()=>window.pwned),undefined);
 await page.evaluate(()=>ChatArtifacts.render(document.querySelector('#messages'),{kind:'document',id:'d1',name:'Requirements'},'p',{replay:true}));
 assert.equal(await page.locator('.chat-artifact-card').count(),1);
 // Saved documents reopen repeatedly and the sidebar action selects the exact file.
 for(let i=0;i<3;i++){
  await page.getByRole('button',{name:'Expand ↗',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('dialog')?.textContent.includes('Saved content'));
  await page.getByRole('button',{name:'Back to chat'}).click();
  await page.locator('dialog').waitFor({state:'detached'});
 }
 await page.evaluate(()=>window.viewFileContent=(id,name)=>window.openedFile={id,name});
 await page.getByRole('button',{name:'View in sidebar',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>openedFile),{id:'d1',name:'Requirements'});
 await page.evaluate(()=>{
  const c=document.querySelector('#messages');ChatArtifacts.stream(c,{tool_call_id:'interrupted',content_chunk:'Unfinished'},'p');ChatArtifacts.finish(c);
  ChatArtifacts.render(c,{kind:'tickets',id:'batch1',name:'Recruiting',tickets:Array.from({length:12},(_,i)=>({id:'t'+(i+1),ticketKey:'REC-'+(i+1),name:i===1?'Consent':'Ticket '+(i+1)}))},'p');
 });
 assert.match(await page.locator('[data-call-id="interrupted"]').innerText(),/Interrupted · draft not saved/);
 assert.equal(await page.locator('.chat-artifact-card .ca-ticket-row').count(),3);
 await page.getByRole('button',{name:'View all 12 ↗'}).click();
 assert.equal(await page.locator('dialog .ca-ticket-row').count(),12);
 await page.locator('dialog .ca-ticket-row').nth(1).click();
 await page.waitForFunction(()=>document.querySelector('dialog').textContent.includes('Explicit consent required'));
 assert.match(await page.locator('dialog').innerText(),/REC-1/);
 await page.getByRole('button',{name:'Back to chat'}).click();
 await page.getByRole('button',{name:'Collapse ticket preview'}).click();
 assert.equal(await page.locator('.chat-artifact-card .ca-ticket-row:visible').count(),0);
 await page.getByRole('button',{name:'Show ticket preview'}).click();
 failDoc=true;await page.getByRole('button',{name:'Expand ↗',exact:true}).first().click();
 await page.getByRole('button',{name:'Retry'}).waitFor();failDoc=false;await page.getByRole('button',{name:'Retry'}).click();
 await page.waitForFunction(()=>document.querySelector('dialog').textContent.includes('Saved content'));await page.keyboard.press('Escape');
 for(const theme of ['light','dark']){
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  for(const width of [375,1024]){
   await page.setViewportSize({width,height:900});
   assert.equal(await page.locator('.chat-artifact-card').first().evaluate(e=>e.scrollWidth>e.clientWidth),false);
  }
 }
 await page.screenshot({path:"/tmp/lfg-inline-artifacts-dark.png",fullPage:true});
 assert.deepEqual(failures,[]);
 console.log('PASS: streamed draft, saved/replayed reference, sanitized Markdown, live expanded draft, interrupted state, 12-ticket group, dependencies, collapse, retry, mobile and themes');
} finally {await browser.close();}
