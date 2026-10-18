import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const tickets=[{id:'a',ticketKey:'APP-1',name:'Foundation',status:'done',epicId:'other',dependencies:[]},{id:'b',ticketKey:'APP-2',name:'API',status:'open',epicId:'epic',dependencies:['a']},{id:'c',ticketKey:'APP-3',name:'UI',status:'open',epicId:'epic',dependencies:['APP-2','missing']},{id:'d',ticketKey:'APP-4',name:'Cycle one',status:'open',epicId:'cycle',dependencies:['e']},{id:'e',ticketKey:'APP-5',name:'Cycle two',status:'open',epicId:'cycle',dependencies:['d']}];
 await page.route('https://lfg.test/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith('/tickets'))return route.fulfill({json:{tickets}});
  if(path.endsWith('/epics'))return route.fulfill({json:{epics:[{id:'epic',name:'Delivery'},{id:'other',name:'Foundation'},{id:'cycle',name:'Cycle'}]}});
  if(path.endsWith('/document-graph'))return route.fulfill({json:{status:'ready',canEdit:false,nodes:[{id:'document:a',kind:'document',name:'Specification',duplicateKey:'identical'},{id:'document:b',kind:'document',name:'Specification',duplicateKey:'identical'},{id:'document:c',kind:'document',name:'Specification',duplicateKey:'different-version'},{id:'epic:a',kind:'epic',name:'Delivery'}],edges:[{source:'document:a',target:'epic:a',relation:'relevant_to',origin:'existing',reason:'Linked'},{source:'document:b',target:'epic:a',relation:'relevant_to',origin:'existing',reason:'Linked'}]}});
  return route.fulfill({contentType:'text/html',body:'<html data-theme="light"><head></head><body><div id="root"><div class="checklist-header"></div><select id="epic-filter"><option value="epic">Delivery</option></select></div><button id="refresh-filebrowser">Refresh documents</button></body></html>'});
 });
 await page.goto('https://lfg.test/');await page.addStyleTag({content:'*{margin:0;box-sizing:border-box}'});
 await page.addStyleTag({path:'public/css/document-graph.css'});
 await page.addScriptTag({path:'public/js/ticket-map.js'});await page.addScriptTag({path:'public/js/document-graph.js'});
 await page.evaluate(()=>{TicketMap.mount('project',document.querySelector('#root'));DocumentGraph.mount('project');});
 assert.equal(await page.locator('.ticket-map-heading #ticket-map-open').count(),1);
 await page.click('#ticket-map-open');await page.waitForFunction(()=>document.querySelector('.dg-status').textContent.includes('2 dependencies'));
 assert.equal(await page.locator('.dg-node').count(),3);
 assert.equal(await page.locator('.dg-outside').count(),1);
 await page.getByRole('button',{name:'APP-3 · UI',exact:true}).click();
 assert.match(await page.locator('.dg-details').textContent(),/Depends on.*APP-2/s);
 assert.match(await page.locator('.dg-details').textContent(),/Unresolved dependency: missing/);
 await page.selectOption('[aria-label="Filter ticket map by epic"]','cycle');assert.match(await page.locator('.dg-status').textContent(),/cycle/);
 await page.selectOption('[aria-label="Filter ticket map by epic"]','epic');
 for(const theme of ['light','dark']){
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  const bg=await page.locator('dialog').evaluate(el=>getComputedStyle(el).backgroundColor);
  assert.equal(bg,theme==='light'?'rgb(255, 255, 255)':'rgb(22, 24, 29)');
  await page.screenshot({path:`/tmp/lfg-ticket-map-${theme}.png`});
 }
 await page.keyboard.press('Escape');await page.locator('dialog').waitFor({state:'detached'});
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000});await page.evaluate(()=>document.documentElement.dataset.theme='light');await page.click('#document-graph-open');await page.waitForFunction(()=>document.querySelector('.dg-status').textContent.includes('up to date'));
  assert.equal(await page.locator('.dg-node').count(),3,'Identical copies merge; same-name different content stays separate');
  assert.equal(await page.locator('.dg-edge').count(),1,'Duplicate connections collapse');
  await page.getByRole('button',{name:'Document: Specification',exact:true}).first().click();
  assert.match(await page.locator('.dg-details').textContent(),/2 identical copies/);
  const box=await page.locator('dialog').boundingBox();assert.ok(Math.abs(box.x-(width-box.width)/2)<2);assert.ok(Math.abs(box.y-(1000-box.height)/2)<2);
  assert.equal(await page.locator('dialog').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(255, 255, 255)');
  await page.screenshot({path:`/tmp/lfg-document-map-${width}.png`});await page.keyboard.press('Escape');await page.locator('dialog').waitFor({state:'detached'});
 }
 await page.click('#ticket-map-open');await page.waitForFunction(()=>document.querySelector('.dg-status').textContent.includes('dependencies'));
 const mobileBox=await page.locator('dialog').boundingBox();assert.ok(mobileBox.x>=0 && mobileBox.x+mobileBox.width<=390);
 await page.screenshot({path:'/tmp/lfg-ticket-map-mobile.png'});await page.keyboard.press('Escape');await page.locator('dialog').waitFor({state:'detached'});
 assert.equal(await page.locator('.map-header-actions #document-graph-open').count(),1);
 assert.equal(await page.locator('.map-header-actions #refresh-filebrowser').count(),1);
 assert.equal(await page.locator('#document-graph-open').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(255, 255, 255)');
 console.log('PASS: dependency direction, external epic prerequisites, missing references, cycles, theme switching, centered desktop/mobile maps.');
}finally{await browser.close();}
