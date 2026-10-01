import {chromium} from 'playwright-core';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:900,height:700}});
 await page.setContent('<div id="actions"></div>');
 await page.addStyleTag({content:await readFile('public/css/artifacts.css','utf8')});
 await page.addScriptTag({content:await readFile('public/js/ticket-action-phases.js','utf8')});
 await page.evaluate(()=>{
  const messages=['[Validation] Inspecting saved code',...['pending','running','passed'].map(status=>'Validation check: '+JSON.stringify({id:'config',label:'Configuration defaults and overrides',status})),'Validation check: '+JSON.stringify({id:'startup',label:'App startup',status:'blocked'})];
  (window as any).TicketActionPhases.render(document.getElementById('actions'),messages.map(message=>({message})),{queueStatus:'executing'},'test',(row:any)=>{const el=document.createElement('p');el.textContent=row.message;return el;});
 });
 assert.equal(await page.locator('.validation-checklist li').count(),2);
 assert.equal(await page.locator('[data-status="passed"]').textContent(),'✓Configuration defaults and overridespassed');
 assert(await page.getByText('Connection problem',{exact:true}).isVisible());
 assert(!(await page.getByText('Inspecting saved code',{exact:true}).isVisible()));
 await page.getByText('Technical activity and diagnostics',{exact:true}).click();
 assert(await page.getByText('Inspecting saved code',{exact:true}).isVisible());
 console.log('Validation progress UI passed');
}finally{await browser.close();}
