const {chromium}=require('playwright-core');
const fs=require('fs'); const path=require('path'); const assert=require('assert'); const {execFileSync}=require('child_process');
const root=path.resolve(__dirname,'..'); const temp=fs.mkdtempSync('/private/tmp/ticket-browser-');
execFileSync('bun',['-e',`import {TicketCodePage} from './src/templates/pages/ticket-code.tsx'; await Bun.write(${JSON.stringify(temp+'/preview.html')},String(TicketCodePage({projectId:'demo',ticketId:'ticket-123',name:'Add a beautiful analytics dashboard',ticketKey:'LFG-128'})));`],{cwd:root});
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let saved='export const count = 2;\n',commits=0, canEdit=true, failSave=false, preparing=1, treeError=false;
 await page.route('**/*',async route=>{
  const u=new URL(route.request().url()); let local;
  if(u.pathname.includes('/code/')) {
   const action=u.pathname.split('/').pop(),body=route.request().postDataJSON();
   if(action==='tree' && treeError)return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Workspace recovery failed. Retry shortly.'})});
   if(action==='tree' && preparing-->0)return route.fulfill({status:202,contentType:'application/json',body:JSON.stringify({preparing:true,message:'Restoring ticket code…'})});
   if(action==='save' && failSave)return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'File changed in the sandbox. Reopen it and reconcile your edits before saving.'})});
   const data=action==='tree'?{branch:'feature/analytics-dashboard',base:'main',canEdit,files:[{path:'src/dashboard.ts',changed:true},{path:'src/styles.css',changed:true},{path:'package.json',changed:false}]}:action==='file'?{original:'export const count = 1;\n',content:saved,version:'v1',exists:true}:action==='save'?(saved=body.content,{version:'v2'}):action==='commit'?(commits++,{sha:'a'.repeat(40)}):{output:'src/dashboard.ts\n',exitCode:0};
   return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
  }
  if(u.pathname.startsWith('/vendor/monaco/'))local=root+'/node_modules/monaco-editor/min/'+u.pathname.replace('/vendor/monaco/','');
  else if(u.pathname.startsWith('/public/'))local=root+u.pathname;
  else if(u.hostname==='localhost')local=temp+'/preview.html';
  else return route.abort();
  const ext=path.extname(local);return route.fulfill({contentType:ext==='.js'?'text/javascript':ext==='.css'?'text/css':ext==='.html'?'text/html':'application/octet-stream',body:fs.readFileSync(local)});
 });
 await page.goto('http://localhost/projects/demo/tickets/ticket-123/diff');await page.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('Ready'));
 await page.evaluate(()=>monaco.editor.getModels().find(m=>m.uri.path.startsWith('/ticket/')).setValue('export const count = 3;\n'));
 await page.locator('#save').click();await page.locator('#commit-dialog').waitFor({state:'visible'});assert.equal(commits,0);await page.screenshot({path:temp+'/commit.png'});await page.locator('#skip-commit').click();
 await page.locator('#terminal-toggle').click();await page.locator('#command').fill('ls src');await page.locator('#run-command').click();await page.waitForFunction(()=>document.querySelector('#terminal-output').textContent.includes('[exit 0]'));
 await page.screenshot({path:temp+'/desktop.png'});
 await page.locator('#edit-mode').click();await page.evaluate(()=>monaco.editor.getModels().find(m=>m.uri.path.startsWith('/ticket/')).setValue('export const count = 4;\n'));await page.locator('#save').click();await page.locator('#confirm-commit').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('Committed'));assert.equal(commits,1);
 await page.locator('#all-files').click();assert.equal(await page.locator('.file-item').count(),3);
 await page.locator('#file-search').fill('package');assert.equal(await page.locator('.file-item').count(),1);
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:temp+'/mobile.png'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.setViewportSize({width:1440,height:1000});
 await page.locator('#file-search').fill('');failSave=true;
 await page.evaluate(()=>monaco.editor.getModels().find(m=>m.uri.path.startsWith('/ticket/')).setValue('unsaved conflict buffer'));
 await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('Save failed'));
 assert.equal(await page.evaluate(()=>monaco.editor.getModels().find(m=>m.uri.path.startsWith('/ticket/')).getValue()),'unsaved conflict buffer');assert.equal(await page.locator('#commit-dialog').isVisible(),false);
 // Start a clean page as a read-only user.
 canEdit=false;page.on('dialog',d=>d.accept());await page.reload();await page.waitForFunction(()=>document.querySelector('#status').textContent==='Read-only');
 assert.equal(await page.locator('#save').isDisabled(),true);assert.equal(await page.locator('#command').isDisabled(),true);
 treeError=true;await page.reload();await page.waitForFunction(()=>document.querySelector('#status').textContent==='Checkout unavailable');assert.equal(await page.locator('#change-count').textContent(),'—');assert.match(await page.locator('#file-list').textContent(),/Could not load/);
 assert.deepEqual(errors,[]);console.log('Screenshots: '+temp);console.log('PASS: Monaco load, diff, edit, save, defer/confirm commit, terminal, search, mobile layout; no browser errors');await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
