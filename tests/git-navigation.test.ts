// TEST-ONLY labelled provider data; real workspace shell, renderer and CSS in Chromium. No mutations.
import { test, expect } from 'bun:test';
import { chromium } from 'playwright-core';
import { ChatPage } from '../src/templates/pages/chat.tsx';
import { readFileSync, mkdirSync } from 'node:fs';
const sha = (n: number) => n.toString(16).padStart(40, '0');
test('readable status maps, stable rows, bounded right drawer, advanced ancestry and responsive shell', async () => {
  const integration = {status:'integrated',ahead:0,behind:3,evidence:'TEST FIXTURE current revision contained'};
  const pending = {...integration,status:'not_integrated',ahead:2};
  const unknown = {...integration,status:'unknown',ahead:null,behind:null};
  const row = {id:'ticket',name:'TEST FIXTURE readable ticket title <img src=x>',branch:'ticket/work-full-reference',headSha:sha(5),baseSha:sha(6),refState:'present',destination:'epic/work',integration,activeUse:{preview:true},pullRequests:[]};
  const branchless = {...row,id:'no-branch',name:'TEST FIXTURE branchless',branch:null,headSha:null,refState:'no_branch',integration:unknown,activeUse:{}};
  const absent = {...row,id:'absent',name:'TEST FIXTURE absent',branch:'ticket/absent',headSha:null,refState:'absent',integration:unknown,activeUse:{}};
  const unavailable = {...absent,id:'unavailable',name:'TEST FIXTURE unavailable',branch:'ticket/unavailable',refState:'unavailable'};
  const twin = {...row,id:'twin',name:'TEST FIXTURE shared head',branch:'ticket/z-twin',activeUse:{},pullRequests:[{id:43,title:'TEST FIXTURE draft',draft:true,url:'https://github.com/fixture/repo/pull/43'}]};
  const counts = {total:4,associations:5,withoutBranch:1,integrated:2,notIntegrated:0,unknown:2};
  const epic = {...row,id:'epic',name:'Git branches and pull requests',epicKey:'E2',branch:'epic/work',headSha:sha(6),destination:'epic/parent',activeUse:{},defaultComparison:{branch:'release',integration:pending},tickets:[unavailable,absent,twin,row,branchless],ticketCounts:counts};
  const second = {...epic,id:'second',epicKey:'E1',name:'Venture Analyst',branch:'epic/parent',headSha:sha(7),destination:'release',tickets:[],defaultComparison:{branch:'release',integration:unknown}};
  const nodes = [{sha:sha(1),parents:[]},{sha:sha(2),parents:[sha(1)]},{sha:sha(5),parents:[sha(2)]},{sha:sha(6),parents:[sha(2),sha(5)]},{sha:sha(7),parents:[]}].map(n=>({...n,summary:'TEST FIXTURE commit information',committedAt:n.sha===sha(5)?'2026-11-01T15:59:00Z':n.sha===sha(6)?'2026-10-31T10:00:00Z':null}));
  const rows = [epic,second,row,twin,absent,unavailable];
  const fixture = {canManageCode:true,repository:'TEST FIXTURE / repository',correlationId:'fixture-correlation',defaultBranch:{branch:'release'},epics:[second,epic],other:[],graph:{nodes,heads:rows.map(r=>({rowId:r.id,branch:r.branch,sha:r.headSha,refState:r.refState,history:{complete:true,errors:[]}})),scopes:[{id:'pending',rowIds:rows.map(r=>r.id)}]},pullRequests:[{id:42,title:'TEST FIXTURE External draft',url:'https://github.com/fixture/repo/pull/42',source:'fork/work',sourceRepo:null,destination:'epic/work',draft:true}],completeness:{complete:false,pullRequests:false,errors:[{code:'FIXTURE_PARTIAL'}]}};
  const html = String(await ChatPage({user:{id:'fixture',name:'Fixture',email:'fixture@example.invalid'},projectId:'fixture-project',projectName:'TEST FIXTURE'})).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace('</body>','<script src="/public/js/artifacts.js"></script><script src="/public/js/tab-overflow.js"></script><script src="/public/js/git-tab.js"></script></body>');
  let denied=false;
  const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){
    const path=new URL(req.url).pathname;
    if(path.startsWith('/api/')) return denied?Response.json({error:'Reconnect Git in Settings.',correlationId:'fixture-failure'},{status:403}):Response.json(fixture);
    if(path.startsWith('/public/')&&!path.includes('..')){try{return new Response(readFileSync('.'+path),{headers:{'Content-Type':path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'application/octet-stream'}});}catch{return new Response('',{status:404});}}
    return new Response(html,{headers:{'Content-Type':'text/html'}});
  }});
  const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1100}});page.setDefaultTimeout(5000);
    const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.port}/chat/project/fixture-project/`);
    expect(await page.locator('#artifacts-tabs-list .tab-button').allTextContents()).toEqual(['Docs','Tickets','Preview','Git','Env','Notes']);
    await page.locator('#artifacts-button').click();await page.evaluate(()=>(window as any).switchTab('git'));
    await page.locator('#artifacts-panel').evaluate(n=>{(n as HTMLElement).style.width='1100px';(n as HTMLElement).style.maxWidth='100vw';});
    await page.waitForSelector('.git-status-map');
    await page.waitForTimeout(500); // Existing artifact-shell opening transition must settle before geometry checks.
    expect(await page.getByRole('heading',{name:'Repository overview · release',exact:true}).count()).toBe(1);
    expect(await page.locator('.git-stats,.git-card,.git-graph-viewport').count()).toBe(0);
    expect(await page.getByRole('button',{name:/Load further history/}).count()).toBe(0);
    expect(await page.locator('#git-root img').count()).toBe(0);
    expect(await page.locator('.git-epic-tree summary').first().innerText()).toContain('E2');
    const map=page.locator('.git-epic-tree .git-status-map').first();
    expect(await map.locator('[data-row-id]').evaluateAll(ns=>ns.map(n=>(n as HTMLElement).dataset.rowId))).toEqual(['ticket','twin','no-branch','absent','unavailable']);
    expect(await map.innerText()).toContain('TICKET · TEST FIXTURE readable ticket title');
    expect(await map.innerText()).toContain('BRANCH · ticket/work-full-reference');
    expect(await map.innerText()).toContain('Included in epic/work');
    expect(await map.innerText()).toContain('Unknown in epic/work');
    expect(await map.innerText()).toContain('Open PRs unknown');
    expect(await map.innerText()).toContain('#43');
    expect(await page.locator('.git-overview-map').innerText()).toContain('Not included in release');
    expect(await page.locator('.git-overview-map').innerText()).toContain('Parent destination · epic/parent');
    const name=map.locator('[data-row-id="ticket"]'); const before=await name.boundingBox();
    const select=map.locator('[data-select-id="ticket"]');await select.focus();await page.keyboard.press('Enter');
    const drawer=page.getByRole('dialog',{name:'Branch details'});
    expect(await drawer.innerText()).toContain('Current SHA · '+sha(5));
    expect(await drawer.innerText()).toContain('Intended destination · epic/work');
    expect(await drawer.innerText()).toContain('Currently in Preview');
    expect(await drawer.innerText()).toContain('TEST FIXTURE commit information');
    expect(await name.boundingBox()).toEqual(before);
    let bounds=await drawer.boundingBox();expect(bounds!.x+bounds!.width).toBe(1440);expect(bounds!.width).toBeLessThanOrEqual(420);expect(bounds!.height).toBeLessThanOrEqual(1100);
    mkdirSync('/data/git-evidence',{recursive:true});
    await page.screenshot({path:'/data/git-evidence/desktop-drawer.png'});
    await page.keyboard.press('Escape');expect(await select.evaluate(n=>n===document.activeElement)).toBe(true);
    await page.locator('#artifacts-panel').screenshot({path:'/data/git-evidence/desktop.png'});
    await page.locator('html').evaluate(n=>n.setAttribute('data-theme','light'));
    await page.locator('#artifacts-panel').screenshot({path:'/data/git-evidence/desktop-light.png'});
    expect(await map.locator('.git-integrated').first().evaluate(n=>getComputedStyle(n).color)).not.toBe(await map.locator('.git-unknown').first().evaluate(n=>getComputedStyle(n).color));
    await page.locator('html').evaluate(n=>n.setAttribute('data-theme','dark'));
    for(const [id,text] of [['no-branch','No branch recorded'],['absent','Branch not found in complete remote listing'],['unavailable','provider listing incomplete']]){
      await map.locator(`[data-select-id="${id}"]`).click();expect(await drawer.innerText()).toContain(text);await page.getByRole('button',{name:'Close ×',exact:true}).click();
    }
    // Refresh changes activity but must not reorder established rows or collapse state.
    nodes.find(n=>n.sha===sha(7))!.committedAt='2026-11-02T10:00:00Z';
    await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.waitForSelector('.git-status-map');
    expect(await page.locator('.git-epic-tree summary').first().innerText()).toContain('E2');
    expect(await map.locator('[data-row-id]').evaluateAll(ns=>ns.map(n=>(n as HTMLElement).dataset.rowId))).toEqual(['ticket','twin','no-branch','absent','unavailable']);
    await page.getByRole('button',{name:'All open PRs',exact:true}).click();expect(await page.locator('#git-root').innerText()).toContain('TEST FIXTURE External draft · Draft');
    await page.getByRole('button',{name:'Branch map',exact:true}).click();
    await page.locator('.git-advanced summary').click();await page.waitForSelector('.git-graph-viewport');
    expect(await page.locator(`path[data-child-sha="${sha(6)}"]`).count()).toBe(2);
    expect(await page.locator(`path[data-child-sha="${sha(7)}"]`).count()).toBe(0);
    await page.locator('.git-advanced summary').click();
    const reference=await browser.newPage({viewport:{width:1100,height:1100}});
    await reference.setContent(readFileSync('.lfg/context/856179bd-5abb-43e4-a2cf-6b9caca72b62.html','utf8'));
    await reference.screenshot({path:'/data/git-evidence/approved-desktop.png'});
    await reference.setViewportSize({width:390,height:844});await reference.screenshot({path:'/data/git-evidence/approved-narrow.png'});await reference.close();
    await page.setViewportSize({width:390,height:844});
    await page.locator('#artifacts-panel').evaluate(n=>{(n as HTMLElement).style.width='390px';(n as HTMLElement).style.minWidth='0';});
    expect(await page.locator('#git-root').evaluate(n=>n.scrollWidth<=n.clientWidth+1)).toBe(true);
    expect(await page.locator('.git-epic-tree .git-map-scroll').first().evaluate(n=>n.scrollWidth>n.clientWidth)).toBe(true);
    await page.locator('#artifacts-panel').screenshot({path:'/data/git-evidence/narrow.png'});
    await select.click();bounds=await drawer.boundingBox();expect(bounds!.x).toBeGreaterThanOrEqual(0);expect(bounds!.x+bounds!.width).toBe(390);expect(bounds!.height).toBeLessThanOrEqual(844);
    expect(await drawer.evaluate(n=>n.scrollWidth<=n.clientWidth+1)).toBe(true);
    await page.getByRole('button',{name:'Close ×',exact:true}).focus();await page.keyboard.press('Shift+Tab');
    expect(await drawer.locator('button').last().evaluate(n=>n===document.activeElement)).toBe(true);
    await page.screenshot({path:'/data/git-evidence/narrow-drawer.png'});await page.keyboard.press('Escape');
    expect(await select.evaluate(n=>n===document.activeElement)).toBe(true);
    expect(errors).toEqual([]);
    denied=true;await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('button',{name:'Retry',exact:true}).waitFor();expect(await page.locator('#git-root').innerText()).toContain('fixture-failure');
  } finally {await browser.close();server.stop(true);}
},30000);
