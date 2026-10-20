import {chromium} from 'playwright-core';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const source=readFileSync('public/js/chat.js','utf8');
const render=source.slice(source.indexOf('            const renderOneFile = (fd) => {'),source.indexOf('            if (fileData) {',source.indexOf('            const renderOneFile = (fd) => {')));
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 const page=await browser.newPage();
 for(const width of [390,900]) {
  await page.setViewportSize({width,height:600});
  await page.setContent('<div class="message user"><div class="message-content">Read this document</div></div>');
  await page.addStyleTag({content:readFileSync('public/css/chat.css','utf8')});
  await page.addStyleTag({content:'.message.user{box-sizing:border-box;width:80%;max-width:80%;padding:16px;margin:20px;background:#7938ef;font-family:Arial;color:white}.message-content{padding:0}'});
  await page.addScriptTag({content:`(()=>{const contentDiv=document.querySelector('.message-content');${render};renderOneFile({name:'EFS_Innomatics_Invoice_Agent_Full_Specification.docx',type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});})();`});
  assert.equal(await page.locator('.file-type').textContent(),'DOCX');
  const sizes=await page.evaluate(()=>{const card=document.querySelector('.file-attachment'),bubble=document.querySelector('.message');return {card:card.getBoundingClientRect().right,bubble:bubble.getBoundingClientRect().right,scroll:card.scrollWidth,client:card.clientWidth};});
  assert.ok(sizes.card<=sizes.bubble);assert.ok(sizes.scroll<=sizes.client);
  assert.equal(await page.locator('.file-name').evaluate(el=>getComputedStyle(el).color),'rgb(255, 255, 255)');
 }
 console.log('PASS: attachment filename, DOCX badge, contrast and bounds at narrow and wide widths');
 const composer=execFileSync('bun',['-e',`import {ChatInput} from './src/templates/components/chat-input.tsx'; console.log(String(await ChatInput({placeholder:'Message',models:[],selectedModelKey:'Test model'})));`],{encoding:'utf8'});
 const attachmentCode=source.slice(source.indexOf('        window.MAX_ATTACHMENTS ='),source.indexOf("        fileUploadInput.addEventListener('change'"));
 for (const theme of ['light','dark']) for (const width of [390,900]) {
  await page.setViewportSize({width,height:800});
  await page.setContent(`<html data-theme="${theme}"><body><div class="chat-container"><div class="chat-messages"><div class="message-container"><p id="previous">Earlier conversation</p></div></div>${composer}</div></body></html>`);
  for (const path of ['public/css/theme-variables.css','public/css/common.css','public/css/chat.css','public/css/polish.css','public/css/light/light-mode.css']) await page.addStyleTag({content:readFileSync(path,'utf8')});
  await page.addStyleTag({content:'body{margin:0;font-family:Arial}.chat-container{height:800px}.chat-input-container{width:100%;box-sizing:border-box}#chat-input-box{transition:none}.settings-dropdown{display:none}'});
  await page.addScriptTag({content:`(()=>{let currentConversationId='test'; const uploadFileToServer=async file=>({id:file.name}); ${attachmentCode} })();`});
  await page.evaluate(async()=>{
    for(let i=0;i<4;i++) window.attachFileToComposer(new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII='),c=>c.charCodeAt(0))],`Screenshot_<img>_2026-10-04_at_2.14.29_AM_long_filename_${i}.png`,{type:'image/png'}));
    await Promise.all(window.attachedFiles.map(f=>f.uploadPromise));
  });
  const bounds=await page.evaluate(()=>{
    const box=document.querySelector('#chat-input-box').getBoundingClientRect();
    const tray=document.querySelector('.input-file-attachments').getBoundingClientRect();
    const input=document.querySelector('#chat-input').getBoundingClientRect();
    return {trayWidth:tray.width,scroll:document.querySelector('.input-file-attachments').scrollWidth,client:document.querySelector('.input-file-attachments').clientWidth,chips:[...document.querySelectorAll('.input-file-attachment')].map(e=>({width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height,top:e.getBoundingClientRect().top,scroll:e.scrollWidth})),contained:tray.top>=box.top&&tray.bottom<=box.bottom&&tray.right<=box.right,aboveText:tray.bottom<=input.top,noOverflow:document.querySelector('.input-file-attachments').scrollWidth<=document.querySelector('.input-file-attachments').clientWidth,names:document.querySelectorAll('.input-file-attachment img').length};
  });
  await page.screenshot({animations:'disabled',path:`/tmp/lfg-composer-${theme}-${width}.png`});
  assert.ok(bounds.contained,JSON.stringify({theme,width,bounds}));
  assert.ok(bounds.aboveText,JSON.stringify({theme,width,bounds}));assert.ok(bounds.noOverflow,JSON.stringify({theme,width,bounds}));assert.equal(bounds.names,4);
  assert.ok(bounds.chips.every(c=>c.height<=48),JSON.stringify(bounds));
  if(width===900) assert.equal(bounds.chips[0].top,bounds.chips[1].top);
  assert.equal(await page.locator('.input-file-attachments').evaluate(e=>e.scrollHeight>e.clientHeight),false);
  assert.equal(await page.locator('.input-file-attachment img').first().evaluate(e=>e.getAttribute('src').startsWith('blob:')),true);
  assert.equal(await page.locator('.input-file-attachment.uploaded').count(),4);
  if (width===900) await page.screenshot({animations:'disabled',path:`/tmp/lfg-composer-${theme}.png`});
  for(let i=0;i<4;i++) await page.locator('.remove-file-btn').first().click();
  assert.equal(await page.locator('.input-file-attachments').count(),0);
  assert.equal(await page.evaluate(()=>window.attachedFiles.length),0);
 }
 console.log('PASS: four composer uploads reserve space, wrap, escape filenames and remove in both themes at narrow/wide widths');

 function luminance(rgb){return rgb.match(/\d+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);}
 for (const theme of ['light','dark']) {
  await page.setContent(`<html data-theme="${theme}"><body><div id="filebrowser"><details open><summary class="lfg-doc-group">Invoice processing controls <span class="document-group-count">2</span></summary><p>Invoice Processing Technical Analysis</p></details></div></body></html>`);
  for(const path of ['public/css/theme-variables.css','public/css/common.css','public/css/artifacts.css','public/css/chat.css','public/css/artifacts-fix.css','public/css/polish.css','public/css/light/light-mode.css']) await page.addStyleTag({content:readFileSync(path,'utf8')});
  await page.locator('.lfg-doc-group').hover();
  for(const selector of ['.lfg-doc-group','.document-group-count']) {
    const colors=await page.locator(selector).evaluate(el=>({fg:getComputedStyle(el).color,bg:getComputedStyle(el).backgroundColor}));
    const [a,b]=[luminance(colors.fg),luminance(colors.bg)].sort((a,b)=>b-a);
    assert.ok((a+.05)/(b+.05)>=4.5,`${theme} ${selector} contrast: ${JSON.stringify(colors)}`);
  }
  await page.keyboard.press('Tab');
  await page.locator('.lfg-doc-group').focus();
  assert.equal(await page.locator('.lfg-doc-group').evaluate(el=>getComputedStyle(el).outlineStyle),'solid');
  await page.screenshot({animations:'disabled',path:`/tmp/lfg-docs-${theme}.png`});
 }
 console.log('PASS: document group hover and count contrast meet 4.5:1 in both themes; keyboard focus visible');

 const ticketSource=readFileSync('public/js/ticket-agent.js','utf8');
 const buttonCode=ticketSource.slice(ticketSource.indexOf('  let chatBusy = false;'),ticketSource.indexOf('  // Stop whatever the agent'));
 await page.setContent('<button id="ta-stop"></button><button id="ta-send"></button><input id="ta-input"><button id="ta-build"></button>');
 await page.addScriptTag({content:`(()=>{const $=id=>document.getElementById(id); let curMeta={status:'in_review'};const isBuilding=()=>false; ${buttonCode}; window.testBusy=busy=>{chatBusy=busy;setBuildUI();};})();`});
 await page.evaluate(()=>window.testBusy(true));
 assert.equal(await page.locator('#ta-build .fa-spinner').count(),1);
 assert.match(await page.locator('#ta-build').textContent(),/Working/);
 assert.equal(await page.locator('#ta-stop').isVisible(),true);
 await page.evaluate(()=>window.testBusy(false));
 assert.equal(await page.locator('#ta-build .fa-spinner').count(),0);
 assert.match(await page.locator('#ta-build').textContent(),/Re-build/);
 assert.equal(await page.locator('#ta-stop').isVisible(),false);
 console.log('PASS: ticket repair uses the same busy state for its spinner, Working label and Stop button');
} finally {await browser.close();}
