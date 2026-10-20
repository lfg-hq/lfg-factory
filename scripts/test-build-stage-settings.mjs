import {chromium} from 'playwright-core';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 const page=await browser.newPage();
 await page.setContent('<div id="actions"></div>');
 await page.addScriptTag({content:readFileSync('public/js/ticket-action-phases.js','utf8')});
 for(const validationEnabled of [true,false]) for(const featureTestingEnabled of [true,false]) {
  await page.evaluate(settings=>{
   const rows=['Starting Pi build','Running the saved ticket:','Feature testing passed'].map(message=>({message}));
   window.TicketActionPhases.render(document.getElementById('actions'),rows,settings,'test',row=>{const el=document.createElement('p');el.textContent=row.message;return el;});
  },{validationEnabled,featureTestingEnabled});
  // Validation and feature testing share one Checks tab when either is on.
  const expected=['Build',...(validationEnabled||featureTestingEnabled?['Checks']:[])];
  assert.deepEqual(await page.locator('[role=tab] strong').allTextContents(),expected);
  await page.locator('[role=tab]').last().click(); // Remember a choice, then disable it on the next render.
 }
 const saves=[];
 await page.route('**/api/projects/demo/preview/build-settings',async route=>{
  if(route.request().method()==='POST') saves.push(route.request().postDataJSON());
  await route.fulfill({json:{validationEnabled:true,featureTestingEnabled:true,canChangeBuildStages:true}});
 });
 await page.route('http://settings.test/projects/demo/config',route=>route.fulfill({contentType:'text/html',body:'<input type="checkbox" id="cfg-checks-enabled" disabled><p id="cfg-build-stages-status"></p>'}));
 await page.goto('http://settings.test/projects/demo/config');
 await page.addScriptTag({content:readFileSync('public/js/build-stage-settings.js','utf8')});
 await page.waitForFunction(()=>!document.getElementById('cfg-checks-enabled').disabled);
 await page.locator('#cfg-checks-enabled').uncheck();
 await page.waitForFunction(()=>document.getElementById('cfg-build-stages-status').textContent.startsWith('Saved.'));
 assert.deepEqual(saves,[{validationEnabled:false,featureTestingEnabled:false}]);
 console.log('PASS: one Checks tab for every stage combination; one toggle saves both checks');
} finally {await browser.close();}
