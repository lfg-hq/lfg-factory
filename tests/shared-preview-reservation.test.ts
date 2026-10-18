import {test,expect,mock} from 'bun:test';
let resolveProbe:((value:any)=>void)|undefined;
mock.module('../src/services/mags.ts',()=>({execOnWorkspace:async()=>new Promise(resolve=>{resolveProbe=resolve;})}));
const {reservePreviewProject,tryAcquireLane,activeLanes}=await import('../src/services/shared-lanes.ts');
const request={ticketId:'t',projectId:'p',workspaceId:'w',dir:'wt',kind:'build' as const,credKey:'c',exclusiveConfig:false};
test('preview reservations block new ticket work, including a race during the disk probe',async()=>{
 const release=reservePreviewProject('p');expect((await tryAcquireLane(request)).ok).toBe(false);release();
 const pending=tryAcquireLane(request);expect(()=>reservePreviewProject('p')).toThrow();resolveProbe!({output:'99999999'});const lane=await pending;expect(lane.ok).toBe(true);expect(activeLanes()).toHaveLength(1);expect(()=>reservePreviewProject('p')).toThrow();if(lane.ok)lane.release();
 const after=reservePreviewProject('p');after();
});
