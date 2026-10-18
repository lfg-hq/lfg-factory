import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let posts=[];
 const nodes=[{id:'external:n',name:'Customer research',kind:'external',url:'https://example.com/research'},{id:'upload:u',name:'Workshop notes.docx',kind:'upload'},{id:'document:d',name:'Checkout requirements',kind:'document'},{id:'epic:e',name:'Faster checkout',kind:'epic'},{id:'ticket:t',name:'Implement saved cards',kind:'ticket'},{id:'document:x',name:'<img src=x onerror=alert(1)>',kind:'document'}];
 const edges=[{source:'external:n',target:'document:d',relation:'source_for',origin:'suggested',reason:'Requirements quote the research.'},{source:'document:d',target:'epic:e',relation:'relevant_to',origin:'existing',reason:'Linked to epic.'},{source:'ticket:t',target:'epic:e',relation:'belongs_to',origin:'existing',reason:'Ticket belongs to epic.'}];
 await page.route('http://graph.test/**',async route=>{
  if(route.request().url().includes('/api/projects/')) {
   if(route.request().method()==='POST'){posts.push(route.request().postDataJSON());return route.fulfill({json:{ok:true}});}
   return route.fulfill({json:{nodes,edges,status:'ready',canEdit:true}});
  }
  return route.fulfill({contentType:'text/html',body:'<html><head></head><body><button id="refresh-filebrowser">Refresh documents</button></body></html>'});
 });
 await page.goto('http://graph.test');await page.addStyleTag({content:readFileSync('public/css/document-graph.css','utf8')});await page.addScriptTag({content:readFileSync('public/js/document-graph.js','utf8')});
 await page.evaluate(()=>window.DocumentGraph.mount('project'));
 await page.getByRole('button',{name:'Document map',exact:true}).click();
 await page.getByRole('button',{name:'Document: Checkout requirements',exact:true}).click();
 await page.getByRole('button',{name:'Accept',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.dg-status').textContent.includes('up to date'));
 assert.equal(posts[0]?.decision,'accepted');
 await page.getByRole('combobox',{name:'Tag this document to an epic'}).selectOption('epic:e');const tagRequest=page.waitForRequest(r=>r.url().endsWith('/links')&&r.method()==='POST');await page.getByRole('button',{name:'Tag to epic',exact:true}).click();await tagRequest;
 assert.equal(posts.at(-1)?.relation,'relevant_to');
 await page.getByRole('button',{name:'← Show all documents'}).click();
 await page.screenshot({path:'/private/tmp/document-graph-desktop.png'});
 await page.getByRole('searchbox').fill('<img');assert.equal(await page.locator('svg .dg-node').count(),1);assert.equal(await page.locator('img').count(),0);
 await page.getByRole('searchbox').fill('missing');await page.getByText('No matching items.').waitFor();
 await page.getByRole('searchbox').fill('');await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/private/tmp/document-graph-mobile.png'});
 await page.getByRole('button',{name:'Close',exact:true}).click();await page.locator('dialog').waitFor({state:'detached'});assert.deepEqual(errors,[]);
 console.log('Document graph browser: selection, accept/tag actions, search, empty state, XSS rendering, responsive layout, and close passed.');
} finally {await browser.close();}
