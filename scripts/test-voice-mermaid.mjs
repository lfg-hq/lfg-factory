import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
 const page = await browser.newPage();
 await page.route('https://lfg.test/**', async route => {
  const path = new URL(route.request().url()).pathname;
  if (path === '/api/voice') return route.fulfill({json:{natural:true}});
  if (path.startsWith('/public/')) return route.fulfill({body:await fs.readFile('.'+path),contentType:'application/javascript'});
  return route.fulfill({body:'<html><head></head><body><div class="markdown-content" id="doc"></div><div class="chat-input-container"><form id="chat-form"><div class="input-wrapper"><textarea aria-label="Message"></textarea><div class="input-actions"><button id="record-audio-btn"></button></div></div></form></div></body></html>',contentType:'text/html'});
 });
 await page.goto('https://lfg.test/');
 await page.addStyleTag({content:'* { margin: 0; }'});
 await page.addScriptTag({path:'public/js/marked.min.js'});
 await page.addScriptTag({path:'public/js/markdown-config.js'});
 await page.evaluate(async () => {
  await window.mermaidRendererReady;
  document.querySelector('#doc').innerHTML = marked.parse('```mermaid\nflowchart LR\n A["Browser"] --> B["Agent"]\n```');
  await window.renderMermaidDiagrams(document.querySelector('#doc'));
 });
 assert.equal(await page.locator('#doc .lfg-diagram svg').count(),1);
 assert.match(await page.locator('#doc details').textContent(), /Browser/);
 await page.evaluate(async () => {
  const el=document.createElement('div');el.id='invalid';el.innerHTML=marked.parse('```mermaid\ninvalid diagram !!!\n```');document.body.append(el);
  await renderMermaidDiagrams(el);
 });
 assert.equal(await page.locator('#invalid pre[data-diagram-error]').count(),1);
 for (const width of [1440,390]) {
  await page.setViewportSize({width,height:900});
  await page.click('#doc .lfg-diagram-expand');
  await page.waitForFunction(()=>document.querySelector('[data-action="layout"]')?.getAttribute('aria-pressed')==='true');
  assert.equal(await page.locator('dialog[open] svg').count(),1);
  const dialogBounds=await page.locator('dialog[open]').boundingBox();
  assert.ok(dialogBounds.width>width*.9);
  assert.ok(Math.abs(dialogBounds.x-(width-dialogBounds.width)/2)<2, 'Viewer is horizontally centered despite CSS resets');
  assert.ok(Math.abs(dialogBounds.y-(900-dialogBounds.height)/2)<2, 'Viewer is vertically centered');
  const before=await page.locator('dialog svg').boundingBox();
  await page.click('[data-action="out"]');
  const after=await page.locator('dialog svg').boundingBox();
  assert.ok(after.width<before.width);
  await page.click('[data-action="fit"]');
  await page.screenshot({path:`/tmp/lfg-expanded-diagram-${width}.png`});
  await page.keyboard.press('Escape');
  await page.locator('dialog').waitFor({state:'detached'});
  assert.equal(await page.locator('dialog').count(),0);
  assert.equal(await page.locator('#doc .lfg-diagram-drawing svg').count(),1);
  assert.equal(await page.locator('#doc .lfg-diagram-expand').evaluate(el=>document.activeElement===el),true);
 }
 await page.click('#doc .lfg-diagram-expand');
 await page.evaluate(()=>dispatchEvent(new Event('beforeprint')));
 assert.equal(await page.locator('dialog').count(),0);
 assert.equal(await page.locator('#doc .lfg-diagram-drawing svg').count(),1);
 await page.setViewportSize({width:1280,height:900});
 await page.evaluate(async () => {
  const el=document.createElement('div'); el.id='portrait';
  el.innerHTML=marked.parse('```mermaid\nflowchart TD\n A[Browser] --> B[Application] --> C[Database] --> D[Worker] --> E[Results]\n```');
  document.body.append(el); await renderMermaidDiagrams(el);
 });
 for (const width of [1440, 390]) {
  await page.setViewportSize({width,height:900});
  const preview=await page.locator('#portrait .lfg-diagram-drawing').evaluate(el=>({
   height:el.getBoundingClientRect().height, scrollWidth:el.scrollWidth, width:el.clientWidth,
   scrollHeight:el.scrollHeight, clientHeight:el.clientHeight,
   svgHeight:el.querySelector('svg').getBoundingClientRect().height
  }));
  assert.ok(preview.height<=361 && preview.svgHeight>0, 'Tall diagram contracts to a complete compact preview');
  assert.ok(preview.scrollWidth<=preview.width && preview.scrollHeight<=preview.clientHeight, 'Preview has no internal scrolling');
 }
 await page.setViewportSize({width:1280,height:900});
 const originalSource=await page.locator('#portrait details').textContent();
 await page.click('#portrait .lfg-diagram-expand');
 await page.waitForFunction(()=>document.querySelector('[data-action="layout"]')?.getAttribute('aria-pressed')==='true');
 const portraitBounds=await page.locator('dialog svg').boundingBox();
 const viewportBounds=await page.locator('.lfg-diagram-viewport').boundingBox();
 assert.ok(portraitBounds.width > viewportBounds.width*.9, 'Expanded diagram uses available width');
 const landscape=await page.locator('dialog svg').boundingBox();
 assert.ok(landscape.width>landscape.height, 'Horizontal re-layout changes the graph geometry');
 await page.screenshot({path:'/tmp/lfg-horizontal-diagram.png'});
 await page.click('[data-action="layout"]');
 assert.equal(await page.locator('[data-action="layout"]').getAttribute('aria-pressed'),'false');
 await page.click('[data-action="layout"]');
 await page.keyboard.press('Escape');
 await page.locator('dialog').waitFor({state:'detached'});
 assert.equal(await page.locator('#portrait .lfg-diagram-drawing svg').count(),1);
 assert.equal(await page.locator('#portrait details').textContent(),originalSource);
 await page.evaluate(()=>document.querySelector('#portrait').remove());
 await page.evaluate(()=>prepareMermaidForExport(document.querySelector('#doc')));
 assert.equal(await page.locator('#doc .lfg-diagram-toolbar').count(),0);
 assert.equal(await page.locator('#doc img').count(),1);
 assert.equal(await page.locator('#doc details').count(),0);
 assert.ok(await page.locator('#doc img').evaluate(img=>img.complete && img.naturalWidth>0));
 await page.addScriptTag({path:'public/js/html2canvas.min.js'});
 const capture = await page.evaluate(async () => {
  const canvas = await html2canvas(document.querySelector('#doc'), {backgroundColor:'#fff'});
  const pixels = canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
  let ink=0;for(let i=0;i<pixels.length;i+=4) if(pixels[i]<220 || pixels[i+1]<220 || pixels[i+2]<220) ink++;
  return ink;
 });
 assert.ok(capture>1000, 'PDF capture must contain the diagram');
 await page.locator('#doc').screenshot({path:'/tmp/lfg-mermaid-check.png'});
 await page.pdf({path:'/tmp/lfg-mermaid-check.pdf',format:'A4'});
 await page.emulateMedia({media:'print'});
 assert.equal(await page.locator('.lfg-diagram').evaluate(el=>getComputedStyle(el).breakInside),'avoid');
 await page.emulateMedia({media:'screen'});
 console.log('PASS: real Mermaid SVG, invalid source fallback, PDF image decoding, print styles.');
} finally { await browser.close(); }
// Voice now uses server-generated audio exclusively; exercise that implementation.
await import('./test-natural-voice.mjs');
