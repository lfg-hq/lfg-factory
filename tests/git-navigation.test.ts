// TEST-ONLY provider histories. Real workspace template, navigation, SVG renderer and CSS in Chromium.
import { test, expect } from 'bun:test';
import { chromium } from 'playwright-core';
import { ChatPage } from '../src/templates/pages/chat.tsx';
import { readFileSync, mkdirSync } from 'node:fs';
const sha = (n: number) => n.toString(16).padStart(40, '0');
test('horizontal shared ancestry, branch details, history loading, workspace tabs and narrow overflow', async () => {
  const integration = {status:'not_integrated',ahead:2,behind:0,evidence:'TEST FIXTURE comparison'};
  const row = {id:'ticket',name:'<img src=x onerror=alert(1)>',branch:'ticket/work',headSha:sha(5),baseSha:sha(6),refState:'present',destination:'epic/work',integration,activeUse:{},pullRequests:[]};
  const branchless = {...row,id:'no-branch',name:'Named branchless association',branch:null,headSha:null,refState:'no_branch'};
  const absent = {...row,id:'absent',name:'Absent remote association',branch:'ticket/absent',headSha:null,refState:'absent'};
  const unavailable = {...absent,id:'unavailable',branch:'ticket/unavailable',refState:'unavailable'};
  const counts = {total:3,associations:4,withoutBranch:1,integrated:1,notIntegrated:1,unknown:1};
  const epic = {...row,id:'epic',name:'Git branches and pull requests',epicKey:'E2',branch:'epic/work',headSha:sha(6),destination:'main',tickets:[row,branchless,absent,unavailable],ticketCounts:counts};
  const second = {...epic,id:'second',epicKey:'E1',name:'Venture Analyst',branch:'epic/analyst',headSha:sha(7),tickets:[]};
  const nodes = [{sha:sha(1),parents:[sha(0)]},{sha:sha(2),parents:[sha(1)]},{sha:sha(3),parents:[sha(2)]},{sha:sha(4),parents:[sha(2)]},{sha:sha(5),parents:[sha(4)]},{sha:sha(6),parents:[sha(3),sha(4)]},{sha:sha(7),parents:[sha(2)]}];
  nodes.forEach(n => Object.assign(n, {summary:n.sha === sha(5) ? 'TEST FIXTURE latest summary <script>' : 'TEST FIXTURE older summary', committedAt:n.sha === sha(5) ? '2026-11-01T15:59:00.000Z' : n.sha === sha(6) ? '2026-10-31T10:00:00.000Z' : null}));
  const twin = {...row,id:'twin',branch:'ticket/z-twin',name:'TEST FIXTURE shared head',pullRequests:[{id:43,title:'TEST FIXTURE draft',draft:true,merged:false,url:'https://github.com/fixture/repo/pull/43'}]};
  epic.tickets.push(twin);
  const rows = [second,epic,twin,row,absent,unavailable]; // Deliberately not activity-sorted.
  const fixture = {canManageCode:true,repository:'TEST FIXTURE / repository',correlationId:'fixture-correlation',defaultBranch:{branch:'main'},epics:[epic,second],other:[],graph:{nodes,heads:rows.map(r=>({rowId:r.id,branch:r.branch,sha:r.headSha,refState:r.refState,history:r.headSha?{complete:r.id!=='ticket',nextPage:r.id==='ticket'?2:null,errors:[]}:null})),scopes:[{id:'pending',rowIds:rows.map(r=>r.id)},{id:'epic',rowIds:[epic.id,...epic.tickets.map(t=>t.id)]},{id:'second',rowIds:['second']},{id:'other',rowIds:[]}]},pullRequests:[{id:42,title:'External draft fixture',url:'https://github.com/fixture/repo/pull/42',source:'fork/work',sourceRepo:null,destination:'epic/work',draft:true}],totals:{epics:counts,tickets:counts,other:counts},completeness:{complete:false,pullRequests:true,errors:[{code:'FIXTURE_PARTIAL'}]}};
  const html = String(await ChatPage({user:{id:'fixture',name:'Fixture',email:'fixture@example.invalid'},projectId:'fixture-project',projectName:'TEST FIXTURE'})).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace('</body>','<script src="/public/js/artifacts.js"></script><script src="/public/js/tab-overflow.js"></script><script src="/public/js/git-tab.js"></script></body>');
  let denied=false, historyCalls=0;
  const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){
    const u = new URL(req.url), path = u.pathname;
    if(path.endsWith('/history')) {historyCalls++; expect(u.searchParams.get('page')).toBe('2'); return Response.json({items:[{sha:sha(0),parents:[]}],complete:true,nextPage:null,errors:[],correlationId:'fixture-history'});}
    if(path.startsWith('/api/')) return denied?Response.json({error:'Reconnect Git in Settings.',correlationId:'fixture-failure'},{status:403}):Response.json(fixture);
    if(path.startsWith('/public/')&&!path.includes('..')){try{return new Response(readFileSync('.'+path),{headers:{'Content-Type':path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'application/octet-stream'}});}catch{return new Response('',{status:404});}}
    return new Response(html,{headers:{'Content-Type':'text/html'}});
  }});
  const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1600}}); page.setDefaultTimeout(5000);
    const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.port}/chat/project/fixture-project/`);
    expect(await page.locator('#artifacts-tabs-list .tab-button').allTextContents()).toEqual(['Docs','Tickets','Preview','Git','Env','Notes']);
    await page.locator('#artifacts-button').click();await page.evaluate(()=>(window as any).switchTab('git'));
    // Desktop workspace, not a separate mock page.
    await page.locator('#artifacts-panel').evaluate(n=>{(n as HTMLElement).style.width='1100px';(n as HTMLElement).style.maxWidth='100vw';});
    await page.waitForSelector('.git-graph-viewport');
    expect(await page.locator('.git-stats,.git-map,.git-edge').count()).toBe(0);
    expect(await page.getByRole('heading',{name:'Pending branches',exact:true}).count()).toBe(1);
    expect(await page.locator('.git-epic-tree .git-graph-viewport').count()).toBe(2);
    expect(await page.locator('#git-root img').count()).toBe(0);
    const viewport=page.locator('.git-graph-viewport').first();
    expect(await viewport.locator('.git-commit').count()).toBe(7);
    const labels = viewport.locator('.git-graph-label');
    expect(await labels.evaluateAll(ns=>ns.map(n=>n.getAttribute('aria-label')))).toEqual(['Inspect ticket/work','Inspect ticket/z-twin','Inspect epic/work','Inspect epic/analyst']);
    const textPositions = await labels.evaluateAll(ns=>ns.map(n=>({x:Number(n.querySelector('text')!.getAttribute('x')),y:Number(n.querySelector('text')!.getAttribute('y'))})));
    expect(textPositions.every(p=>p.x===48)).toBe(true); // Lane-adjacent, independent of latest commit rank.
    expect(new Set(textPositions.map(p=>p.y)).size).toBe(4); // Shared head label collision avoided.
    expect(textPositions.map(p=>p.y)).toEqual([...textPositions.map(p=>p.y)].sort((a,b)=>a-b));
    expect(await viewport.innerText()).toContain('TEST FIXTURE latest summary <script>');
    expect(await viewport.innerText()).toContain('Update time unknown');
    expect(await viewport.innerText()).toContain('2 ahead · 0 behind → epic/work');
    expect(await viewport.innerText()).not.toMatch(/checks passed|approved/);
    expect(await viewport.innerText()).toContain('PR #43 · Draft');
    expect(await viewport.innerText()).toContain('Shared head');
    expect(await page.locator('.git-epic-tree summary').first().innerText()).toContain('E2');
    expect(await page.locator('.git-epic-tree').first().evaluate(n=>(n as HTMLDetailsElement).open)).toBe(true);
    expect(await page.locator('.git-epic-tree').nth(1).evaluate(n=>(n as HTMLDetailsElement).open)).toBe(false);
    expect(await page.locator('#git-root').evaluate(n=>getComputedStyle(n).fontSize)).toBe('13px');
    const mergeEdges=viewport.locator(`path[data-child-sha="${sha(6)}"]`);
    expect(await mergeEdges.count()).toBe(2);
    const positions=await viewport.locator('[data-parent-sha]').evaluateAll(paths=>paths.map(p=>p.getAttribute('d')));
    expect(positions.every(d=>{const ns=d!.match(/[\d.]+/g)!.map(Number);return ns[0]!<ns[6]!;})).toBe(true);
    mkdirSync('/data/git-evidence',{recursive:true});
    await page.locator('#artifacts-panel').screenshot({path:'/data/git-evidence/desktop.png'});
    await page.locator('html').evaluate(n=>n.setAttribute('data-theme','light'));
    await page.locator('#artifacts-panel').screenshot({path:'/data/git-evidence/desktop-light.png'});
    const reference = await browser.newPage({viewport:{width:1100,height:1600}});
    await reference.setContent(readFileSync('.lfg/context/b31a0073-38d9-44b9-b497-00a29d721fe9.html','utf8'));
    await reference.screenshot({path:'/data/git-evidence/approved-desktop.png'});
    await reference.setViewportSize({width:390,height:844});
    await reference.screenshot({path:'/data/git-evidence/approved-narrow.png'});
    await reference.close();
    const label=page.getByRole('button',{name:'Inspect ticket/work',exact:true}).first();await label.focus();await page.keyboard.press('Enter');
    expect(await page.locator('dialog').innerText()).toContain('ticket/work → epic/work');
    expect(await page.locator('dialog').innerText()).toContain('<img src=x');
    expect(await page.getByRole('button',{name:'Create PR · review first'}).count()).toBe(1);
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'Named branchless association · No branch recorded'}).click();
    expect(await page.locator('dialog').innerText()).toContain('No branch recorded');
    expect(await page.locator('dialog button').count()).toBe(1);await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'ticket/absent · absent',exact:true}).first().click();expect(await page.locator('dialog').innerText()).toContain('Branch not found in complete remote listing');await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'ticket/unavailable · unavailable',exact:true}).first().click();expect(await page.locator('dialog').innerText()).toContain('provider listing incomplete');await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'Load further history · ticket/work',exact:true}).first().click();
    await page.waitForFunction(()=>document.querySelectorAll('.git-graph-viewport:first-of-type .git-commit').length>0);
    expect(historyCalls).toBe(1);
    await page.getByRole('button',{name:'All open PRs',exact:true}).click();expect(await page.locator('#git-root').innerText()).toContain('External draft fixture · Draft');
    await page.getByRole('button',{name:'Branch trees',exact:true}).click();
    const epicSummary = page.locator('.git-epic-tree summary').first();
    await epicSummary.focus(); await page.keyboard.press('Enter');
    expect(await page.locator('.git-epic-tree').first().evaluate(n=>(n as HTMLDetailsElement).open)).toBe(false);
    await page.keyboard.press('Enter');
    expect(await page.locator('.git-epic-tree').first().evaluate(n=>(n as HTMLDetailsElement).open)).toBe(true);
    await page.setViewportSize({width:390,height:844});
    await page.locator('#artifacts-panel').evaluate(n=>{(n as HTMLElement).style.width='390px';(n as HTMLElement).style.minWidth='0';});
    await page.locator('#artifacts-tabs-list').evaluate(n=>{(n as HTMLElement).style.flex='0 0 160px';(n as HTMLElement).style.width='160px';window.dispatchEvent(new Event('resize'));});
    await page.waitForTimeout(100);
    expect(await page.locator('.tab-button[data-tab="git"]').evaluate(n=>n.classList.contains('tab-hidden'))).toBe(true);
    await page.locator('#tab-overflow-btn').click();await page.locator('.tab-overflow-item[data-tab="git"]').focus();await page.keyboard.press('Enter');
    await page.waitForSelector('.git-graph-viewport');
    expect(await page.locator('#git-root').evaluate(n=>n.scrollWidth<=n.clientWidth+1)).toBe(true);
    expect(await viewport.evaluate(n=>n.scrollWidth>n.clientWidth)).toBe(true);
    await page.locator('#artifacts-panel').screenshot({path:'/data/git-evidence/narrow.png'});
    await page.locator('#git').evaluate(n => { n.scrollTop = 750; });
    await page.locator('#artifacts-panel').screenshot({path:'/data/git-evidence/narrow-epics.png'});
    await page.locator('#git').evaluate(n => { n.scrollTop = 0; });
    await page.locator('html').evaluate(n=>n.setAttribute('data-theme','light'));
    await page.locator('#artifacts-panel').screenshot({path:'/data/git-evidence/narrow-light.png'});
    expect(errors).toEqual([]);
    denied=true;await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('button',{name:'Retry',exact:true}).waitFor();expect(await page.locator('#git-root').innerText()).toContain('fixture-failure');
  }finally{await browser.close();server.stop(true);}
},30000);
