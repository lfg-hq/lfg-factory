import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { ChatPage } from '../src/templates/pages/chat.tsx';
const props={user:{id:'u',name:'Test',email:'test@example.com'},projectId:'demo',projectName:'Demo'};
const off=String(await ChatPage(props)),on=String(await ChatPage({...props,epicBuildsEnabled:true}));
assert(off.includes('data-tab="checklist">Tickets</button>'));
assert(on.includes('data-tab="checklist">Epics</button>'));
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 const page=await browser.newPage({viewport:{width:850,height:900}});
 let requests=0,saved:any=null;
 await page.route('**/*',async route=>{
  const u=new URL(route.request().url());
  if(u.pathname==='/projects/demo')return route.fulfill({contentType:'text/html',body:'<body data-epic-builds="true" data-project-id="demo"><div id="checklist"></div><input id="cfg-epic-builds" type="checkbox" disabled><p id="cfg-epic-builds-status"></p></body>'});
  if(u.pathname.endsWith('/epics')){requests++;return route.fulfill({json:{epicBuildsEnabled:true,canBuildEpics:true,epics:[{id:'e',epicKey:'E1',name:'Feature',goal:'Build something useful',status:'draft',ticketCount:0,ticketsBuilt:0,buildStatus:'Planning'},{id:'r',name:'Ready feature',status:'in_review',ticketCount:2,ticketsBuilt:2,buildStatus:'Ready for review',previewUrl:'https://preview.example.com'}]}});}
  if(u.pathname.endsWith('/build-settings')){if(route.request().method()==='POST') saved=route.request().postDataJSON();return route.fulfill({json:{epicBuildsEnabled:false,canChangeEpicBuilds:true}});}
  return route.fulfill({body:''});
 });
 await page.goto('http://test.local/projects/demo');
 for(const file of ['theme-variables.css','artifacts.css'])await page.addStyleTag({content:await readFile('public/css/'+file,'utf8')});
 await page.evaluate(()=>{(window as any).__sendChatMessage__=(text:string)=>(window as any).sent=text;});
 await page.addScriptTag({content:await readFile('public/js/chat-epics.js','utf8')});
 await page.evaluate(()=>(window as any).loadChatEpics('demo'));
 assert.equal(await page.locator('.chat-epic').count(),2);
 assert(!(await page.locator('#checklist').textContent())?.toLowerCase().includes('ticket'));
 await page.getByRole('button',{name:'Build feature'}).first().click();
 assert((await page.evaluate(()=>(window as any).sent)).includes('I approve building'));
 assert.equal(await page.getByRole('link',{name:'Test preview ↗'}).getAttribute('href'),'https://preview.example.com/');
 await page.screenshot({path:'/tmp/epic-builds-chat.png'});
 await page.addScriptTag({content:await readFile('public/js/epic-build-settings.js','utf8')});
 await page.waitForFunction(()=>!(document.getElementById('cfg-epic-builds') as HTMLInputElement).disabled);
 await page.locator('#cfg-epic-builds').check();
 await page.waitForFunction(()=>document.getElementById('cfg-epic-builds-status')?.textContent?.startsWith('Saved'));
 assert.deepEqual(saved,{epicBuildsEnabled:true});
 await page.evaluate(()=>{document.body.dataset.epicBuilds='false';});
 const count=requests;await page.evaluate(()=>(window as any).loadChatEpics('demo'));assert.equal(requests,count);
 console.log('PASS: default ticket mode, opt-in Epics panel, build approval action, preview, setting save, off-mode guard');
} finally {await browser.close();}
