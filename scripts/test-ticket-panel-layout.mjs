import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

let html = execFileSync('bun', ['-e', `import {ChatPage} from './src/templates/pages/chat.tsx';console.log(String(await ChatPage({user:{id:'test',name:'Test',email:'test@example.test'},projectId:'test',projectName:'Invoice Reader with a long project name',conversationId:'test'})));`], {encoding:'utf8'});
html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, tag => {
  const path = tag.match(/href="(\/public\/css\/[^"?]+)(?:\?[^" ]*)?"/);
  return path ? `<style>${readFileSync('.' + path[1], 'utf8')}</style>` : '';
});
const browser = await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
  const page = await browser.newPage({viewport:{width:1440,height:900}});
  for (const theme of ['light','dark']) for (const width of [360,600,1000]) {
    await page.setContent(html);
    await page.evaluate(({theme,width}) => {
      document.documentElement.dataset.theme = theme;
      const chat = document.querySelector('.chat-container');
      chat.style.setProperty('flex', 'none', 'important');
      chat.style.setProperty('width', width + 'px', 'important');
      chat.style.setProperty('max-width', width + 'px', 'important');
      chat.style.setProperty('min-width', '0', 'important');
      document.querySelector('#ticket-agent-panel').style.display = 'flex';
      document.querySelector('#ta-title').textContent = 'INV-5 · Build exception review, operational audit and pilot safety coverage';
      document.querySelector('#ta-log').style.display = 'flex';
      document.querySelector('#ta-log').dataset.phaseView = 'test';
      document.querySelector('#ta-log').innerHTML = '<div class="phase-headers"><button class="phase-header">Build</button></div><div class="ticket-phase-body"></div>';
      const phase = document.querySelector('.ticket-phase-body');
      for (const text of ['Reading file', 'npm run lint && git diff --check ' + 'very-long-path/'.repeat(30)]) {
        const row = document.createElement('div'); row.className = 'ta-cmdrow';
        row.innerHTML = '<div class="ta-cmd-header"><i class="ta-chev"></i><span class="ta-cmd-text"></span><small>Activity</small></div>';
        row.querySelector('span').textContent = text; phase.append(row);
      }
    },{theme,width});
    // Finish theme/layout transitions before measuring and hit-testing.
    await page.screenshot({path:`/tmp/ticket-panel-${theme}-${width}.png`,animations:'disabled'});
    assert.equal(Math.round(await page.locator('.chat-container').evaluate(el=>el.getBoundingClientRect().width)),width);
    const geometry = await page.evaluate(() => {
      const toggle = document.querySelector('#artifacts-button'), close = document.querySelector('#ta-exit');
      const a=toggle.getBoundingClientRect(), b=close.getBoundingClientRect();
      const clickable = (el,r) => el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
      const labels=[...document.querySelectorAll('.ta-cmd-header small')].map(el=>el.getBoundingClientRect().right);
      const phase=document.querySelector('.ticket-phase-body');
      return {separate:a.bottom+8<=b.top,toggle:clickable(toggle,a),close:clickable(close,b),aligned:Math.abs(labels[0]-labels[1])<1,overflow:phase.scrollWidth>phase.clientWidth};
    });
    assert.deepEqual(geometry,{separate:true,toggle:true,close:true,aligned:true,overflow:false},`${theme} width ${width}: ${JSON.stringify(geometry)}`);
  }
  console.log('PASS: workspace toggle and ticket Close have separate clickable space; long logs stay contained and status labels align at 360/600/1000px in both themes');

  // Exercise the actual activity-card click and sidebar sizing, not just a panel
  // forced visible in a fixed-width fixture (which misses double subtraction).
  const ticket = {id:'ticket-3',ticketKey:'INV-3',name:'Invoice extraction',activityConversationId:'test',agentBusy:true,status:'in_progress'};
  let tasks = [{id:'old',description:'Original implementation',status:'success'}];
  await page.route('http://ticket-layout.test/**', route => {
    const path = new URL(route.request().url()).pathname;
    const data = path.endsWith('/tickets') ? {tickets:[ticket]}
      : path.endsWith('/chat/status') ? {busy:true}
      : path.endsWith('/tasks') ? tasks : path.endsWith('/logs') ? [] : {ticket};
    return route.fulfill({contentType:path === '/' ? 'text/html' : 'application/json',body:path === '/' ? html : JSON.stringify(data)});
  });
  for (const theme of ['light','dark']) for (const tab of [null,'filebrowser','preview']) {
    await page.goto('http://ticket-layout.test/');
    await page.evaluate(({theme,tab}) => {
      window.currentConversationId = 'test';
      localStorage.clear();
      document.documentElement.dataset.theme = theme;
      if (tab) {
        localStorage.setItem('artifacts_expanded','true');
        localStorage.setItem('artifacts_width','650');
        localStorage.setItem('artifactsActiveTab',tab);
        document.querySelectorAll('.tab-button').forEach(el => el.classList.toggle('active',el.dataset.tab === tab));
      }
    },{theme,tab});
    for (const script of ['artifacts','ticket-action-phases','ticket-agent','ticket-activity']) {
      await page.addScriptTag({path:`public/js/${script}.js`});
    }
    await page.evaluate(() => document.dispatchEvent(new Event('DOMContentLoaded')));
    assert.equal(await page.locator('#artifacts-panel').evaluate(el=>el.classList.contains('expanded')),false,'panel starts closed despite saved preference');
    if (tab) await page.locator('#artifacts-button').click();
    const activeTab = await page.locator('.tab-button.active').getAttribute('data-tab');
    if (tab) assert.equal(activeTab,tab);
    const checkPanel = async () => {
      // Let the sidebar's 300ms transition and deferred opening layout settle.
      await page.waitForTimeout(400);
      await page.waitForFunction(() => {
        const panel = document.querySelector('#ticket-agent-panel').getBoundingClientRect();
        const body = document.querySelector('.chat-body').getBoundingClientRect();
        const close = document.querySelector('#ta-exit');
        const r = close.getBoundingClientRect();
        return panel.width > 300 && Math.abs(panel.width - (body.width - 24)) < 2
          && close.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
      },null,{timeout:2000});
      assert.equal(await page.locator('.tab-button.active').getAttribute('data-tab'),activeTab,'opening a ticket must preserve the right tab');
      if (tab) assert.equal(await page.locator(`#${tab}`).evaluate(el => el.classList.contains('active')),true);
      assert.match(await page.locator('#ta-title').textContent(),/INV-3/);
    };
    await page.getByRole('button',{name:'Open ticket',exact:true}).click();
    await checkPanel();
    await page.locator('[data-ta-tab="tasks"]').click();
    await page.getByText('Original implementation',{exact:true}).waitFor();
    tasks = [...tasks.filter(t=>t.id==='old'),{id:'new',description:'Fix provider retries',status:'in_progress'}];
    await page.evaluate(() => window.TicketAgentChat.onWs({type:'tasks_updated',ticketId:'ticket-3'}));
    await page.getByText('Fix provider retries',{exact:true}).waitFor();
    assert.equal(await page.locator('[data-ta-tab="tasks"] .ta-tab-count').textContent(),'2');
    tasks = tasks.slice(0,1);
    if (tab) {
      await page.locator('#artifacts-panel').evaluate(el => { el.style.width = '560px'; });
      await page.setViewportSize({width:1280,height:900});
      await checkPanel();
    }
    await page.screenshot({path:`/tmp/ticket-open-${theme}-${tab || 'closed'}.png`,animations:'disabled'});
    await page.getByRole('button',{name:'Close ticket and return to chat'}).click();
    assert.equal(await page.locator('#ticket-agent-panel').isVisible(),false);
    if (tab) assert.equal(await page.locator('#artifacts-panel').evaluate(el => el.style.width),'650px','restore previous sidebar width');
    await page.getByRole('button',{name:'Open ticket',exact:true}).click();
    await checkPanel();
    await page.setViewportSize({width:1440,height:900});
  }
  await page.evaluate(() => { if (typeof window.ArtifactsPanel?.toggle === "function") window.ArtifactsPanel.toggle(true); });
  if (!await page.locator('#artifacts-panel').evaluate(el=>el.classList.contains('expanded'))) await page.locator('#artifacts-button').click();
  await page.evaluate(()=>window.dispatchEvent(new Event('chat-conversation-changed')));
  assert.equal(await page.locator('#artifacts-panel').evaluate(el=>el.classList.contains('expanded')),true,'same-chat completion keeps relevant panel open');
  await page.evaluate(()=>{window.currentConversationId=null;window.dispatchEvent(new Event('chat-conversation-changed'));});
  assert.equal(await page.locator('#artifacts-panel').evaluate(el=>el.classList.contains('expanded')),false,'new chat closes panel');
  console.log('PASS: Open ticket stays visible with Docs/Preview open or the sidebar closed, after resizing and reopening, in both themes');
  console.log('PASS: Tasks tab refreshes live when follow-up tasks arrive, preserving completed history');
} finally { await browser.close(); }
