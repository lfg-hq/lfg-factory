import {test,expect} from 'bun:test';
import {PreviewWorkerMaintenance} from '../src/services/preview-worker-maintenance.ts';
const workers=[{name:'queue',runCmd:'run-queue'},{name:'scheduler',runCmd:'run-scheduler'}];
test('data maintenance pauses once and restores only previously running workers',async()=>{
 const calls:any[]=[];
 const m=new PreviewWorkerMaintenance(workers,async(action,list)=>{calls.push([action,list.map(w=>w.name)]);return {workers:[{name:'queue',running:true,environmentMatches:true},{name:'scheduler',running:false,environmentMatches:false}]};});
 await m.pause();await m.pause();await m.resume();await m.resume();
 expect(calls).toEqual([['status',['queue','scheduler']],['stop',['queue','scheduler']],['start',['queue']]]);
});
test('failure or cancellation cleanup can restore paused workers without re-running data',async()=>{
 const calls:string[]=[];
 const m=new PreviewWorkerMaintenance(workers,async action=>{calls.push(action);return {workers:[{name:'queue',running:true,environmentMatches:true}]};});
 try{await m.pause();throw Error('transaction cancelled');}catch{}finally{await m.resume();}
 expect(calls).toEqual(['status','stop','start']);
});
test('failed stop remains recoverable and database mismatches prevent mutation',async()=>{
 const calls:string[]=[];
 const m=new PreviewWorkerMaintenance(workers,async action=>{calls.push(action);if(action==='stop')throw Error('partial stop');return {workers:[{name:'queue',running:true,environmentMatches:true}]};});
 await expect(m.pause()).rejects.toThrow('partial stop');await expect(m.pause()).rejects.toThrow('partial stop');await m.resume();expect(calls).toEqual(['status','stop','stop','start']);
 const mismatch=new PreviewWorkerMaintenance(workers,async action=>{if(action!=='status')throw Error('unexpected mutation');return {workers:[{name:'queue',running:true,environmentMatches:false}]};});
 await expect(mismatch.pause()).rejects.toThrow('environment differs');
});
test('resume failures remain explicit and can be retried',async()=>{
 let attempts=0;
 const m=new PreviewWorkerMaintenance(workers,async action=>{if(action==='start'&&++attempts===1)throw Error('worker failed');return {workers:[{name:'queue',running:true,environmentMatches:true}]};});
 await m.pause();await expect(m.resume()).rejects.toThrow('worker failed');expect(await m.resume()).toEqual({resumed:['queue']});
});
