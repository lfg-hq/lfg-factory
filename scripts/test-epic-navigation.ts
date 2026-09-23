import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { EpicsPage } from '../src/templates/pages/epics';
import { TicketsListPage } from '../src/templates/pages/tickets-list';
const project = {id:'p',projectId:'demo',name:'Demo',icon:'🚀'};
const epics = [{id:'e1',name:'Feature one',epicKey:'E1',goal:'A clear feature goal',status:'building',branch:'epic/one',baseBranch:'main',prUrl:null,previewUrl:null,conversationId:null}];
const tickets = [
 {id:'t1',epicId:'e1',ticketKey:'T1',name:'First ticket',description:'## Overview\n\nUse **care** and `TenantId`. <script>unsafe()</script>',status:'review',priority:'High',stageId:'s',complexity:'low',queueStatus:'none',githubBranch:null,conversationId:null},
 {id:'t2',epicId:null,ticketKey:'T2',name:'Second ticket',description:'Another task',status:'open',priority:'Low',stageId:'s',complexity:'low',queueStatus:'none',githubBranch:null,conversationId:null}
];
const user = {id:'u',name:'Test'};
const epicMarkup = String(await EpicsPage({project,user,epics,tickets,docs:[{id:"doc1",epicId:"e1",name:"Preview",fileType:"page_preview",owned:false},{id:"doc2",epicId:"e1",name:"Notes",fileType:"prd",owned:false}],conversations:[]}));
const ticketMarkup = String(await TicketsListPage({project,user,epics,tickets,stages:[{id:'s',name:'Backlog',color:'#888',order:0,isCompleted:false}]}));
for (const markup of [epicMarkup,ticketMarkup]) for(const m of markup.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)) new Function(m[1]);
const browser = await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 const page = await browser.newPage({viewport:{width:1440,height:1000}});
 await page.route('**/*',async route=>{
  const u = new URL(route.request().url());
  if(u.pathname==='/projects/demo/epics') return route.fulfill({contentType:'text/html',body:epicMarkup});
  if(u.pathname==='/projects/demo/tickets') return route.fulfill({contentType:'text/html',body:ticketMarkup});
  if(u.pathname.endsWith('/files/doc1/content')) return route.fulfill({json:{content:'<style>body{background:red!important}</style><h1>Preview page</h1>'}});
  if(u.pathname.endsWith('/files/doc2/content')) return route.fulfill({json:{content:'## Document heading\n\n**Bold**\n\n<style>body{background:red!important}</style>'}});
  if(u.pathname === '/api/projects/demo/tickets/t1') return route.fulfill({json:{ticket:tickets[0]}});
  if(u.pathname.startsWith('/public/')) {try {return route.fulfill({body:await readFile('.'+u.pathname),contentType:u.pathname.endsWith('.js')?'text/javascript':'text/css'});}catch{}}
  return route.fulfill({json:{}});
 });
 await page.addInitScript(()=>{localStorage.setItem('lfg-theme','light');localStorage.setItem('sidebarMinimized','true');sessionStorage.setItem('lfg_drawer_ticket_demo','t2');});
 await page.goto('http://lfg.test/projects/demo/tickets?epic=e1');
 assert.equal(await page.locator('#filter-epic').inputValue(),'e1');
 assert.equal(await page.locator('.kanban-card:visible').count(),1);
 assert.equal(await page.locator('.ticket-count').textContent(),'1');
 await page.locator('#filter-epic').selectOption('unassigned');
 assert.equal(await page.locator('.kanban-card:visible').getAttribute('data-ticket-id'),'t2');
 assert(page.url().includes('epic=unassigned'));
 await page.locator('#filter-priority').selectOption('High');
 assert.equal(await page.locator('.kanban-card:visible').count(),0);
 await page.locator('#clear-ticket-filters').click();
 assert.equal(await page.locator('.kanban-card:visible').count(),2);
 await page.goto('http://lfg.test/projects/demo/epics?epic=e1');
 await page.locator('[data-open-ticket="t1"]').click();
 assert.equal(await page.locator('#epic-panel iframe').count(),0);
 assert.equal(await page.locator('.epic-ticket-description h2').textContent(),'Overview');
 assert.equal(await page.locator('.epic-ticket-description code').textContent(),'TenantId');
 assert.equal(await page.locator('.epic-ticket-description script').count(),0);
 assert.equal(await page.locator('.epic-ticket-description strong').textContent(),'care');
 const action=page.getByRole('link',{name:'View ticket actions →'});
 assert.equal(await action.getAttribute('href'),'/projects/demo/tickets?epic=e1&ticket=t1&tab=actions');
 await page.screenshot({path:'/tmp/lfg-epic-ticket-summary.png'});
 await action.click();
 await page.waitForFunction(()=>document.querySelector('.drawer-tab[data-tab="actions"]')?.classList.contains('active'));
 await page.goto('http://lfg.test/projects/demo/epics?epic=e1');
 const before = await page.locator('body').evaluate(e=>getComputedStyle(e).backgroundColor);
 await page.locator('[data-open-doc="doc1"]').click();
 await page.waitForSelector('.epic-page-preview iframe');
 assert.equal(await page.locator('.epic-page-preview iframe').getAttribute('sandbox'),'');
 assert.equal(await page.locator('body').evaluate(e=>getComputedStyle(e).backgroundColor),before);
 await page.locator('#epic-panel-back').click();
 assert.equal(await page.locator('.epic-ticket-dot').count(),1);
 await page.locator('[data-open-doc="doc2"]').click();
 await page.waitForSelector('.epic-doc h2');
 assert.equal(await page.locator('.epic-doc h2').textContent(),'Document heading');
 assert.equal(await page.locator('.epic-doc style').count(),0);
 await page.locator('#epic-panel-back').click();
 for(const theme of ['light','dark']) {
  await page.evaluate(theme=>{document.documentElement.setAttribute('data-theme',theme);},theme);
  await page.locator('#sidebar .nav-link').first().hover();
  const contrast = await page.locator('#sidebar-menu-label').evaluate(el => {
    const c=getComputedStyle(el); const lum=(s:string)=>{const rgb=s.match(/[\d.]+/g)!.slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4});return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
    const a=lum(c.color),b=lum(c.backgroundColor); return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
  });
  assert(contrast>=4.5, theme+' tooltip contrast '+contrast);
  await page.screenshot({path:'/tmp/lfg-epics-'+theme+'.png'});
 }
 console.log('PASS: epic filters, combined filters, counts, URL, safe ticket summary, actions navigation');
} finally {await browser.close();}
