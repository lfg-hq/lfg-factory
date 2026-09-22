import {expect,test} from 'bun:test';
import {checkLocalFeatureApp,checkPublicFeatureApp} from '../src/services/feature-app-readiness.ts';
const progress=async(_message:string)=>{};
test('refuses a failed local command even if output contains HTTP 200',async()=>{
 await expect(checkLocalFeatureApp({localUrl:'http://127.0.0.1:5080/',progress,shell:async()=>({exitCode:7,output:'LFG_HTTP_STATUS=200'})})).rejects.toThrow('Browser was not opened');
});
test('reports actual reuse of a responsive server',async()=>{
 const messages:string[]=[];
 await checkLocalFeatureApp({localUrl:'http://127.0.0.1:5080/',progress:async m=>{messages.push(m);},shell:async command=>{expect(command).toContain('--max-time 15');return {exitCode:0,output:'LFG_HTTP_STATUS=200'};}});
 expect(messages[1]).toContain('no new app was started');
});
test('rejects provider HTTP 500 before browser launch',async()=>{
 await expect(checkPublicFeatureApp('https://ticket.app.lfg.run/',progress,(async()=>new Response('Sandbox restore failed',{status:500})) as typeof fetch)).rejects.toThrow('HTTP 500');
});
test('connection failures are not converted into readiness',async()=>{
 await expect(checkPublicFeatureApp('https://ticket.app.lfg.run/',progress,(async()=>{throw Error('connection failed');}) as unknown as typeof fetch)).rejects.toThrow('Browser was not opened');
});
test('login redirects and authentication challenges permit browser login',async()=>{
 for(const status of [200,302,401,403])await checkPublicFeatureApp('https://ticket.app.lfg.run/',progress,(async()=>new Response('',{status})) as typeof fetch);
});
