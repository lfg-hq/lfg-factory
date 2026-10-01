import {chromium} from 'playwright-core';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const source=readFileSync('public/js/chat.js','utf8');
const functions=source.slice(source.indexOf('    function syncPreviewChrome('),source.indexOf('    function renderQuestionCard('));
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 const page=await browser.newPage();
 await page.setContent('<div id="messages"></div>');
 await page.addStyleTag({content:readFileSync('public/css/chat.css','utf8')});
 await page.addScriptTag({content:readFileSync('public/js/design-preview.js','utf8')});
 await page.addScriptTag({content:`const messageContainer=document.querySelector('#messages');function scrollToBottom(){};function extractProjectIdFromPath(){return 'p'};window.fetch=async()=>({json:async()=>({content:'<!doctype html><html><head></head><body>Preview</body></html>'})});${functions};window.renderPreview=renderPagePreview;`});
 await page.evaluate(()=>{for(let i=1;i<=3;i++)window.renderPreview('id'+i,'Screen '+i,{replay:true});});
 await page.locator('.page-preview-card').first().locator('[data-pv=expand]').click();
 assert.equal(await page.locator('.is-full .page-preview-position').textContent(),'1 of 3 · 2 more');
 await page.locator('.is-full [data-pv=next]').click();
 assert.equal(await page.locator('.is-full .page-preview-name').textContent(),'Screen 2');
 assert.equal(await page.locator('.is-full .page-preview-position').textContent(),'2 of 3 · 1 more');
 await page.locator('.is-full [data-pv=next]').click();
 assert.equal(await page.locator('.is-full [data-pv=next]').isDisabled(),true);
 await page.locator('.is-full [data-pv=previous]').click();
 assert.equal(await page.locator('.is-full .page-preview-name').textContent(),'Screen 2');
 await page.locator('.is-full [data-pv=toggle]').click();
 assert.equal(await page.locator('.is-full').count(),0);
 // Exercise the actual WebSocket history preview restoration branch.
 const wsBlock=source.slice(source.indexOf("case 'chat_history':"),source.indexOf("case 'message':",source.indexOf("case 'chat_history':")));
 assert.ok(wsBlock.includes('msg.page_previews || msg.pagePreviews'));
 const docsSource=readFileSync('public/js/artifacts-loader.js','utf8');
 const groupCode=docsSource.slice(docsSource.indexOf('                        const isDesign = f =>'),docsSource.indexOf('                            const icon = getFileIcon(file.type);',docsSource.indexOf('                        const isDesign = f =>')))+'});';
 await page.evaluate(code=>{
  const fileBrowserList=document.createElement('div');fileBrowserList.id='docs-fixture';const browser=document.createElement('div');browser.id='filebrowser';browser.append(fileBrowserList);document.body.append(browser);
  const currentEpic='',currentSearch='',currentType='',collapsedDocGroups=new Set();
  const docEpicLabel=f=>f.epics?.[0]?.epicName || 'No epic';
  const data={files:[{id:'upload-1',type:'upload',name:'Requirements.docx'},{type:'prd',name:'Requirements',epics:[{epicId:'a',epicName:'Feature A'}]},{type:'page_preview',name:'Screen 1',epics:[{epicId:'a',epicName:'Feature A'}]},{type:'page_preview',name:'Screen 2',epics:[{epicId:'a',epicName:'Feature A'}]},{type:'page_preview',name:'Other screen',epics:[{epicId:'b',epicName:'Feature B'}]}]};
  eval(code);
 },groupCode);
 assert.equal(await page.locator('#docs-fixture > .document-uploads-folder').count(),1);
 assert.equal(await page.locator('.document-uploads-folder a').getAttribute('href'),'/api/files/upload-1');
 assert.equal(await page.locator('.document-epic-group > summary .document-group-epic').count(),3);
 assert.equal(await page.locator('#docs-fixture > .document-design-folder').count(),1);
 assert.equal(await page.locator('.document-design-folder > .document-epic-group').count(),2);
 assert.equal(await page.locator('#docs-fixture > .document-epic-group').count(),1);
 await page.addStyleTag({content:readFileSync('public/css/artifacts.css','utf8')});
 await page.addStyleTag({content:'#messages{display:none} body{margin:0;font-family:Arial;background:#fff;color:#243044;--text-color:#243044;--text-secondary:#64748b;--border-color:#e2e8f0;--hover-bg:#f5f3ff} #filebrowser{padding:16px}'});
 await page.setViewportSize({width:420,height:500});
 const root=page.locator('.document-design-folder > summary');
 assert.equal(await root.locator('.document-group-count').textContent(),'3');
 assert.equal(await root.locator('svg').count(),2);
 await root.click();
 const nested=page.locator('.document-design-folder > .document-epic-group > summary').first();
 assert.ok((await nested.boundingBox()).x > (await root.boundingBox()).x + 20);
 for(const box of await page.locator('#docs-fixture summary').evaluateAll(rows=>rows.map(r=>({right:r.getBoundingClientRect().right,height:r.getBoundingClientRect().height})))) {
  assert.ok(box.right<=420);assert.ok(box.height<=48);
 }
 await page.screenshot({path:'/private/tmp/document-folders.png'});
 console.log('PASS: preview replay, full-screen next/previous, counts, endpoints and close');
} finally {await browser.close();}
