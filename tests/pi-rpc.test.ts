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
