import {test,expect,mock} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
let root='';let validation:(o:any)=>Promise<void>=async()=>{};
let repair:(o:any)=>Promise<void>=async()=>{};
const translate=(s:string)=>s.replaceAll('/data/validation-merge-',root+'/merge-');
const shell=(script:string)=>{const r=spawnSync('bash',['-c',translate(script)],{encoding:'utf8'});return {exitCode:r.status??1,output:r.stdout+'\n'+r.stderr};};
mock.module('../src/services/validation-sandbox.ts',()=>({validationShell:async(_:string,s:string)=>shell(s)}));
mock.module('../src/services/merge-resolver.ts',()=>({runValidationRepair:async(o:any)=>repair(o)}));
let settings:any={validationEnabled:true,featureTestingEnabled:false};
const phases:Array<string|undefined>=[];
mock.module('../src/services/build-stage-settings.ts',()=>({loadBuildStageSettings:async()=>settings}));
mock.module('../src/services/ticket-runtime.ts',()=>({runTicketRuntime:async(o:any,_d:any,mode:any={})=>{
 phases.push(mode.phase);
 await validation(o);
 const dir=translate(o.projectDir);
 git(dir,'add -A');
 if(git(dir,'status --porcelain') || shell(`test -f "$(git -C '${dir}' rev-parse --git-path MERGE_HEAD)"`).exitCode===0)git(dir,"-c user.name=Test -c user.email=test@example.test commit -qm verified");
 return git(dir,'rev-parse HEAD');
}}));
const {publishValidatedTicket,publishValidatedMerge}=await import('../src/services/validated-git.ts');
function git(dir:string,args:string){const r=shell(`cd '${dir}' && git ${args}`);if(r.exitCode)throw new Error(r.output);return r.output.trim();}
async function fixture(fn:(o:any,repo:string,bare:string)=>Promise<void>){
 root=mkdtempSync(join(tmpdir(),'validated-git-'));const repo=join(root,'repo');const bare=join(root,'origin.git');validation=async()=>{};repair=async()=>{};settings={validationEnabled:true,featureTestingEnabled:false};phases.length=0;
 try{
  shell(`git init -q --bare '${bare}'; git init -q -b main '${repo}'`);
  git(repo,"config user.name Test");git(repo,"config user.email test@example.com");
  writeFileSync(join(repo,'base.txt'),'base');git(repo,'add .');git(repo,"commit -qm base");git(repo,`remote add origin 'file://${bare}'`);git(repo,'push -q origin main');
  git(repo,'checkout -qb feature/ticket');writeFileSync(join(repo,'feature.txt'),'feature');git(repo,'add .');git(repo,'commit -qm feature');
  await fn({workspaceId:'test',projectDir:repo,featureBranch:'feature/ticket',repoUrl:`file://${bare}`,validation:{projectId:'p',userId:'u',baselineBranch:'main'}},repo,bare);
 }finally{rmSync(root,{recursive:true,force:true});}
}
test('a failed check still leaves the finished build committed and pushed',()=>fixture(async(o,repo)=>{
 writeFileSync(join(repo,'pending.txt'),'pending');const before=git(repo,'rev-parse HEAD');
 validation=async()=>{throw new Error('app does not start');};
 await expect(publishValidatedTicket(o)).rejects.toThrow('app does not start');
 const saved=git(repo,'rev-parse HEAD');
 expect(saved).not.toBe(before);expect(git(repo,'status --porcelain')).toBe('');
 expect(git(repo,'ls-remote --heads origin refs/heads/feature/ticket')).toContain(saved);
}));
test('the build is saved and pushed before checks run',()=>fixture(async(o,repo)=>{
 writeFileSync(join(repo,'pending.txt'),'pending');const before=git(repo,'rev-parse HEAD');let calls=0;
 validation=async()=>{calls++;expect(git(repo,'rev-parse HEAD')).not.toBe(before);expect(git(repo,'status --porcelain')).toBe('');
  expect(git(repo,'ls-remote --heads origin refs/heads/feature/ticket')).toContain(git(repo,'rev-parse HEAD'));};
 const result=await publishValidatedTicket(o);expect(calls).toBe(1);expect(result.sha).not.toBe(before);
 expect(git(repo,'ls-remote --heads origin refs/heads/feature/ticket')).toContain(result.sha);
}));
test('checks run once on the saved build and their repairs are pushed after',()=>fixture(async(o,repo)=>{
 settings={validationEnabled:true,featureTestingEnabled:true};
 writeFileSync(join(repo,'pending.txt'),'pending');let saved='';
 validation=async()=>{saved=git(repo,'rev-parse HEAD');writeFileSync(join(repo,'migration-fix.txt'),'repair');};
 const result=await publishValidatedTicket(o);
 expect(phases).toEqual([undefined]);expect(result.sha).not.toBe(saved);
 expect(git(repo,'show --name-only --format= '+result.sha)).toContain('migration-fix.txt');
 expect(git(repo,'ls-remote --heads origin refs/heads/feature/ticket')).toContain(result.sha);
}));
test('skipping checks keeps the saved build and publishes it',()=>fixture(async(o,repo)=>{
 writeFileSync(join(repo,'pending.txt'),'pending');let skip=false;
 o.validation.skipped=()=>skip;
 validation=async()=>{skip=true;writeFileSync(join(repo,'half-repair.txt'),'unsaved');throw new Error('Ticket run cancelled');};
 const result=await publishValidatedTicket(o);
 expect(git(repo,'show --name-only --format= '+result.sha)).toContain('pending.txt');
 expect(git(repo,'show --name-only --format= '+result.sha)).not.toContain('half-repair.txt');
 expect(git(repo,'ls-remote --heads origin refs/heads/feature/ticket')).toContain(result.sha);
}));
test('a skipped ticket merges into the epic branch without re-running checks',()=>fixture(async(o,repo)=>{
 git(repo,'push -q origin feature/ticket');let checks=0;validation=async()=>{checks++;};
 const result=await publishValidatedMerge({...o,targetBranch:'main',validation:{...o.validation,skipped:()=>true}});
 expect(checks).toBe(0);expect(git(repo,'ls-remote --heads origin main')).toContain(result.sha);
}));
test('an outage during checks keeps the saved build moving',()=>fixture(async(o,repo)=>{
 writeFileSync(join(repo,'pending.txt'),'pending');const notes:string[]=[];
 o.validation.onCheckpoint=async(m:string)=>{notes.push(m);};
 validation=async()=>{throw new Error('Repair agent failed: Codex error: server_is_overloaded (503)');};
 const result=await publishValidatedTicket(o);
 expect(git(repo,'ls-remote --heads origin refs/heads/feature/ticket')).toContain(result.sha);
 expect(notes[0]).toContain('**Build complete**');expect(notes[0]).toContain('Pushed to the repository');
 expect(notes.some(n=>n.startsWith('**Checks could not run:**'))).toBe(true);
}));
test('a real check failure still stops publication after the build is saved',()=>fixture(async(o)=>{
 validation=async()=>{throw new Error('Assertion failed: the saved Site does not appear in the list');};
 await expect(publishValidatedTicket(o)).rejects.toThrow('Assertion failed');
}));
test('integration validates the merged working tree before creating the merge commit',()=>fixture(async(o,repo)=>{
 git(repo,'push -q origin feature/ticket');const baseline=git(repo,'rev-parse origin/main');
 validation=async(v)=>{const dir=translate(v.projectDir);expect(git(dir,'rev-parse HEAD')).toBe(baseline);expect(git(dir,'status --porcelain')).toContain('feature.txt');};
 const result=await publishValidatedMerge({...o,targetBranch:'main'});
 expect(git(repo,'ls-remote --heads origin main')).toContain(result.sha);expect(git(repo,'branch --show-current')).toBe('feature/ticket');
}));
test('failed integration never updates target branch',()=>fixture(async(o,repo)=>{
 git(repo,'push -q origin feature/ticket');const baseline=git(repo,'rev-parse origin/main');validation=async()=>{throw new Error('feature assertion failed');};
 await expect(publishValidatedMerge({...o,targetBranch:'main'})).rejects.toThrow('feature assertion failed');
 expect(git(repo,'ls-remote --heads origin main')).toContain(baseline);
}));

function conflictingBranches(repo:string) {
 writeFileSync(join(repo,'base.txt'),'ticket change\n');git(repo,'commit -qam ticket');git(repo,'push -q origin feature/ticket');
 git(repo,'checkout -q main');writeFileSync(join(repo,'base.txt'),'epic change\n');git(repo,'commit -qam epic');git(repo,'push -q origin main');git(repo,'checkout -q feature/ticket');
 return git(repo,'rev-parse origin/main');
}
test('interrupted merge preserves partial repairs and retry resumes them without reimplementing',()=>fixture(async(o,repo)=>{
 const baseline=conflictingBranches(repo);let dir='';let attempts=0;
 repair=async(r)=>{dir=translate(r.projectDir);attempts++;writeFileSync(join(dir,'partial.txt'),'saved repair');throw Error('agent disconnected');};
 await expect(publishValidatedMerge({...o,targetBranch:'main'})).rejects.toThrow('agent disconnected');
 expect(existsSync(join(dir,'.git'))).toBe(true);expect(git(repo,'ls-remote --heads origin main')).toContain(baseline);
 repair=async(r)=>{attempts++;expect(translate(r.projectDir)).toBe(dir);expect(readFileSync(join(dir,'partial.txt'),'utf8')).toBe('saved repair');writeFileSync(join(dir,'base.txt'),'ticket and epic resolved\n');git(dir,'add base.txt partial.txt');};
 const result=await publishValidatedMerge({...o,targetBranch:'main'});
 expect(attempts).toBe(2);expect(git(repo,'ls-remote --heads origin main')).toContain(result.sha);expect(existsSync(dir)).toBe(false);
}));
test('unresolved merge gets one focused retry and cannot publish conflict markers',()=>fixture(async(o,repo)=>{
 const baseline=conflictingBranches(repo);let attempts=0;
 repair=async()=>{attempts++;};
 await expect(publishValidatedMerge({...o,targetBranch:'main'})).rejects.toThrow('unresolved paths');
 expect(attempts).toBe(2);expect(git(repo,'ls-remote --heads origin main')).toContain(baseline);
}));
test('staging unresolved markers cannot bypass the merge gate when runtime checks are disabled',()=>fixture(async(o,repo)=>{
 const baseline=conflictingBranches(repo);let checks=0;validation=async()=>{checks++;};
 repair=async(r)=>{git(translate(r.projectDir),'add -A');};
 await expect(publishValidatedMerge({...o,targetBranch:'main'})).rejects.toThrow();
 expect(checks).toBe(0);expect(git(repo,'ls-remote --heads origin main')).toContain(baseline);
}));
test('checks off still resolves merge conflicts and publishes (REC-13)',()=>fixture(async(o,repo)=>{
 conflictingBranches(repo);settings={validationEnabled:false,featureTestingEnabled:false};let attempts=0;
 repair=async(r)=>{attempts++;const dir=translate(r.projectDir);writeFileSync(join(dir,'base.txt'),'ticket and epic resolved\n');git(dir,'add base.txt');};
 // Checks being off reports as cancelled/skipped, but nobody pressed Stop.
 const result=await publishValidatedMerge({...o,targetBranch:'main',validation:{...o.validation,cancelled:()=>true,skipped:()=>true,stopped:()=>false}});
 expect(attempts).toBe(1);expect(git(repo,'ls-remote --heads origin main')).toContain(result.sha);
}));
test('a real Stop still cancels conflict resolution',()=>fixture(async(o,repo)=>{
 const baseline=conflictingBranches(repo);let attempts=0;repair=async()=>{attempts++;};
 await expect(publishValidatedMerge({...o,targetBranch:'main',validation:{...o.validation,cancelled:()=>true,stopped:()=>true}})).rejects.toThrow('Merge repair cancelled');
 expect(attempts).toBe(0);expect(git(repo,'ls-remote --heads origin main')).toContain(baseline);
}));
