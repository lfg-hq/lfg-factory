import { chromium } from 'playwright-core';
import { ProjectDetailPage } from '../src/templates/pages/project-detail.tsx';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const props = { user: { id: 'u', name: 'Jitin' }, project: { id: 'internal', projectId: 'demo', name: 'CoHire', icon: '🚀', status: 'active', description: null, stack: null, repoUrl: 'https://example.com/repo', repoOwner: 'cohire', repoName: 'cohire' }, githubConnected: true, conversations: [{ id: 'chat1', title: 'Training institutions page redesign', updatedAt: new Date() }], stages: [], ticketCounts: {}, envVars: [], instantApps: [], activeTab: 'home', docsCount: 3, memberCount: 2 };
const markup = String(await ProjectDetailPage(props));
// Parse every inline script: template escapes must survive server rendering.
for (const match of markup.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new Function(match[1]);
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
 const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
 let tickets = [
  { id:'review', name:'Redesign TrainingInstitutions page', ticketKey:'COH-5', status:'review', queueStatus:'none', conversationId:'chat1' },
  { id:'failed', name:'Update the signup flow', ticketKey:'COH-6', status:'failed', queueStatus:'none' },
  { id:'running', name:'Add institution search', ticketKey:'COH-7', status:'in_progress', queueStatus:'executing' },
 ];
 const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
 await page.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.pathname === '/projects/demo') return route.fulfill({ contentType:'text/html', body:markup });
  if (url.pathname.startsWith('/public/')) {
   try { return route.fulfill({ body:await readFile('.'+url.pathname), contentType:url.pathname.endsWith('.css')?'text/css':url.pathname.endsWith('.js')?'text/javascript':'application/octet-stream' }); } catch { return route.fulfill({ status:404, body:'' }); }
  }
  if (url.pathname.endsWith('/boards')) return route.fulfill({ json:{ boards:[], connections:[] } });
  if (url.pathname.endsWith('/home')) return route.fulfill({ json:{ workTickets:tickets, activities:[], notifications:[], members:{ owner:{name:'Jitin'},members:[] }, pins:[] } });
  return route.fulfill({ json:{} });
 });
 await page.addInitScript(() => { localStorage.setItem('lfg-theme','light'); localStorage.setItem('sidebarMinimized','true'); });
 await page.goto('http://lfg.test/projects/demo');
 await page.waitForFunction(() => document.querySelectorAll('#home-ticket-attention .home-work-row').length === 2);
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
 assert.equal(await page.locator('#home-builds .home-work-row').count(),1);
 assert.equal(await page.locator('.home-chat-state').innerText(),'Ready for review');
 assert.equal(await page.getByRole('link',{name:'Review changes →'}).getAttribute('href'),'/projects/demo/tickets?ticket=review');
 for (const focused of [false, true]) {
  if (focused) await page.locator('#home-start-input').focus();
  const style = await page.locator('#home-start-input').evaluate(el => {
   const s = getComputedStyle(el); return { background:s.backgroundColor, border:s.borderTopWidth, shadow:s.boxShadow };
  });
  assert.deepEqual(style,{background:'rgba(0, 0, 0, 0)',border:'0px',shadow:'none'},'Composer has a single outer surface, including focus');
 }
 assert.equal(await page.locator('#build-inbox-button .nav-text').textContent(), 'Notifications');
 await page.locator('.home-new-work').screenshot({path:'/tmp/lfg-home-compose-light.png'});
 await page.screenshot({ path:'/tmp/lfg-home-light.png', fullPage:true });
 await page.evaluate(() => { document.documentElement.dataset.theme='dark'; document.body.dataset.theme='dark'; });
 await page.screenshot({ path:'/tmp/lfg-home-dark.png', fullPage:true });
 tickets = Array.from({length:5}, (_,i) => ({id:'extra'+i,name:'Review item '+i,status:'review',queueStatus:'none',updatedAt:'2026-09-08T08:00:00Z'}));
 await page.evaluate(() => window.dispatchEvent(new Event('focus')));
 await page.waitForFunction(() => document.querySelectorAll('#home-ticket-attention .home-work-row').length === 3);
 await page.locator('.home-attention-footer button').click();
 assert.equal(await page.locator('#home-attention-dialog .home-work-row').count(),5);
 await page.getByRole('button',{name:'Ignore Review item 0',exact:true}).last().click();
 assert.equal(await page.locator('#home-attention-dialog .home-attention-expanded > .home-attention-row').count(),4);
 await page.locator('#home-attention-dialog summary').click();
 await page.getByRole('button',{name:'Restore Review item 0',exact:true}).click();
 assert.equal(await page.locator('#home-attention-dialog .home-attention-expanded > .home-attention-row').count(),5);
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('#home-attention-dialog').isVisible(),false);
 tickets=[]; await page.evaluate(() => window.dispatchEvent(new Event('focus')));
 await page.waitForFunction(() => document.querySelector('#home-ticket-attention')?.textContent?.includes('Nothing needs'));
 assert.equal(await page.locator('#home-builds').isVisible(),false);
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:'/tmp/lfg-home-mobile.png',fullPage:true});
 assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No mobile horizontal overflow');
 await page.locator('#home-start-input').fill('Improve the signup flow');
 await page.locator('#home-start-form button').click();
 await page.waitForURL('**/chat/project/demo?new=1');
 assert.equal(await page.evaluate(() => sessionStorage.getItem('home-chat-draft:demo')), 'Improve the signup flow');
 assert.deepEqual(errors,[]);
 console.log('PASS: rendered scripts, review/failure/build states, chat context, empty state, mobile layout, draft handoff');
} finally { await browser.close(); }
