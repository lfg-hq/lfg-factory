import {test,expect,mock} from 'bun:test';
let finish:()=>void=()=>{};let reject:(error:Error)=>void=()=>{};const commands:string[]=[];
mock.module('../src/services/mags.ts',()=>({execOnWorkspace:async (_:string,command:string)=>{commands.push(command);return {exitCode:0,output:'',stderr:''};}}));
mock.module('../src/services/build-preflight.ts',()=>({redactSetupOutput:(s:string)=>s,prepareBuildRuntime:async()=>new Promise<void>((resolve,fail)=>{finish=resolve;reject=fail;})}));
const {startBuildEnvironmentWorker}=await import('../src/services/build-environment-worker.ts');
const options={workspaceId:'clone',projectId:'p',branch:'ticket',dir:'/data/project',userId:'u',onLog:()=>{}};
test('returns worker before SDK completion and gates completion',async()=>{
 const worker=await startBuildEnvironmentWorker(options);let done=false;void worker.done.then(()=>{done=true;});
 expect(done).toBe(false);expect(commands[0]).toContain('archive --format=tar HEAD');expect(commands[0]).toContain('git -C');
 finish();expect(await worker.done).toBeNull();expect(commands.at(-1)).toContain('rm -rf');
});
test('SDK failure is retained for publication gate and snapshot is cleaned',async()=>{
 const worker=await startBuildEnvironmentWorker(options);reject(new Error('SDK unavailable'));
 expect((await worker.done)?.message).toBe('SDK unavailable');expect(commands.at(-1)).toContain('rm -rf');
});
