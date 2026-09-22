import {test,expect} from 'bun:test';
import {PiRepairSession,type RpcDependencies} from '../src/services/pi-rpc.ts';
function fixture(){
 let starts=0,stops=0,time=0;const sent:string[]=[];const states:any[]=[];
 const d:RpcDependencies={
  start:async()=>{starts++;return {outputFile:'/tmp/output',backgroundPid:String(100+starts)};},
  exec:async script=>{
   if(script.includes('os.open')){const payload=script.match(/python3 - '[^']+' '([^']+)'/)![1];sent.push(JSON.parse(Buffer.from(payload,'base64').toString()).message);return {exitCode:0,output:''};}
   if(script.includes('selected={root}')){stops++;return {exitCode:0,output:''};}
   const s=states.shift()??{events:[{type:'agent_end'}],alive:true};
   return {exitCode:0,output:JSON.stringify({offset:1,chunk:Buffer.from(s.raw??s.events.map((x:any)=>JSON.stringify(x)+'\n').join('')).toString('base64'),alive:s.alive})};
  },wait:async()=>{time+=10;},now:()=>time,
 };
 return {session:new PiRepairSession('/tmp/input',100,d),d,states,sent,starts:()=>starts,stops:()=>stops};
}
test('verification feedback uses the same live process',async()=>{
 const f=fixture();await f.session.ask('run app');await f.session.ask('HTTP failed; repair');
 expect(f.starts()).toBe(1);expect(f.sent).toEqual(['run app','HTTP failed; repair']);await f.session.close();expect(f.stops()).toBe(1);
});
test('tool failure remains inside the same session',async()=>{
 const f=fixture();f.states.push({events:[{type:'tool_execution_end',isError:true},{type:'agent_end'}],alive:true});
 await f.session.ask('repair');expect(f.starts()).toBe(1);
});
test('only process death starts a replacement with recovery context',async()=>{
 const f=fixture();f.states.push({events:[],alive:false});await f.session.ask('verify');
 expect(f.starts()).toBe(2);expect(f.sent[1]).toContain('prior Pi process exited');
});
test('one shared deadline covers subsequent turns',async()=>{
 const f=fixture();await f.session.ask('first');f.d.now=()=>101;
 await expect(f.session.ask('next')).rejects.toThrow('30-minute');expect(f.starts()).toBe(1);
});
test('cancellation refuses another prompt and cleanup remains available',async()=>{
 const f=fixture();await f.session.ask('first');f.d.cancelled=()=>true;
 await expect(f.session.ask('next')).rejects.toThrow('cancelled');await f.session.close();expect(f.stops()).toBe(1);
});
test('partial JSON lines survive polling',async()=>{
 const f=fixture();f.states.push({raw:'{"type":"agent_',alive:true},{raw:'end"}\n',alive:true});await f.session.ask('verify');expect(f.starts()).toBe(1);
});
test('browser tool returns controller results to the waiting agent',async()=>{
 const f=fixture();const exec=f.d.exec;let wrote=false;
 f.d.browserReplyDir='/tmp/replies';f.d.browser=async input=>({passed:true,snapshot:'Button Save',action:input.action});
 f.d.exec=async script=>{if(script.includes('mkdir -p')){wrote=script.includes('/tmp/replies/');return {exitCode:0,output:''};}return exec(script);};
 f.states.push({events:[{type:'lfg_browser_request',id:'12345678-1234-1234-1234-123456789abc',input:{action:'snapshot'}},{type:'agent_end'}],alive:true});
 await f.session.ask('test');expect(wrote).toBe(true);expect(f.starts()).toBe(1);
});
test('an alive process without real activity is stopped as stalled',async()=>{
 let time=0,stopped=false;const logs:string[]=[];
 const d:RpcDependencies={start:async()=>({outputFile:'/tmp/out',backgroundPid:'123'}),now:()=>time,wait:async()=>{time+=60000},log:m=>logs.push(m),exec:async script=>{
 if(script.includes('selected={root}')){stopped=true;return {exitCode:0,output:''};}
 if(script.includes('os.open'))return {exitCode:0,output:''};
 return {exitCode:0,output:JSON.stringify({offset:0,chunk:'',alive:true})};}};
 await expect(new PiRepairSession('/tmp/in',1800000,d).ask('test')).rejects.toThrow('stalled');
 expect(stopped).toBe(true);expect(logs.some(m=>m.includes('same repair session'))).toBe(false);
});
test('feature preparation cannot consume the session without a browser or applicability decision',async()=>{
 let time=0;
 const d:RpcDependencies={preparationReady:()=>false,start:async()=>({outputFile:'/tmp/out',backgroundPid:'123'}),now:()=>time,wait:async()=>{time+=60000},exec:async script=>{
 if(script.includes('os.open')||script.includes('selected={root}'))return {exitCode:0,output:''};
 return {exitCode:0,output:JSON.stringify({offset:0,chunk:Buffer.from(JSON.stringify({type:'tool_execution_start',toolName:'read'})+'\n').toString('base64'),alive:true})};}};
 await expect(new PiRepairSession('/tmp/in',1800000,d).ask('test')).rejects.toThrow('Feature preparation stalled');
});

test('host recorder failure stops immediately without replacing it with preparation timeout',async()=>{
 const f=fixture();f.d.browserReplyDir='/tmp/replies';
 f.d.browser=async()=>{const e=new Error('LFG recorder storage unavailable (EACCES)');e.name='RecordingStorageError';throw e;};
 f.states.push({events:[{type:'lfg_browser_request',id:'12345678-1234-1234-1234-123456789abc',input:{action:'start'}}],alive:true});
 await expect(f.session.ask('test UI')).rejects.toThrow('LFG recorder storage unavailable (EACCES)');
 expect(f.stops()).toBe(1);
});

test('unknown shell activity is quiet and repeated known activity is coalesced',async()=>{
 const f=fixture();const messages:string[]=[];f.d.log=m=>messages.push(m);
 f.states.push({events:[{type:'tool_execution_start',toolName:'bash',args:{command:'python3 inspect.py'}},{type:'tool_execution_start',toolName:'bash',args:{command:'ss -ltn'}},{type:'tool_execution_start',toolName:'bash',args:{command:'ss -ltn'}},{type:'agent_end'}],alive:true});
 await f.session.ask('inspect');expect(messages).toEqual(['Checking app listeners']);
});
