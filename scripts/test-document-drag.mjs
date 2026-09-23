import {chromium} from 'playwright-core';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const source=await readFile('public/js/artifacts-loader.js','utf8');
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 const page=await browser.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let linked;
 await page.route('http://lfg.test/**',route=>{
  if(route.request().method()==='POST'){linked=route.request().postDataJSON();return route.fulfill({json:{linked:1}});}
  return route.fulfill({contentType:'text/html',body:'<div id="artifacts-panel"><select id="types"></select><div id="doc-epic-drop-targets" hidden></div><div id="file-browser-list"><div draggable="true" data-file-id="file1" data-file-name="Spec" data-file-type="spec">Spec</div></div><button data-epic-drop="epic1">Epic</button><button id="refresh-filebrowser">Refresh</button></div><textarea id="chat-input"></textarea>'});
 });
 await page.goto('http://lfg.test/');
 await page.addScriptTag({content:source.slice(source.indexOf('// Internal project document dragging'))});
 await page.evaluate(()=>{window.drops=[];document.addEventListener('lfg-file-chat-drop',e=>window.drops.push(e.detail));});
 const drag=async target=>page.evaluate(target=>{
  const row=document.querySelector('[draggable]'),dt=new DataTransfer();
  row.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));
  const dest=document.querySelector(target);
  dest.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt}));
  dest.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));
 },target);
 await page.locator('[draggable]').dragTo(page.locator('[data-epic-drop]'));await page.waitForFunction(()=>document.querySelector('#document-drop-status')?.textContent.includes('linked'));
 assert.deepEqual(linked,{fileIds:['file1']});
 await drag('#chat-input');assert.equal(await page.evaluate(()=>window.drops[0].id),'file1');
 const start=source.indexOf('const updateTypeFilterOptions ='); const end=source.indexOf('// Build pagination HTML',start);
 await page.evaluate(code=>{const fileTypeFilter=document.querySelector('#types'),currentType='spec';eval(code+'; updateTypeFilterOptions({spec:{name:"Specification",count:2}});');},source.slice(start,end));
 assert.equal(await page.locator('#types option').nth(1).textContent(),'Specification (2)');assert.equal(await page.locator('#types').inputValue(),'spec');
 const sortStart=source.indexOf('const docEpicLabel =');
 const sortEnd=source.indexOf('let curDocGroup',sortStart);
 const sorted=await page.evaluate(code=>{
   const currentEpic='';
   const data={files:[{name:'Old',epics:[{epicKey:'E1',epicName:'Old',epicCreatedAt:'2026-01-01'}]},{name:'Unlinked',epics:[]},{name:'New',epics:[{epicKey:'E4',epicName:'New',epicCreatedAt:'2026-09-01'}]}]};
   eval(code);return data.files.map(f=>f.name);
 },source.slice(sortStart,sortEnd));
 assert.deepEqual(sorted,['New','Old','Unlinked']);
 assert.deepEqual(errors,[]);console.log('PASS: file-to-epic drop, file-to-chat reference event, document type labels and selection');
} finally {await browser.close();}
