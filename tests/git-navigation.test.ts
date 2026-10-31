import { test, expect } from 'bun:test';
import { chromium } from 'playwright-core';
import { ChatPage } from '../src/templates/pages/chat.tsx';
import { readFileSync } from 'node:fs';
// Browser fixtures only. Real template, artifact switch/overflow handlers and Git UI.
test('artifact Git navigation, safe provider text, filters, collapse and mobile overflow', async () => {
  const integration = {status:'not_integrated',ahead:2,behind:0,evidence:'fixture comparison'};
  const row = {id:'fixture-ticket',name:'<img src=x onerror=alert(1)>',branch:'ticket/work',headSha:'ticket-head',baseSha:'epic-head',refState:'present',destination:'epic/work',missingRef:false,integration,activeUse:{},pullRequests:[]};
  const branchless = {...row,id:'no-branch',name:'Named branchless association',branch:null,headSha:null,refState:'no_branch',integration:{...integration,status:'unknown'}};
  const absent = {...row,id:'absent-branch',name:'Absent remote association',branch:'ticket/absent',headSha:null,missingRef:true,refState:'absent',integration:{...integration,status:'unknown'}};
  const unknown = {...absent,id:'unavailable-branch',name:'Unavailable remote association',branch:'ticket/unavailable',missingRef:false,refState:'unavailable'};
  const counts = {total:3,associations:4,withoutBranch:1,integrated:0,notIntegrated:1,unknown:2};
  const fixture = {canManageCode:true,repository:'fixture/repo',correlationId:'fixture-correlation',defaultBranch:{branch:'main'},epics:[{...row,id:'fixture-epic',name:'Fixture epic',branch:'epic/work',destination:'main',headSha:'epic-head',baseSha:'main-head',tickets:[row,branchless,absent,unknown],ticketCounts:counts}],other:[],pullRequests:[{id:42,title:'External draft fixture',url:'https://github.com/fixture/repo/pull/42',source:'fork/work',sourceRepo:null,destination:'epic/work',draft:true}],totals:{epics:{total:1,integrated:0,notIntegrated:1,unknown:0},tickets:counts,other:{total:0,integrated:0,notIntegrated:0,unknown:0}},completeness:{complete:false,pullRequests:true,errors:[{code:'FIXTURE_PARTIAL'}]}};
  const html = String(await ChatPage({user:{id:'fixture',name:'Fixture',email:'fixture@example.invalid'},projectId:'fixture-project',projectName:'Fixture'})).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace('</body>','<script src="/public/js/artifacts.js"></script><script src="/public/js/tab-overflow.js"></script><script src="/public/js/git-tab.js"></script></body>');
  let unavailable = false;
  const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){
    const path = new URL(req.url).pathname;
    if (path.startsWith('/api/')) return unavailable ? Response.json({error:'Reconnect Git in Settings.',correlationId:'fixture-failure'},{status:403}) : Response.json(fixture);
    if (path.startsWith('/public/') && !path.includes('..')) { try { return new Response(readFileSync('.'+path),{headers:{'Content-Type':path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'application/octet-stream'}}); } catch { return new Response('',{status:404}); } }
    return new Response(html,{headers:{'Content-Type':'text/html'}});
  }});
  const browser = await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    await page.goto(`http://127.0.0.1:${server.port}/chat/project/fixture-project/`);
    expect(await page.locator('#artifacts-tabs-list .tab-button').allTextContents()).toEqual(['Docs','Tickets','Preview','Git','Env','Notes']);
    await page.locator('#artifacts-button').click();
    await page.evaluate(() => (window as any).switchTab('git'));
    await page.waitForSelector('#git-root .git-stats');
    expect(await page.locator('#git-root').innerText()).toContain('FIXTURE_PARTIAL');
    expect(await page.locator('#git-root img').count()).toBe(0);
    expect(await page.locator('#git-root .git-ticket').first().innerText()).toContain('<img src=x');
    const noBranchRow = page.locator('#git-root .git-ticket').filter({hasText:'Named branchless association'});
    expect(await noBranchRow.innerText()).toContain('No branch recorded → epic/work');
    expect(await noBranchRow.innerText()).not.toMatch(/deleted|not started|unavailable|missing ref/i);
    expect(await page.locator('#git-root .git-ticket').filter({hasText:'Absent remote association'}).innerText()).toContain('Branch not found in complete remote listing');
    expect(await page.locator('#git-root .git-ticket').filter({hasText:'Unavailable remote association'}).innerText()).toContain('provider listing incomplete');
    expect(await page.locator('#git-root .git-ticket button').count()).toBe(2); // Only present ref gets write entry points.
    expect(await page.locator('#git-root .git-edge').count()).toBe(2); // Present ticket and epic only.
    expect(await page.locator('#git-root .git-map').innerText()).not.toMatch(/missing branch|ticket\/absent|ticket\/unavailable/);
    expect(await page.locator('#git-root summary').first().innerText()).toContain('4 tickets · 3 ticket branches · 1 with no branch recorded · 0 integrated into epic · 1 not integrated · 2 unknown');
    expect(await page.locator('#git-root .git-stats > div').nth(1).innerText()).toContain('3\nTicket branches');
    await page.locator('#git-root summary').first().click();
    expect(await page.locator('#git-root details').first().getAttribute('open')).toBeNull();
    await page.getByRole('button',{name:'All open PRs',exact:true}).click();
    expect(await page.locator('#git-root').innerText()).toContain('External draft fixture · Draft');
    await page.getByRole('searchbox').fill('absent');
    expect(await page.locator('#git-root').innerText()).toContain('No matching open pull requests');
    await page.getByRole('searchbox').fill('');
    await page.setViewportSize({width:390,height:844});
    await page.locator('#artifacts-panel').evaluate(n => { (n as HTMLElement).style.width='230px'; (n as HTMLElement).style.minWidth='0'; (n as HTMLElement).style.maxWidth='100vw'; });
    // Constrain the actual tab row to exercise overflow independently of mobile full-panel CSS.
    await page.locator('#artifacts-tabs-list').evaluate(n => { (n as HTMLElement).style.flex='0 0 160px'; (n as HTMLElement).style.width='160px'; window.dispatchEvent(new Event('resize')); });
    await page.waitForTimeout(100);
    const gitHidden = await page.locator('.tab-button[data-tab="git"]').evaluate(n=>n.classList.contains('tab-hidden'));
    expect(gitHidden).toBe(true);
    if (gitHidden) { await page.locator('#tab-overflow-btn').click(); await page.locator('.tab-overflow-item[data-tab="git"]').focus(); await page.keyboard.press('Enter'); }
    else { await page.locator('.tab-button[data-tab="git"]').focus(); await page.keyboard.press('Enter'); }
    expect(await page.locator('#git').evaluate(n=>n.classList.contains('active'))).toBe(true);
    await page.waitForSelector('#git-root .git-stats');
    expect(await page.locator('#git-root').evaluate(n=>n.scrollWidth <= n.clientWidth+1)).toBe(true);
    unavailable=true; await page.getByRole('button',{name:'Refresh',exact:true}).click();
    await page.waitForSelector('#git-root button');
    expect(await page.locator('#git-root').innerText()).toContain('fixture-failure');
    expect(await page.getByRole('button',{name:'Retry',exact:true}).count()).toBe(1);
  } finally { await browser.close(); server.stop(true); }
}, 30_000);
