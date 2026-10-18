import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage();let status='unavailable',calls=0;
 await page.route('http://connection.test/**',route=>{
  if(route.request().method()==='POST'){calls++;return route.fulfill({json:{status,message:status==='reconnect'?'Reconnect in Settings.':'Authentication service unavailable.'}});}
  return route.fulfill({contentType:'text/html',body:'<form id="chat-form"></form>'});
 });
 await page.goto('http://connection.test/');await page.addScriptTag({path:'public/js/chatgpt-connection.js'});
 await page.evaluate(()=>ChatGPTConnection.check(document.querySelector('form')));
 await page.waitForFunction(()=>document.querySelector('.chatgpt-connection').dataset.status==='unavailable');
 assert.equal(await page.getByRole('link',{name:'Settings'}).isVisible(),false);
 status='reconnect';await page.getByRole('button',{name:'Check again'}).click();
 await page.getByRole('link',{name:'Settings'}).waitFor();assert.equal(calls,2);
 await page.getByRole('button',{name:'Dismiss connection status'}).click();assert.equal(await page.locator('.chatgpt-connection').count(),0);
 console.log('PASS: failed access indicator, retry, reconnect link and dismissal');
}finally{await browser.close();}
