import {test,expect,mock} from 'bun:test';
let pending:any;let source:any={workspaceId:'preview',setupComplete:1,previewStatus:'running'};
let submitCount=0;let requestError:any;let freshCount=0;let cleaned:string[]=[];let resolved='clone-new';
let reads=0;
const db={
 select:()=>({from:()=>({where:()=>{const rows=reads++===0?(pending?[pending]:[]):(source?[source]:[]);return {then:(resolve:any)=>Promise.resolve(rows).then(resolve),orderBy:()=>({limit:async()=>rows})};}})}),
 insert:()=>({values:(v:any)=>({returning:async()=>{pending={id:'intent',...v};return [pending];}})}),
 update:()=>({set:(v:any)=>({where:async()=>{pending={...pending,...v};}})}),
};
mock.module('../src/config/db.ts',()=>({db}));
mock.module('../src/services/sandbox/clone-v2.ts',()=>({submitClone:async()=>{submitCount++;if(requestError)throw requestError;return 'request';},waitForClone:async(id:string)=>({jobId:id,workspaceId:resolved})}));
mock.module('../src/services/mags.ts',()=>({setNoSleep:async()=>{},execOnWorkspace:async(id:string)=>{cleaned.push(id);return {exitCode:0};}}));
const {createTicketSandbox}=await import('../src/services/ticket-sandbox-clone.ts');
const options={projectId:'p',ticketId:'t',userId:'u',log:async()=>{},fresh:async()=>{freshCount++;return {jobId:'fresh',workspaceId:'fresh'};}};
function reset(){reads=0;pending=undefined;submitCount=0;freshCount=0;requestError=null;cleaned=[];resolved='clone-new';source={workspaceId:'preview',setupComplete:1,previewStatus:'running'};}
test('registers accepted request and cleans only clone',async()=>{reset();const r=await createTicketSandbox(options);expect(r.cloneIntentId).toBe('intent');expect(pending.magsJobId).toBe('request');expect(cleaned).toEqual(['request']);});
test('pending request resumes without clone POST',async()=>{reset();pending={id:'intent',status:'cloning',magsJobId:'existing',magsBaseWorkspaceId:'preview'};await createTicketSandbox(options);expect(submitCount).toBe(0);expect(cleaned).toEqual(['existing']);});
test('unknown submission stays blocked instead of duplicating VM',async()=>{reset();pending={id:'intent',status:'submitting'};await expect(createTicketSandbox(options)).rejects.toThrow('outcome is unknown');expect(submitCount).toBe(0);expect(freshCount).toBe(0);});
test('busy source falls back to fresh provisioning',async()=>{reset();requestError=Object.assign(new Error('busy'),{statusCode:409});await createTicketSandbox(options);expect(freshCount).toBe(1);expect(pending.status).toBe('rejected');});
test('unexpected POST outcome never falls back',async()=>{reset();requestError=new Error('network');await expect(createTicketSandbox(options)).rejects.toThrow('network');expect(freshCount).toBe(0);expect(pending.status).toBe('submitting');});
test('refuses to modify source if provider returns its identity',async()=>{reset();resolved='preview';await expect(createTicketSandbox(options)).rejects.toThrow('source identity');expect(cleaned).toEqual([]);});
