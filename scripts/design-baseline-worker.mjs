import { chromium } from 'playwright-core';
let input='';for await(const chunk of process.stdin) input+=chunk;
const cfg=JSON.parse(input);
let browser;
try {
 browser=await chromium.connectOverCDP(cfg.wsEndpoint,{timeout:20000});
 const context=await browser.newContext({viewport:{width:1440,height:900},ignoreHTTPSErrors:true});
 const origin=new URL(cfg.url).origin;
 // A capture never follows an authentication redirect to another origin.
 await context.route('**/*',async route=>{
  const request=route.request();
  if(request.isNavigationRequest() && new URL(request.url()).origin!==origin) return route.abort();
  if(!['GET','HEAD'].includes(request.method())) return route.abort();
  return route.continue();
 });
 const page=await context.newPage();
 await page.goto(cfg.url,{waitUntil:'networkidle',timeout:30000});
 if(new URL(page.url()).pathname!==new URL(cfg.url).pathname) throw Error('Preview redirected. An authenticated screen must be available before capturing this layout.');
 if(await page.locator('input[type=password]').count()) throw Error('Preview requires login; cannot use a login screen as the app layout.');
 const target=page.locator(cfg.selector);
 if(await target.count()!==1) throw Error('Feature selector must match exactly one element.');
 const invalid=await target.evaluate(el=>el===document.body||el===document.documentElement||el.matches('nav,aside,[role=navigation]')||!!el.querySelector('nav,aside,[role=navigation]'));
 if(invalid) throw Error('Choose a feature content region that excludes the shared navigation.');
 await target.scrollIntoViewIfNeeded();
 const region=await target.boundingBox();
 if(!region||region.x<0||region.y<0||region.x+region.width>1441||region.y+region.height>901) throw Error('Feature region must fit in the 1440×900 capture. Select a smaller region.');
 const screenshot=await page.screenshot({type:'png',animations:'disabled'});
 process.stdout.write(JSON.stringify({region,width:1440,height:900,screenshot:screenshot.toString('base64')}));
 await context.close();
} catch(error) { process.stdout.write(JSON.stringify({error:error.message}));process.exitCode=1; }
finally {await browser?.close();}
