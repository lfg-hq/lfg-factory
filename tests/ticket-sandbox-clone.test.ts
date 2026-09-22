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
test('registers accepted clone and preserves its prepared application files',async()=>{reset();const r=await createTicketSandbox(options);expect(r.cloneIntentId).toBe('intent');expect(pending.magsJobId).toBe('request');expect(cleaned).toEqual([]);});
test('pending request resumes without clone POST',async()=>{reset();pending={id:'intent',status:'cloning',magsJobId:'existing',magsBaseWorkspaceId:'preview'};await createTicketSandbox(options);expect(submitCount).toBe(0);expect(cleaned).toEqual([]);});
test('unknown clone submission is retained without provisioning an empty replacement',async()=>{reset();pending={id:'intent',status:'submitting'};await expect(createTicketSandbox(options)).rejects.toThrow('unconfirmed');expect(submitCount).toBe(0);expect(freshCount).toBe(0);expect(pending.status).toBe('unconfirmed');});
test('busy preview does not silently fall back to fresh provisioning',async()=>{reset();requestError=Object.assign(new Error('busy'),{statusCode:409});await expect(createTicketSandbox(options)).rejects.toThrow('rejected');expect(freshCount).toBe(0);expect(pending.status).toBe('rejected');});
test('lost POST response retains intent without resubmitting',async()=>{reset();requestError=new Error('network');await expect(createTicketSandbox(options)).rejects.toThrow('unconfirmed');expect(submitCount).toBe(1);expect(freshCount).toBe(0);});
test('refuses to modify source if provider returns its identity',async()=>{reset();resolved='preview';await expect(createTicketSandbox(options)).rejects.toThrow('source identity');expect(cleaned).toEqual([]);});
test('unprepared preview is reported before creating a sandbox',async()=>{reset();source=null;await expect(createTicketSandbox(options)).rejects.toThrow('prepared preview');expect(freshCount).toBe(0);expect(submitCount).toBe(0);});
