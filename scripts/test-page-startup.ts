import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { ChatPage } from '../src/templates/pages/chat';

const markup = String(await ChatPage({ user:{id:'u',name:'Test',email:'test@example.com'},projectId:'demo',projectName:'Demo',conversationId:'chat' }));
assert(!/<script[^>]+src="[^\"]*(jspdf|html2canvas)/.test(markup));
const browser = await chromium.launch({ executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true });
try {
 for (const theme of ['light','dark']) {
  const page = await browser.newPage();
  let release!: () => void;
  const stalled = new Promise<void>(resolve => { release=resolve; });
  await page.route('**/*',async route => {
   const url=new URL(route.request().url());
   if(url.pathname==='/chat') return route.fulfill({contentType:'text/html',body:markup});
   if(url.pathname==='/public/js/marked.min.js') await stalled;
   if(url.pathname.startsWith('/public/')) {
    try { return await route.fulfill({body:await readFile('.'+url.pathname),contentType:url.pathname.endsWith('.css')?'text/css':'text/javascript'}); } catch {}
   }
   return route.fulfill({body:'',status:200});
  });
  await page.addInitScript(theme => { localStorage.setItem('sidebarMinimized','true');localStorage.setItem('lfg-theme',theme); },theme);
  await page.goto('http://lfg.test/chat',{waitUntil:'commit'});
  await page.waitForFunction(() => document.getElementById('sidebar')?.getBoundingClientRect().width===60);
  const state=await page.evaluate(() => ({ready:document.readyState, hidden:[...document.querySelectorAll('#sidebar .nav-text,#sidebar .user-details,#sidebar .conversations-section,#sidebar .project-name-text')].every(el=>getComputedStyle(el).display==='none'),legacyToggle:[...document.querySelectorAll('#sidebar .bottom-nav [data-theme-toggle]')].every(el=>getComputedStyle(el).display==='none')}));
  assert.equal(state.ready,'loading');assert(state.hidden);assert(state.legacyToggle);
  release();await page.close();
 }
} finally { await browser.close(); }
// Optional library loading shares concurrent requests and retries a failed load.
const source=await readFile('public/js/artifacts-loader.js','utf8');
const scripts:any[]=[];
const context=vm.createContext({window:{},document:{createElement:()=>({remove(){}}),head:{appendChild:(s:any)=>scripts.push(s)}}});
vm.runInContext(source.split('/**')[0],context);
assert.equal(scripts.length,0);
const one=vm.runInContext('ensurePdfExportLibraries()',context);
const two=vm.runInContext('ensurePdfExportLibraries()',context);
assert.equal(scripts.length,2);
context.window.jspdf={jsPDF:()=>{}};context.window.html2canvas=()=>{};
scripts.forEach(s=>s.onload());await Promise.all([one,two]);
delete context.window.html2canvas;
// Successful entries are cached; use a fresh context to exercise a network failure.
const retry=vm.createContext({window:{jspdf:{jsPDF:()=>{}}},document:context.document});
vm.runInContext(source.split('/**')[0],retry);
const failed=vm.runInContext('ensurePdfExportLibraries()',retry);scripts.at(-1).onerror();await assert.rejects(failed);
const again=vm.runInContext('ensurePdfExportLibraries()',retry);retry.window.html2canvas=()=>{};scripts.at(-1).onload();await again;
console.log('PASS: sidebar first paint in both themes; on-demand PDF concurrency and retry');
