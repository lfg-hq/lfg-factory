import {chromium} from 'playwright-core';
import {createServer} from 'node:http';
import {createReadStream,statSync} from 'node:fs';
const files=process.argv.slice(2);
if(!files.length)throw Error('Supply recording paths');
const server=createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname!=='/video'){res.setHeader('Content-Type','text/html');res.end('<video controls muted src="/video?i='+Number(url.searchParams.get('i'))+'"></video>');return;}
 const file=files[Number(url.searchParams.get('i'))];const size=statSync(file).size;
 const match=/bytes=(\d+)-(\d*)/.exec(req.headers.range||'');const start=match?Number(match[1]):0;const end=match?.[2]?Math.min(Number(match[2]),size-1):size-1;
 res.writeHead(match?206:200,{'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Length':end-start+1,...(match?{'Content-Range':`bytes ${start}-${end}/${size}`}:{})});createReadStream(file,{start,end}).pipe(res);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{const page=await browser.newPage();for(let i=0;i<files.length;i++){await page.goto(`http://127.0.0.1:${server.address().port}/?i=${i}`);await page.locator('video').evaluate(async video=>video.play());await page.waitForFunction(()=>document.querySelector('video').currentTime>0.25);console.log('Chrome played recording '+(i+1));}}
finally{await browser.close();server.close();}
