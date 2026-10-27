import {test,expect,mock,afterAll} from 'bun:test';
const priorBackend=process.env.SANDBOX_BACKEND;
process.env.SANDBOX_BACKEND='mags';
process.env.TICKET_CLONE_BUSY_RETRY_MS='0';
let waitErrors:string[]=[];
afterAll(()=>{if(priorBackend===undefined)delete process.env.SANDBOX_BACKEND;else process.env.SANDBOX_BACKEND=priorBackend;});
let pending:any;let source:any={workspaceId:'preview',setupComplete:1,previewStatus:'running'};
let submitCount=0;let requestError:any;let freshCount=0;let cleaned:string[]=[];let resolved='clone-new';
let reads=0; let probeResult:any={exitCode:0,output:'/data/project'};
const db={
 select:()=>({from:()=>({where:()=>{const rows=reads++===0?(pending&&pending.status!=='rejected'?[pending]:[]):(source?[source]:[]);return {then:(resolve:any)=>Promise.resolve(rows).then(resolve),orderBy:()=>({limit:async()=>rows})};}})}),
 insert:()=>({values:(v:any)=>({returning:async()=>{pending={id:'intent',...v};return [pending];}})}),
 update:()=>({set:(v:any)=>({where:async()=>{pending={...pending,...v};if(v.status==='rejected')reads=0;}})}),
};
mock.module('../src/config/db.ts',()=>({db}));
mock.module('../src/services/sandbox/clone-v2.ts',()=>({submitClone:async()=>{submitCount++;if(requestError)throw requestError;return 'request';},waitForClone:async(id:string)=>{if(waitErrors.length)throw new Error(waitErrors.shift());return {jobId:id,workspaceId:resolved};}}));
let stopped:string[]=[];
mock.module('../src/services/mags.ts',()=>({setNoSleep:async()=>{},execOnWorkspace:async()=>probeResult,stopWorkspace:async(id:string)=>{stopped.push(id);}}));
let preparedCount=0;let prepareError:any;
mock.module('../src/services/project-sandbox.ts',()=>({ensureProjectSandbox:async()=>{preparedCount++;if(prepareError)throw prepareError;return {workspaceId:'new-preview'};}}));
const {createTicketSandbox,cloneLock}=await import('../src/services/ticket-sandbox-clone.ts');
cloneLock.run=(_p:any,_l:any,run:any)=>run(); // the queue has its own tests
const options={projectId:'p',ticketId:'t',userId:'u',log:async()=>{},fresh:async()=>{freshCount++;return {jobId:'fresh',workspaceId:'fresh'};}};
function reset(){waitErrors=[];stopped=[];preparedCount=0;prepareError=null;reads=0;pending=undefined;submitCount=0;freshCount=0;requestError=null;cleaned=[];resolved='clone-new';source={workspaceId:'preview',setupComplete:1,previewStatus:'running'};}
test('registers accepted clone and preserves its prepared application files',async()=>{reset();const r=await createTicketSandbox(options);expect(r.cloneIntentId).toBe('intent');expect(pending.magsJobId).toBe('request');expect(cleaned).toEqual([]);});
test('pending request resumes without clone POST',async()=>{reset();pending={id:'intent',status:'cloning',magsJobId:'existing',magsBaseWorkspaceId:'preview'};await createTicketSandbox(options);expect(submitCount).toBe(0);expect(cleaned).toEqual([]);});
test('unknown clone submission is retained without provisioning an empty replacement',async()=>{reset();pending={id:'intent',status:'submitting'};await expect(createTicketSandbox(options)).rejects.toThrow('unconfirmed');expect(submitCount).toBe(0);expect(freshCount).toBe(0);expect(pending.status).toBe('unconfirmed');});
test('busy preview does not silently fall back to fresh provisioning',async()=>{reset();requestError=Object.assign(new Error('busy'),{statusCode:409});await expect(createTicketSandbox(options)).rejects.toThrow('rejected');expect(freshCount).toBe(0);expect(pending.status).toBe('rejected');});
test('lost POST response retains intent without resubmitting',async()=>{reset();requestError=new Error('network');await expect(createTicketSandbox(options)).rejects.toThrow('unconfirmed');expect(submitCount).toBe(1);expect(freshCount).toBe(0);});
test('refuses to modify source if provider returns its identity',async()=>{reset();resolved='preview';await expect(createTicketSandbox(options)).rejects.toThrow('source identity');expect(cleaned).toEqual([]);});
test('missing preview is assigned automatically before a fresh build',async()=>{reset();source=null;await createTicketSandbox(options);expect(preparedCount).toBe(1);expect(freshCount).toBe(1);expect(submitCount).toBe(0);});
test('unfinished app can build without a running preview',async()=>{reset();source.setupComplete=0;await createTicketSandbox(options);expect(preparedCount).toBe(1);expect(freshCount).toBe(1);});
test('project lifecycle failures stop setup without another VM',async()=>{reset();source=null;prepareError=Error('Disk ownership unresolved');await expect(createTicketSandbox(options)).rejects.toThrow('Disk ownership');expect(freshCount).toBe(0);});

test('Coding recovery can clone a prepared checkout despite an unrelated preview error',async()=>{reset();source.previewStatus='error';probeResult={exitCode:0,output:'/data/project\n'};await createTicketSandbox({...options,allowPreparedPreviewWithAppError:true});expect(submitCount).toBe(1);});
test('Coding recovery does not clone an unhealthy prepared checkout',async()=>{reset();source.previewStatus='error';probeResult={exitCode:128,output:''};await expect(createTicketSandbox({...options,allowPreparedPreviewWithAppError:true})).rejects.toThrow('checkout is unavailable');expect(submitCount).toBe(0);});
test('ordinary builds retain their working-preview requirement',async()=>{reset();source.previewStatus='error';await expect(createTicketSandbox(options)).rejects.toThrow('existing prepared preview');expect(submitCount).toBe(0);});

test('explicit clone rejection retains provider diagnostics',async()=>{reset();requestError=Object.assign(new Error('Clone API HTTP 404: source V2 sandbox not found'),{statusCode:404});await expect(createTicketSandbox(options)).rejects.toThrow('source V2 sandbox not found');expect(pending.status).toBe('rejected');expect(submitCount).toBe(1);expect(freshCount).toBe(0);});

const busy='Clone request failed: clone failed: another disk checkpoint or clone is in progress. Inspect clone logs.';
test('a clone refused because the preview disk is busy is retried, not left pending',async()=>{reset();waitErrors=[busy,busy];const r=await createTicketSandbox(options);expect(r.workspaceId).toBe('clone-new');expect(submitCount).toBe(3);});
test('a saved clone that failed as busy is marked rejected and resubmitted',async()=>{reset();pending={id:'intent',status:'cloning',magsJobId:'old',magsBaseWorkspaceId:'preview'};waitErrors=[busy];const r=await createTicketSandbox(options);expect(r.workspaceId).toBe('clone-new');expect(submitCount).toBe(1);});
test('a disk that stays busy eventually gives up with the reason',async()=>{reset();waitErrors=Array(10).fill(busy);await expect(createTicketSandbox(options)).rejects.toThrow('another disk checkpoint');expect(submitCount).toBe(7);});

const timedOut='Clone dc0029b8 failed: clone failed: source export: rpc error: code = DeadlineExceeded desc = context deadline exceeded. Inspect clone logs; source rollback failures require operator attention.';
test('a provider timeout while exporting the disk is retried too',async()=>{reset();waitErrors=[timedOut];const r=await createTicketSandbox(options);expect(r.workspaceId).toBe('clone-new');expect(submitCount).toBe(2);});
test('a saved clone that timed out is not resumed forever',async()=>{reset();pending={id:'intent',status:'cloning',magsJobId:'old',magsBaseWorkspaceId:'preview'};waitErrors=[timedOut];const r=await createTicketSandbox(options);expect(r.workspaceId).toBe('clone-new');expect(submitCount).toBe(1);});
test('a genuine clone failure is not retried',async()=>{reset();waitErrors=['Clone x failed: clone failed: source disk not found.'];await expect(createTicketSandbox(options)).rejects.toThrow('not found');expect(submitCount).toBe(1);});

test('a preview busy running commands is retried',async()=>{reset();waitErrors=['Clone a88 failed: clone failed: source export: source sandbox has active requests; retry when idle. Inspect clone logs.'];const r=await createTicketSandbox(options);expect(r.workspaceId).toBe('clone-new');expect(submitCount).toBe(2);});

test('a clone stuck pending is cancelled before it is resubmitted',async()=>{reset();waitErrors=['Clone request stuck pending at the provider for 4 minutes'];const r=await createTicketSandbox(options);expect(stopped).toEqual(['request']);expect(r.workspaceId).toBe('clone-new');expect(submitCount).toBe(2);});

// Keep these last: a stalled provider flags the project for the rest of the file.
test('a provider that stalls twice is not retried for an hour: the run continues in a fresh sandbox',async()=>{reset();const logs:string[]=[];waitErrors=[timedOut,timedOut,timedOut];const r=await createTicketSandbox({...options,log:async(m:string)=>{logs.push(m);}});expect(submitCount).toBe(2);expect(freshCount).toBe(1);expect(r.freshEnvironment).toBe(true);expect(logs.some(l=>l.includes('fresh sandbox'))).toBe(true);});
test('the next ticket in that project skips the copy while the provider is stalled',async()=>{reset();const r=await createTicketSandbox(options);expect(submitCount).toBe(0);expect(freshCount).toBe(1);expect(r.freshEnvironment).toBe(true);});
