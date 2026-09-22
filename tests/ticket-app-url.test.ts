import {expect,test} from 'bun:test';
import {exposeTicketApp} from '../src/services/ticket-app-url.ts';

test('pins the public alias to the validation sandbox and exact app port',async()=>{
 const calls:unknown[][]=[];
 const routing={enableHttpAccess:async(...args:any[])=>{calls.push(args);return 'https://stale.apps.mags.run';},setStableUrl:async(...args:any[])=>{calls.push(args);return `https://${args[0]}.app.lfg.run`;}};
 const url=await exposeTicketApp('ticket-25','validated-sandbox',5080,routing);
 expect(calls[0]).toEqual(['validated-sandbox',5080]);
 expect(calls[1]).toEqual([new URL(url).hostname.split('.')[0],'validated-sandbox',5080]);
 expect(url).toEndWith('.app.lfg.run');
 await exposeTicketApp('ticket-25','validated-sandbox',5080,routing);
 expect(calls[3]).toEqual(calls[1]);
 await exposeTicketApp('ticket-25','validated-sandbox',5187,routing);
 expect(calls[5]?.[0]).not.toEqual(calls[1]?.[0]);
});

test('does not fall back to an unpinned raw URL when alias registration fails',async()=>{
 await expect(exposeTicketApp('ticket-25','validated-sandbox',5080,{
  enableHttpAccess:async()=> 'https://stale.apps.mags.run',
  setStableUrl:async()=>{throw Error('registration failed');},
 })).rejects.toThrow('Could not register the ticket preview');
});
