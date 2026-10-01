import { execFileSync } from 'node:child_process';
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
 await page.addStyleTag({content:readFileSync('public/css/chat.css','utf8')});
 await page.evaluate(()=>{
  const transcript=document.createElement('div');transcript.id='copy-layout-test';
  transcript.style.cssText='display:flex;flex-direction:column;width:100%;max-width:800px';
  transcript.innerHTML='<div class="message assistant"><div class="message-content">Short reply</div><div class="message-footer"><button class="message-copy-btn">Copy</button></div></div><div class="message user user-external-actions"><div class="message-content">Please redesign again</div></div>';
  document.body.append(transcript);
 });
 for(const width of [1200,390]) {
  await page.setViewportSize({width,height:900});
  for(const theme of ['light','dark']) {
   await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
   const message=page.locator('#copy-layout-test .assistant');
   await message.hover();
   const geometry=await message.evaluate(el=>{
    const footer=el.querySelector('.message-footer');
    return {bottom:el.getBoundingClientRect().bottom,top:footer.getBoundingClientRect().top,footerBottom:footer.getBoundingClientRect().bottom,nextTop:el.nextElementSibling.getBoundingClientRect().top,position:getComputedStyle(footer).position,height:el.getBoundingClientRect().height};
   });
   assert.equal(geometry.position,'absolute');
   assert.ok(geometry.top>=geometry.bottom-2,'Copy toolbar belongs below the bubble');
   assert.ok(geometry.nextTop>=geometry.footerBottom+6,'Following user bubble must clear the copy toolbar');
   await message.locator('.message-copy-btn').hover();
   await page.waitForFunction(()=>getComputedStyle(document.querySelector('#copy-layout-test .message-copy-btn')).opacity==='1');
   assert.equal(await message.evaluate(el=>el.getBoundingClientRect().height),geometry.height,'Hover must not resize the bubble');
  }
 }
 const featureHtml='<html><head></head><body><button>Save</button><script>document.querySelector("button").onclick=()=>document.querySelector("button").textContent="Saved";try { parent.document.body.remove(); } catch { document.body.dataset.isolated="yes"; }</script></body></html>';
 const capturedHtml=execFileSync('bun',['-e',`import {composeCapturedDesign} from './src/services/design-baseline.ts';console.log(composeCapturedDesign({version:1,projectId:'p',branch:'main',path:'/',capturedAt:'now',width:1440,height:900,region:{x:300,y:100,width:900,height:500},screenshot:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='},${JSON.stringify(featureHtml)}));`],{encoding:'utf8'});
 await page.evaluate(html=>window.DesignPreview.configure(document.querySelector('iframe'),html),capturedHtml);
 const feature=page.frameLocator('iframe').first().frameLocator('iframe');
 await feature.getByRole('button',{name:'Save'}).waitFor();
 assert.equal(await feature.locator('body').getAttribute('data-isolated'),'yes');
 await feature.getByRole('button',{name:'Save'}).click();
 assert.equal(await feature.getByRole('button').textContent(),'Saved');
 assert.equal(await page.frameLocator('iframe').first().locator('#app-capture').count(),1);
 console.log('PASS: mock interactions, parent isolation, network restriction, safe new-tab rendering');
}finally{await browser.close();}
