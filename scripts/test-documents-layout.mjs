import {chromium} from 'playwright-core';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const source=await readFile('public/js/artifacts-loader.js','utf8');
const template=await readFile('src/templates/pages/chat.tsx','utf8');
const markup=template.slice(template.indexOf('<div class="filebrowser-header"'),template.indexOf('<!-- File Viewer'));
const method=source.slice(source.indexOf('loadFileBrowser: function'),source.indexOf('    }; // End of ArtifactsLoader object'));
const css=await readFile('public/css/artifacts.css','utf8');
const common=await readFile('public/css/common.css','utf8');
const light=await readFile('public/css/light/light-mode.css','utf8');
const epic={epicId:'e1',epicName:'CoHire Workforce — Timesheet',epicKey:'COH-E3',epicCreatedAt:'2026-09-01'};
const files=[{id:'f1',name:'Technical Analysis — CoHire Workforce Timesheet',type:'tech_analysis',epics:[epic]},{id:'f2',name:'CoHire Workforce — Timesheet PRD',type:'prd',epics:[epic]},{id:'f3',name:'Distinctive unassigned research',type:'research',epics:[]}].map(f=>({...f,updated_at:'2026-09-01'}));
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('http://lfg.test/**',route=>{
  if(route.request().url().includes('/api/files/browser'))return route.fulfill({json:{files,filters:{types:['tech_analysis','prd','research'],epics:[{id:'e1',name:epic.epicName,epicKey:epic.epicKey}]},pagination:{pages:1}}});
  if(route.request().url().includes('comment-counts'))return route.fulfill({json:{counts:{f1:1}}});
  return route.fulfill({contentType:'text/html',body:`<meta charset="UTF-8"><div id="filebrowser"><div id="filebrowser-main">${markup}</div><div id="filebrowser-viewer" style="display:none"><div id="viewer-title"></div><div id="viewer-markdown"></div></div></div>`});
 });
 await page.goto('http://lfg.test/');
 await page.addStyleTag({content:common+'\n'+css+'\n'+light+'\n:root{--text-color:#273247;--text-secondary:#66748a;--border-color:#e5e8f0;--card-bg:#fff;--hover-bg:#f4f5f7}'});
 await page.addScriptTag({content:'window.getCsrfToken=()=>"";window.showToast=()=>{};window.ArtifactsLoader={'+method+'};window.ArtifactsLoader.loadFileBrowser("project");'});
 await page.waitForSelector('.file-list-item');
 assert.equal(await page.locator('.document-epic-group').count(),2);
 assert.match(await page.locator('[data-file-id="f1"] .file-name').textContent(),/^Technical Analysis/);
 assert.equal(await page.locator('[data-file-id="f2"] .file-name').textContent(),'Requirements');
 assert.equal(await page.locator('[data-file-id="f2"]').getAttribute('data-file-name'),files[1].name);
 assert.equal(await page.locator('.file-type-badge').count(),0);
 await page.locator('summary').first().click();
 await page.locator('#refresh-filebrowser').click();
 await page.waitForFunction(()=>document.querySelector('#filebrowser-list').style.display==='block');
 assert.equal(await page.locator('details').first().getAttribute('open'),null);
 await page.locator('summary').first().click();
 await page.locator('.file-context-menu-btn').first().click();
 assert.equal(await page.getByRole('button',{name:'Add to epic',exact:true}).count(),1);
 await page.getByRole('button',{name:'Add to epic',exact:true}).click();
 assert.match(await page.locator('.file-context-dropdown').textContent(),/COH-E3/);
 await page.keyboard.press('Escape');
 for(const theme of ['light','dark'])for(const width of [760,360]){
  await page.setViewportSize({width,height:900});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${theme} ${width} overflow`);
  assert.equal(await page.locator('.file-context-menu-btn').first().isVisible(),true);
  assert.equal(await page.locator('.file-date-cell').first().isVisible(),true);
  const row=await page.locator('.file-list-item').first().boundingBox();
  const menu=await page.locator('.file-context-menu-btn').first().boundingBox();
  assert.ok(menu.y+menu.height<=row.y+row.height,'Menu stays in the document row');
 }
 await page.setViewportSize({width:760,height:900}); await page.evaluate(()=>document.documentElement.dataset.theme='light'); await page.screenshot({path:'/tmp/documents-compact.png'});
 assert.deepEqual(errors,[]);console.log('PASS: compact labels preserve filenames; collapsible groups survive refresh; epic menu; light/dark narrow and wide layouts');
}finally{await browser.close()}
