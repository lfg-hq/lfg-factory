import { chromium } from 'playwright-core';
import { ProjectDetailPage } from '../src/templates/pages/project-detail.tsx';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const props = { user: { id: 'u', name: 'Jitin' }, project: { id: 'internal', projectId: 'demo', name: 'CoHire', icon: '🚀', status: 'active', description: null, stack: null, repoUrl: 'https://example.com/repo', repoOwner: 'cohire', repoName: 'cohire' }, githubConnected: true, conversations: [{ id: 'chat1', title: 'Training institutions page redesign', updatedAt: new Date() }], stages: [], ticketCounts: {}, envVars: [], instantApps: [], activeTab: 'home', docsCount: 3, memberCount: 2 };
const markup = String(await ProjectDetailPage(props));
const viewerMarkup = String(await ProjectDetailPage({...props,role:'viewer'}));
const SHOTS = process.env.HOME_SHOTS || '/tmp';
assert(!viewerMarkup.includes('id="dash-compose"'), 'viewers cannot start a chat');
assert(markup.includes('id="dash-compose"') && markup.includes('id="dash-queue"') && markup.includes('id="home-activity"'));
// Parse every inline script: template escapes must survive server rendering.
for (const match of markup.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new Function(match[1]);

const ago = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
const queue = () => [
 { id:'failed:t14', kind:'failed', group:'problem', title:'COH-14 failed: Export pipeline', detail:'Carousel to video · 2 tickets waiting behind it · The export test timed out after 30 seconds.', at:ago(38), action:'View issue', targetId:'t14', waiting:[{id:'t22',key:'COH-22',name:'Publish to TikTok'},{id:'t23',key:'COH-23',name:'Share links'}] },
 { id:'question:q1', kind:'question', group:'question', title:'The agent needs a decision on COH-18', detail:'Which aspect ratios should video export support?', body:'Which aspect ratios should video export support? The PRD says "export for social" without naming formats.', at:ago(12), action:'Answer', targetId:'t18', options:['9:16 only','9:16 and 1:1'] },
 { id:'mention:n1', kind:'mention', group:'question', title:'Priya: Should export progress block the editor?', detail:'Mentioned you', at:ago(60), action:'Open', targetId:'n1', link:'/projects/demo/tickets?ticket=t19' },
 { id:'epic:e2', kind:'epic_review', group:'review', title:'Marketing page is ready to review', detail:'Epic COH-E2 · 2 tickets built · preview is live', at:ago(120), action:'Review', targetId:'e2' },
 { id:'ticket:t30', kind:'ticket_review', group:'review', title:'Brand kit loader refactor is ready to review', detail:'COH-30 · built · pull request open', at:ago(180), action:'Review code', targetId:'t30' },
];
let dash: any = {
 queue: queue(),
 inProgress: [
  { id:'t17', key:'COH-17', name:'Render slides to MP4', epic:'Carousel to video', stage:'testing', label:'Testing in the browser', active:true, update:'Checking the exported file plays end to end.', at:ago(6) },
  { id:'t19', key:'COH-19', name:'Export progress UI', epic:'Carousel to video', stage:'queued', label:'Queued', active:false, update:null, at:ago(40) },
 ],
 waiting: [{ id:'t22', key:'COH-22', name:'Publish to TikTok', epic:'Carousel to video' }],
 stats: { needsYou:5, building:1, queued:1, waiting:2, ready:6, total:12 },
 epics: [
  { id:'e3', name:'Carousel to video', epicKey:'COH-E3', status:'building', previewUrl:null, states:['ready','ready','building','queued','failed','waiting','waiting'], total:7, review:null },
  { id:'e2', name:'Marketing page', epicKey:'COH-E2', status:'in_review', previewUrl:'https://preview.example.com/marketing', states:['ready','ready'], total:2, review:'review' },
  { id:'e1', name:'Older feature', epicKey:'COH-E1', status:'merged', previewUrl:'javascript:alert(1)', states:['ready','ready','ready'], total:3, review:null },
 ],
 preview: { epicId:'e2', name:'Marketing page', url:'https://preview.example.com/marketing', at:ago(120) },
 docs: [{ id:'d1', name:'PRD: Carousel to video', at:ago(2000) }],
 hasWork: true,
};
const epicDetail = { epic:{ id:'e2', name:'Marketing page', epicKey:'COH-E2', status:'in_review', goal:'A marketing page that explains the product in one screen.', previewUrl:'https://preview.example.com/marketing', branch:'epic/coh-e2-marketing' },
 tickets:[{ id:'t5', name:'Hero section', ticketKey:'COH-5', status:'review', queueStatus:'none', githubBranch:'feature/coh-5' },{ id:'t6', name:'Pricing table', ticketKey:'COH-6', status:'review', queueStatus:'none', githubBranch:'feature/coh-6' }],
 docs:[{ id:'d2', name:'Scope: Marketing page' }], mergeBlockers:[], canMerge:true };
const posts: { path: string; body: any }[] = [];

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
 const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
 const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
 await page.route('**/*', async route => {
  const url = new URL(route.request().url()), path = url.pathname;
  if (path === '/projects/demo') return route.fulfill({ contentType:'text/html', body:markup });
  if (path.startsWith('/public/')) {
   try { return route.fulfill({ body:await readFile('.'+path), contentType:path.endsWith('.css')?'text/css':path.endsWith('.js')?'text/javascript':'application/octet-stream' }); } catch { return route.fulfill({ status:404, body:'' }); }
  }
  if (route.request().method() === 'POST') {
   posts.push({ path, body: JSON.parse(route.request().postData() || '{}') });
   const id = path.includes('/epics/e2/') ? 'epic:e2' : path.includes('/t18/') ? 'question:q1' : path.includes('/t14/') ? 'failed:t14' : path.includes('/t30/') ? 'ticket:t30' : 'mention:n1';
   dash = { ...dash, queue: dash.queue.filter((i: any) => i.id !== id) };
   return route.fulfill({ json:{ ok:true } });
  }
  if (path.endsWith('/boards')) return route.fulfill({ json:{ boards:[], connections:[] } });
  if (path.endsWith('/home')) return route.fulfill({ json:{ dash, activities:[{ activityType:'ticket_built', title:'COH-16 passed its checks', createdAt:ago(30) }], notifications:[], members:{ owner:{name:'Jitin'},members:[] }, pins:[] } });
  if (path === '/api/epics/e2') return route.fulfill({ json:epicDetail });
  if (path.endsWith('/epics/e2/changes')) return route.fulfill({ json:{ files:[{ file:'src/pages/marketing.tsx', additions:2, deletions:1, patch:'@@ -1,3 +1,4 @@\n export function Marketing() {\n-  return null;\n+  const title = "<Kitereach>";\n+  return title;\n }', truncated:false }], hidden:1 } });
  if (path.endsWith('/tickets/t30')) return route.fulfill({ json:{ ticket:{ id:'t30', name:'Brand kit loader refactor', ticketKey:'COH-30', description:'Load brand kits once and share them across slides.', acceptanceCriteria:['Kits load once per session'], githubBranch:'feature/coh-30', githubPrUrl:'https://github.com/cohire/app/pull/30' }, logs:[{ logType:'ai_response', command:'Moved the loader behind a small cache.' }] } });
  if (path.endsWith('/tickets/t30/git/diff')) return route.fulfill({ json:{ files:[{ path:'src/brand/cache.ts', added:2, removed:0 }], diff:'diff --git a/src/brand/cache.ts b/src/brand/cache.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/brand/cache.ts\n@@ -0,0 +1,2 @@\n+const TTL_MS = 600000;\n+export const cache = new Map();\n' } });
  if (path.endsWith('/tickets/t14/logs')) return route.fulfill({ json:[{ message:'render slide 12/12 ok' },{ message:'FAIL export.test.ts (30000ms timeout)' }] });
  return route.fulfill({ json:{} });
 });
 await page.addInitScript(() => { localStorage.setItem('lfg-theme','light'); localStorage.setItem('sidebarMinimized','true'); });
 await page.goto('http://lfg.test/projects/demo');
 await page.waitForFunction(() => document.querySelectorAll('#dash-queue .dash-row').length === 5);

 // The dashboard: status line, queue order, live work, epics and safe links.
 assert.match(await page.locator('#dash-status').innerText(), /5 need you[\s\S]*1 building[\s\S]*6 of 12 tickets ready/);
 assert.equal(await page.locator('#dash-queue .dash-row-title').first().textContent(), 'COH-14 failed: Export pipeline');
 assert.equal(await page.locator('#dash-progress .dash-row').count(), 3);
 assert.equal(await page.locator('#dash-epics .dash-row').count(), 3);
 assert.equal(await page.locator('#dash-epics .dash-bar').first().locator('i.failed').count(), 1);
 assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
 assert.equal(await page.locator('#dash-preview a').getAttribute('href'), 'https://preview.example.com/marketing');
 assert.equal(await page.locator('#build-inbox-button .nav-text').textContent(), 'Notifications');
 await page.screenshot({ path:SHOTS+'/home-light.png', fullPage:true });
 await page.getByRole('button', { name:/^Reviews/ }).click();
 assert.equal(await page.locator('#dash-queue .dash-row').count(), 2);
 await page.getByRole('button', { name:/^All/ }).click();

 // Review an epic: goal, tickets, changed lines (escaped), then approve.
 await page.locator('[data-open="epic:e2"]').click();
 await page.waitForSelector('.dash-file');
 assert.equal(await page.locator('.dash-panel h2').textContent(), 'Marketing page');
 assert.equal(await page.locator('.dash-panel .dash-box-row').count(), 3);
 assert((await page.locator('.dash-file pre').first().innerText()).includes('<Kitereach>'));
 assert.equal(await page.locator('.dash-panel-foot .dash-btn.primary').textContent(), 'Approve');
 await page.screenshot({ path:SHOTS+'/home-panel-epic.png' });
 await page.getByRole('button', { name:'Approve' }).click();
 await page.waitForSelector('.dash-done');
 assert.equal(posts.at(-1)!.path, '/api/epics/e2/approve');
 await page.waitForFunction(() => document.querySelectorAll('#dash-queue .dash-row').length === 4);
 await page.screenshot({ path:SHOTS+'/home-panel-done.png' });

 // "Next up" leads straight into the failed build; retry carries the note.
 await page.locator('.dash-panel [data-open="failed:t14"]').click();
 await page.waitForSelector('.dash-log');
 assert.equal(await page.locator('.dash-panel .dash-box-row').count(), 2);
 await page.locator('#dash-retry-note').fill('Raise the timeout');
 await page.screenshot({ path:SHOTS+'/home-panel-failed.png' });
 await page.getByRole('button', { name:'Retry build' }).click();
 await page.waitForSelector('.dash-done');
 assert.deepEqual(posts.at(-1), { path:'/api/projects/demo/tickets/t14/queue', body:{ notes:'Raise the timeout' } });
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('.dash-panel').count(), 0);

 // Answer the agent: an empty answer is refused, an option fills it in.
 await page.locator('[data-open="question:q1"]').click();
 await page.getByRole('button', { name:'Send answer' }).click();
 assert.equal(await page.locator('.dash-panel-error').isVisible(), true);
 await page.getByRole('button', { name:'9:16 only' }).click();
 await page.screenshot({ path:SHOTS+'/home-panel-question.png' });
 await page.getByRole('button', { name:'Send answer' }).click();
 await page.waitForSelector('.dash-done');
 assert.deepEqual(posts.at(-1), { path:'/api/projects/demo/tickets/t18/chat', body:{ message:'9:16 only' } });
 await page.keyboard.press('Escape');

 // Code review reads the existing ticket diff and links to the full one.
 await page.locator('[data-open="ticket:t30"]').click();
 await page.waitForSelector('.dash-file');
 assert((await page.locator('.dash-file summary').innerText()).includes('src/brand/cache.ts'));
 assert.equal(await page.getByRole('link', { name:'Open full diff' }).getAttribute('href'), '/projects/demo/tickets/t30/diff');
 await page.screenshot({ path:SHOTS+'/home-panel-code.png' });
 await page.keyboard.press('Escape');

 await page.evaluate(() => { document.documentElement.dataset.theme='dark'; document.body.dataset.theme='dark'; });
 await page.screenshot({ path:SHOTS+'/home-dark.png', fullPage:true });
 await page.evaluate(() => { document.documentElement.dataset.theme='light'; document.body.dataset.theme='light'; });

 // Nothing waiting: the queue says so instead of disappearing.
 dash = { ...dash, queue:[], stats:{ ...dash.stats, needsYou:0 } };
 await page.evaluate(() => window.dispatchEvent(new Event('focus')));
 await page.waitForFunction(() => document.querySelector('#dash-queue')?.textContent?.includes('all caught up'));
 await page.screenshot({ path:SHOTS+'/home-caught-up.png', fullPage:true });

 // Mobile, then the composer hands its text to a new chat.
 await page.setViewportSize({ width:390, height:844 });
 await page.screenshot({ path:SHOTS+'/home-mobile.png', fullPage:true });
 assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No mobile horizontal overflow');
 // An epic without a preview offers no preview button (a null URL must not become a link).
 await page.locator('[data-epic="e2"]').click();
 await page.waitForSelector('.dash-panel .dash-box');
 assert.equal(await page.getByRole('link', { name:/Open live preview/ }).count(), 1);
 await page.keyboard.press('Escape');
 epicDetail.epic.previewUrl = null as any;
 await page.locator('[data-epic="e2"]').click();
 await page.waitForSelector('.dash-panel .dash-box');
 assert.equal(await page.getByRole('link', { name:/Open live preview/ }).count(), 0);
 await page.keyboard.press('Escape');

 // Attach files, remove one, then the text and the files travel to the new chat.
 await page.locator('#dash-file-input').setInputFiles([{ name:'brief.pdf', mimeType:'application/pdf', buffer:Buffer.from('pdf') }, { name:'notes.txt', mimeType:'text/plain', buffer:Buffer.from('hello') }]);
 assert.equal(await page.locator('.dash-file-chip').count(), 2);
 await page.getByRole('button', { name:'Remove brief.pdf' }).click();
 assert.equal(await page.locator('.dash-file-chip').count(), 1);
 await page.screenshot({ path:SHOTS+'/home-attach-mobile.png' });
 await page.locator('#dash-compose-input').fill('Add scheduled posting');
 await page.locator('#dash-compose-input').press('Enter');
 await page.waitForURL('**/chat/project/demo?new=1');
 assert.equal(await page.evaluate(() => sessionStorage.getItem('home-chat-draft:demo')), 'Add scheduled posting');
 // The chat page's own pickup code takes the files exactly once.
 const takeHomeFiles = /function takeHomeFiles\(\) \{[\s\S]*?\n    \}\n/.exec(await readFile('public/js/chat.js', 'utf8'))![0];
 const taken = await page.evaluate(async (source) => {
  const got: string[] = []; (window as any).attachFileToComposer = (f: File) => got.push(f.name + ':' + f.size);
  const run = new Function('currentProjectId', source + '; takeHomeFiles();');
  run('demo'); await new Promise(r => setTimeout(r, 300)); run('demo'); await new Promise(r => setTimeout(r, 300));
  return got;
 }, takeHomeFiles);
 assert.deepEqual(taken, ['notes.txt:5']);

 // A brand-new project: no empty panels, just how to start.
 const fresh = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
 fresh.on('pageerror', e => errors.push(e.message));
 const freshMarkup = String(await ProjectDetailPage({ ...props, conversations: [] }));
 await fresh.route('**/*', async route => {
  const path = new URL(route.request().url()).pathname;
  if (path === '/projects/demo') return route.fulfill({ contentType:'text/html', body:freshMarkup });
  if (path.startsWith('/public/')) { try { return route.fulfill({ body:await readFile('.'+path), contentType:path.endsWith('.css')?'text/css':path.endsWith('.js')?'text/javascript':'application/octet-stream' }); } catch { return route.fulfill({ status:404, body:'' }); } }
  if (path.endsWith('/home')) return route.fulfill({ json:{ dash:{ queue:[], inProgress:[], waiting:[], stats:{ needsYou:0, building:0, queued:0, waiting:0, ready:0, total:0 }, epics:[], preview:null, docs:[], hasWork:false }, activities:[], notifications:[], members:{ owner:{name:'Jitin'},members:[] }, pins:[] } });
  return route.fulfill({ json:{ boards:[], connections:[] } });
 });
 await fresh.addInitScript(() => { localStorage.setItem('lfg-theme','light'); localStorage.setItem('sidebarMinimized','true'); });
 await fresh.goto('http://lfg.test/projects/demo');
 await fresh.waitForSelector('.home-dashboard.is-new');
 assert.equal(await fresh.locator('.dash-onboard').isVisible(), true);
 assert.equal(await fresh.locator('#dash-queue').isVisible(), false);
 await fresh.screenshot({ path:SHOTS+'/home-new-project.png', fullPage:true });

 assert.deepEqual(errors, []);
 console.log('PASS: dashboard queue, filters, epic review and approve, retry with note, agent answer, code review diff, caught-up state, mobile layout, missing preview, chat handoff with attached files, new-project state');
} finally { await browser.close(); }
