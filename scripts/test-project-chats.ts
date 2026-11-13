import { chromium } from 'playwright-core';
import { ProjectDetailPage } from '../src/templates/pages/project-detail.tsx';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const SHOTS = process.env.HOME_SHOTS || '/tmp';
const ago = (days: number) => new Date(Date.now() - days * 86400000);
const conversations = [
 { id:'c1', title:'Whats the status now>', updatedAt:ago(0.1), userId:'u' },
 { id:'c2', title:'Please review this [@Carousel to video PRD](file:1', updatedAt:ago(3), userId:'u' },
 { id:'c3', title:'I want a feature to convert carousels to video wit', updatedAt:ago(20), userId:'u', pinnedAt:ago(1) },
 { id:'c4', title:'Help me figure out how to improve carousel feature', updatedAt:ago(25), userId:'other' },
 { id:'c5', title:'Hi', updatedAt:ago(60), userId:'u' }, { id:'c6', title:'Hi', updatedAt:ago(61), userId:'u' }, { id:'c7', title:null, updatedAt:ago(120), userId:'u' },
];
const chatLinks = { c3:{ messages:42, tickets:5, epics:[{ key:'KIT-E3', name:'Carousel → video (fresh)' }], summary:'All seven slides re-rendered as v3, same content as v2 so the runs can be compared side by side.' }, c2:{ messages:8, tickets:0, epics:[], summary:'One real blocker, plus two decisions I need before I can write anything down.' }, c1:{ messages:2, tickets:0, epics:[], summary:'DeepSeek has insufficient API credit. Add credit or choose another model.', failed:true }, c4:{ messages:2, tickets:0, epics:[], summary:'Carousel here means the Instagram multi-slide post format, not a front-end slider widget. You already have a scope map for it.' }, c5:{ messages:1, tickets:0, epics:[] } };
const props: any = { user:{ id:'u', name:'Jitin' }, project:{ id:'internal', projectId:'demo', name:'Kitereach', icon:'🚀', status:'active', description:null, stack:null, repoUrl:null, repoOwner:null, repoName:null }, githubConnected:true, conversations, chatLinks, stages:[], ticketCounts:{}, envVars:[], instantApps:[], activeTab:'conversations', docsCount:3, memberCount:2 };
const markup = String(await ProjectDetailPage(props));
assert(!markup.includes('](file:1'), 'markdown link syntax is stripped from titles');
for (const match of markup.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new Function(match[1]);
const browser = await chromium.launch({ executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless:true });
try {
 const page = await browser.newPage({ viewport:{ width:1440, height:1000 } });
 const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
 const calls: string[] = [];
 await page.route('**/*', async route => {
  const url = new URL(route.request().url()), path = url.pathname;
  if (path === '/projects/demo') return route.fulfill({ contentType:'text/html', body:markup });
  if (path.startsWith('/public/')) { try { return route.fulfill({ body:await readFile('.'+path), contentType:path.endsWith('.css')?'text/css':path.endsWith('.js')?'text/javascript':'application/octet-stream' }); } catch { return route.fulfill({ status:404, body:'' }); } }
  if (path.startsWith('/api/conversations/')) { calls.push(route.request().method() + ' ' + path); return route.fulfill({ json:{ ok:true } }); }
  return route.fulfill({ json:{} });
 });
 await page.addInitScript(() => { localStorage.setItem('lfg-theme','light'); localStorage.setItem('sidebarMinimized','true'); });
 await page.goto('http://lfg.test/projects/demo?tab=conversations');
 assert.equal(await page.locator('.chat-card').first().getAttribute('data-chat'), 'c3', 'the pinned chat leads');
 assert.equal(await page.locator('.chat-card').count(), 7);
 assert.equal((await page.locator('[data-chat="c2"] .chat-card-title').textContent())!.trim(), 'Please review this @Carousel to video PRD');
 assert.equal((await page.locator('[data-chat="c7"] .chat-card-title').textContent())!.trim(), 'Untitled chat');
 assert((await page.locator('[data-chat="c3"] .chat-card-top').innerText()).includes('KIT-E3'));
 assert.equal(await page.locator('[data-chat="c4"] [data-chat-delete]').count(), 0, "someone else's chat cannot be deleted");
 assert((await page.locator('[data-chat="c1"] .chat-card-summary').innerText()).startsWith('Last reply failed'));
 assert.equal(await page.locator('.chat-card-summary').count(), 7);
 await page.screenshot({ path:SHOTS+'/chats-light.png', fullPage:true });
 await page.locator('#chats-search').fill('carousel');
 assert.equal(await page.locator('.chat-card:visible').count(), 3);
 await page.locator('#chats-search').fill('zzz');
 assert.equal(await page.locator('#chats-empty').isVisible(), true);
 await page.locator('#chats-search').fill('');
 // Delete needs two clicks; clicking elsewhere disarms it.
 await page.locator('[data-chat="c6"]').hover();
 await page.locator('[data-chat="c6"] [data-chat-delete]').click();
 assert.equal(await page.locator('[data-chat="c6"] [data-chat-delete]').textContent(), 'Delete chat?');
 await page.screenshot({ path:SHOTS+'/chats-delete.png' });
 await page.locator('.chats-head h2').click();
 assert.equal(calls.length, 0);
 await page.locator('[data-chat="c6"]').hover();
 await page.locator('[data-chat="c6"] [data-chat-delete]').click();
 await page.locator('[data-chat="c6"] [data-chat-delete]').click();
 await page.waitForFunction(() => !document.querySelector('[data-chat="c6"]'));
 assert.deepEqual(calls, ['DELETE /api/conversations/c6']);
 await page.setViewportSize({ width:390, height:844 });
 assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No mobile horizontal overflow');
 assert.deepEqual(errors, []);
 console.log('PASS: chat list with summaries, pinned first, cleaned titles, context tags, search, guarded delete, mobile layout');
} finally { await browser.close(); }
