import {chromium} from 'playwright-core';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 const page=await browser.newPage();let fail=false,count=34;
 await page.route('http://switcher.test/**',route=>{
  if(new URL(route.request().url()).pathname==='/api/project-switcher')return route.fulfill({status:fail?500:200,contentType:'application/json',body:JSON.stringify({projects:[{id:'invoice',name:'Invoice Reader',unread:count},{id:'demo',name:'Jev Demo',unread:0},{id:'escaped',name:'<script>project</script>',unread:2}]})});
  return route.fulfill({contentType:'text/html',body:'<body><aside id="sidebar" data-current-project-id="invoice"><a class="project-dropdown-trigger" href="/projects"><span class="project-name-text">Projects</span></a></aside><button id="outside">Outside</button></body>'});
 });
 for(const dark of [false,true])for(const width of [390,1440]){
  await page.setViewportSize({width,height:800});await page.goto('http://switcher.test');
  for(const file of ['theme-variables','common','sidebar','artifacts','document-comments','chat','artifacts-fix','polish','light/light-mode','project-switcher']) await page.addStyleTag({content:readFileSync('public/css/'+file+'.css','utf8')});
  await page.evaluate(dark=>document.documentElement.dataset.theme=dark?'dark':'light',dark);
  await page.addScriptTag({path:'public/js/project-switcher.js'});
  await page.getByRole('link',{name:'Switch project',exact:true}).click();
  await page.waitForSelector('.project-switcher-row');
  assert.equal(await page.locator('.project-switcher-row').count(),3);
  const style=await page.locator('.is-current').evaluate(el=>({background:getComputedStyle(el).backgroundColor,color:getComputedStyle(el).color,height:el.getBoundingClientRect().height}));
  assert.equal(style.background,'rgba(124, 58, 237, 0.09)');
  assert.ok(style.height<=38);
  assert.equal(style.color,await page.locator('#project-switcher').evaluate(el=>getComputedStyle(el).color));
  assert.equal(await page.locator('[aria-current="page"]').getAttribute('href'),'/chat/project/invoice');
  assert.equal(await page.locator('.is-current .project-switcher-badge').textContent(),'34');
  assert.equal(await page.locator('.project-switcher-row').nth(1).locator('.project-switcher-badge').count(),0);
  await page.getByRole('searchbox').fill('jev');assert.equal(await page.locator('.project-switcher-row').count(),1);
  await page.getByRole('searchbox').press('ArrowDown');assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('href')),'/chat/project/demo');
  await page.keyboard.press('Escape');assert.equal(await page.locator('#project-switcher').isVisible(),false);
  await page.getByRole('link',{name:'Switch project',exact:true}).click();
  await page.getByRole('searchbox').fill('missing');await page.getByText('No matching projects.').waitFor();
  await page.getByRole('searchbox').fill('');await page.screenshot({path:`/tmp/project-switcher-${dark?'dark':'light'}-${width}.png`});
  const r=await page.locator('#project-switcher').boundingBox();assert.ok(r.x>=0&&r.x+r.width<=width);
  await page.locator('#outside').click();assert.equal(await page.locator('#project-switcher').isVisible(),false);
 }
 fail=true;await page.getByRole('link',{name:'Switch project',exact:true}).click();await page.getByText('Could not load projects.').waitFor();
 fail=false;count=5;await page.getByRole('button',{name:'Try again'}).click();await page.waitForFunction(()=>document.querySelector('.is-current .project-switcher-badge')?.textContent==='5');
 count=0;await page.evaluate(()=>window.dispatchEvent(new Event('project-notifications-changed')));await page.waitForFunction(()=>!document.querySelector('.is-current .project-switcher-badge'));
 console.log('PASS: current project, unread counts, live refresh, search, keyboard, escaping, retry and mobile/dark layouts');
}finally{await browser.close();}
