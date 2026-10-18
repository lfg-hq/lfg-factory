import { chromium } from 'playwright-core';
import { ProjectDetailPage } from '../src/templates/pages/project-detail.tsx';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const props = { user: { id: 'u', name: 'Jitin' }, project: { id: 'internal', projectId: 'demo', name: 'CoHire', icon: '🚀', status: 'active', description: null, stack: null, repoUrl: 'https://example.com/repo', repoOwner: 'cohire', repoName: 'cohire' }, githubConnected: true, conversations: [{ id: 'chat1', title: 'Training institutions page redesign', updatedAt: new Date() }], stages: [], ticketCounts: {}, envVars: [], instantApps: [], activeTab: 'home', docsCount: 3, memberCount: 2 };
const markup = String(await ProjectDetailPage(props));
const viewerMarkup = String(await ProjectDetailPage({...props,role:'viewer'}));
assert(!viewerMarkup.includes('class="home-start-card"'));
assert(!markup.includes('id="home-start-input"'));
assert(!markup.includes('Pick up where you left off'));
assert(!markup.includes('id="home-activity"'));
let epics = [
 {id:'e4',name:'Latest feature',epicKey:'COH-E4',status:'draft',previewUrl:null},
 {id:'e3',name:'Workforce',epicKey:'COH-E3',status:'building',previewUrl:'https://preview.example.com/workforce'},
 {id:'e2',name:'Marketing page',epicKey:'COH-E2',status:'in_review',previewUrl:'https://preview.example.com/marketing'},
 {id:'e1',name:'Older feature',epicKey:'COH-E1',status:'draft',previewUrl:'javascript:alert(1)'}
];
// Parse every inline script: template escapes must survive server rendering.
for (const match of markup.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new Function(match[1]);
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
 const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
 let tickets = [
  { epicId:'e2', id:'review', name:'Redesign TrainingInstitutions page', ticketKey:'COH-5', status:'review', queueStatus:'none', conversationId:'chat1' },
  { epicId:'e3', id:'failed', name:'Update the signup flow', ticketKey:'COH-6', status:'failed', queueStatus:'none' },
  { epicId:'e3', id:'running', name:'Add institution search', ticketKey:'COH-7', status:'in_progress', queueStatus:'executing' },
 ];
 const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
 await page.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.pathname === '/projects/demo') return route.fulfill({ contentType:'text/html', body:markup });
  if (url.pathname.startsWith('/public/')) {
   try { return route.fulfill({ body:await readFile('.'+url.pathname), contentType:url.pathname.endsWith('.css')?'text/css':url.pathname.endsWith('.js')?'text/javascript':'application/octet-stream' }); } catch { return route.fulfill({ status:404, body:'' }); }
  }
  if (url.pathname.endsWith('/boards')) return route.fulfill({ json:{ boards:[], connections:[] } });
  if (url.pathname.endsWith('/home')) return route.fulfill({ json:{ epics, workTickets:tickets, activities:[], notifications:[], members:{ owner:{name:'Jitin'},members:[] }, pins:[] } });
  return route.fulfill({ json:{} });
 });
 await page.addInitScript(() => { localStorage.setItem('lfg-theme','light'); localStorage.setItem('sidebarMinimized','true'); });
 await page.goto('http://lfg.test/projects/demo');
 await page.waitForFunction(() => document.querySelectorAll('.home-epic-row').length === 4);
 await page.locator('#user-info-button').click();
 assert.equal(await page.locator('#user-dropdown').isVisible(), true);
 assert((await page.locator('#user-dropdown').boundingBox()).width >= 230);
 assert.equal(await page.locator('#user-dropdown a span').first().isVisible(), true);
 assert.equal(await page.locator('#user-dropdown [data-theme-toggle]').count(), 1);
 assert.equal(await page.locator('.bottom-nav [data-theme-toggle]').count(), 0);
 await page.locator('#user-dropdown [data-theme-toggle]').click();
 assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
 await page.locator('#user-dropdown [data-theme-toggle]').click();
 assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('#user-dropdown').isVisible(), false);
 assert.equal(await page.locator('.home-epic-heading a').first().textContent(),'Latest feature');
 assert.equal(await page.getByRole('link',{name:'View issue →'}).getAttribute('href'),'/projects/demo/tickets?ticket=failed');
 assert.equal(await page.getByRole('link',{name:'Review changes →'}).getAttribute('href'),'/projects/demo/tickets?epic=e2');
 assert.equal(await page.getByRole('link',{name:'Test partial preview ↗'}).count(),1);
 assert.equal(await page.locator('a[href^="javascript:"]').count(),0);
 assert.equal(await page.locator('.home-epic-track').nth(1).getAttribute('aria-valuenow'),'0');
 assert.equal(await page.locator('.home-start-link').getAttribute('href'),'/chat/project/demo?new=1');
 assert.equal(await page.locator('#build-inbox-button .nav-text').textContent(), 'Notifications');
 await page.locator('.home-start-card').screenshot({path:'/tmp/lfg-home-compose-light.png'});
 await page.screenshot({ path:'/tmp/lfg-home-light.png', fullPage:true });
 await page.evaluate(() => { document.documentElement.dataset.theme='dark'; document.body.dataset.theme='dark'; });
 await page.screenshot({ path:'/tmp/lfg-home-dark.png', fullPage:true });
 tickets[0].queueStatus='queued';
 await page.evaluate(() => window.dispatchEvent(new Event('focus')));
 await page.waitForFunction(() => document.querySelectorAll('.home-epic-track')[2]?.getAttribute('aria-valuenow') === '0');
 assert.equal(await page.getByRole('link',{name:'Review changes →'}).count(),0);
 epics=[]; tickets=[]; await page.evaluate(() => window.dispatchEvent(new Event('focus')));
 await page.waitForFunction(() => document.querySelector('#home-epics')?.textContent?.includes('No epics yet'));
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:'/tmp/lfg-home-mobile.png',fullPage:true});
 assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No mobile horizontal overflow');
 await page.locator('.home-start-link').click();
 await page.waitForURL('**/chat/project/demo?new=1');
 assert.equal(await page.evaluate(() => sessionStorage.getItem('home-chat-draft:demo')), null);
 assert.deepEqual(errors,[]);
 console.log('PASS: rendered scripts, epic progress, partial previews, unsafe URL rejection, queue precedence, empty state, mobile layout, direct new chat navigation');
} finally { await browser.close(); }
