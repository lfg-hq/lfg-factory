import {chromium} from 'playwright-core';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1200,height:800}});
 let offline=false;
 const activities=[{id:'1',ticketId:'ticket1',activityType:'ticket_failed',title:'Failed: Redesign TrainingInstitutions page',description:'Push failed. Reconnect the repository to retry.',createdAt:'2026-09-08T08:00:00Z'},{id:'2',ticketId:'ticket1',activityType:'ticket_started',title:'Build started: Redesign TrainingInstitutions page',createdAt:'2026-09-08T07:00:00Z'},{id:'3',ticketId:'ticket2',activityType:'git_pushed',title:'Changes pushed to feature branch',createdAt:'2026-09-07T08:00:00Z'}];
 await page.route('**/*',async route=>{
  if(route.request().url().includes('/api/activities')) return route.fulfill(offline?{status:500,body:''}:{json:{activities}});
  return route.fulfill({contentType:'text/html',body:'<html data-theme="light"><body><main id="events-tab-container" data-project-id="demo"><header class="activity-heading"><div><h2>Activity</h2><p>Builds, changes, and updates across your project.</p></div><span id="activity-sync"></span></header><div class="activity-toolbar"><div class="activity-filters"><button data-activity-filter="all" aria-pressed="true">All activity</button><button data-activity-filter="builds">Builds</button><button data-activity-filter="git">Git changes</button><button data-activity-filter="attention">Needs attention</button></div><button id="activity-refresh">Refresh</button></div><div id="events-timeline-container"></div></main></body></html>'});
 });
 await page.goto('http://lfg.test/');
 for(const f of ['theme-variables.css','events-timeline.css']) await page.addStyleTag({content:await readFile('public/css/'+f,'utf8')});
 await page.addStyleTag({content:'body{font-family:Arial,sans-serif;background:var(--background-color);margin:32px}'});
 await page.addScriptTag({path:'public/js/events-timeline.js'});
 await page.waitForSelector('.activity-row');
 assert.equal(await page.locator('.activity-row').count(),3);
 assert.equal(await page.locator('.activity-day').count(),2);
 assert.equal(await page.locator('.activity-title').first().getAttribute('href'),'/projects/demo/tickets?ticket=ticket1');
 await page.screenshot({path:'/tmp/lfg-activity-light.png'});
 await page.evaluate(()=>document.documentElement.dataset.theme='dark');
 await page.screenshot({path:'/tmp/lfg-activity-dark.png'});
 await page.locator('[data-activity-filter="attention"]').click();assert.equal(await page.locator('.activity-row').count(),1);
 await page.locator('[data-activity-filter="git"]').click();assert.equal(await page.locator('.activity-row').count(),1);
 await page.locator('#activity-refresh').click();await page.waitForFunction(()=>!document.getElementById('activity-refresh').disabled);assert.equal(await page.locator('.activity-row').count(),1);
 offline=true;await page.locator('#activity-refresh').click();await page.waitForFunction(()=>document.getElementById('activity-sync').dataset.state==='error');assert.equal(await page.locator('.activity-row').count(),1);
 await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 console.log('PASS date groups, ticket links, filters, refresh without duplicates, retained history on error, mobile layout');
}finally{await browser.close();}
