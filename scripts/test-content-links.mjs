import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 const page=await browser.newPage();
 await page.setContent('<base href="https://lfg.run/"><div class="markdown-content" id="doc"></div><a id="nav" href="/projects">Projects</a>');
 await page.addScriptTag({path:'public/js/marked.min.js'});
 await page.addScriptTag({path:'public/js/markdown-config.js'});
 await page.evaluate(()=>{document.getElementById('doc').innerHTML=marked.parse('[Login](https://preview.example/login) [Relative](/login) [Section](#section) <a href="https://example.com" rel="nofollow">HTML</a>');});
 const links=await page.locator('#doc a').evaluateAll(els=>els.map(el=>({target:el.target,rel:el.rel})));
 assert.equal(links[0].target,'_blank');assert.equal(links[1].target,'_blank');assert.equal(links[2].target,'');
 assert.equal(links[3].target,'_blank');assert.ok(links[3].rel.includes('nofollow'));assert.ok(links[3].rel.includes('noopener'));
 const raw=await page.evaluate(()=>{const link=document.createElement('a');link.href='https://example.com/raw';document.getElementById('doc').appendChild(link);link.addEventListener('click',e=>e.preventDefault());link.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));return link.target;});
 assert.equal(raw,'_blank');assert.equal(await page.locator('#nav').getAttribute('target'),null);
 console.log('PASS: markdown, raw HTML and dynamic document links open new tabs; anchors and app navigation preserved');
}finally{await browser.close();}
