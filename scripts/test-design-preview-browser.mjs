import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try{
 const page=await browser.newPage();
 page.on('pageerror',error=>console.error(error.message));
 await page.route('http://design.test/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Host</title><iframe></iframe>'}));
 await page.goto('http://design.test/');
 await page.addScriptTag({content:readFileSync('public/js/design-preview.js','utf8')});
 const html=`<!doctype html><html><head><title>Mock</title></head><body><button onclick="this.textContent='Saved'">Save</button><script>window.parentBlocked=false;try{parent.document.title='compromised'}catch{window.parentBlocked=true}fetch('http://design.test/private').then(()=>window.networkBlocked=false).catch(()=>window.networkBlocked=true);</script></body></html>`;
 await page.evaluate(html=>window.DesignPreview.configure(document.querySelector('iframe'),html),html);
 const frame=page.frameLocator('iframe');await page.frames()[1].waitForFunction(()=>window.parentBlocked===true);await frame.getByRole('button',{name:'Save'}).click();assert.equal(await frame.getByRole('button').textContent(),'Saved');
 const child=page.frames()[1];await child.waitForFunction(()=>window.networkBlocked===true);assert.equal(await child.evaluate(()=>window.parentBlocked),true);assert.equal(await page.title(),'Host');
 assert.equal(await page.locator('iframe').getAttribute('sandbox'),'allow-scripts');
 const pending=page.waitForEvent('popup');await page.evaluate(html=>window.DesignPreview.open(html),html);const popup=await pending;await popup.waitForLoadState();
 await popup.frameLocator('iframe').getByRole('button',{name:'Save'}).click();assert.equal(await popup.frameLocator('iframe').getByRole('button').textContent(),'Saved');assert.equal(await popup.locator('iframe').getAttribute('sandbox'),'allow-scripts');assert.equal(await popup.title(),'Design preview');
 console.log('PASS: mock interactions, parent isolation, network restriction, safe new-tab rendering');
}finally{await browser.close();}
