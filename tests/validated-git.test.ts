import { ValidationEnvironmentFailure } from '../src/services/validation-contract.ts';
import { test, expect, mock } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import * as sandbox from "../src/services/validation-sandbox.ts";
const originalSandbox = {...sandbox};
import * as ticketDocument from "../src/services/ticket-document.ts";
const originalTicketDocument = {...ticketDocument};
let repairPrompt='';
let root='';let validation: (o:any)=>Promise<void> = async()=>{};let repairs=0;let repair:()=>void=()=>{};
const translate=(s:string)=>s.replaceAll('/data/validation-merge-',root+'/merge-');
// The host's wrapped base64 opens /dev/stdout, which this filesystem sandbox
// denies for redirected files. Decode through Python's existing stdout FD.
const shell=(script:string)=>{const command=translate(script).replaceAll("base64 -d", `python3 -c 'import base64,sys;sys.stdout.buffer.write(base64.b64decode(sys.stdin.buffer.read()))'`);const r=spawnSync('bash',['-c',command],{encoding:'utf8'});return {exitCode:r.status??1,output:r.stdout+'\n'+r.stderr};};
mock.module('../src/services/validation-sandbox.ts',()=>({...originalSandbox,validationShell:async(_:string,s:string)=>shell(s)}));
mock.module('../src/services/runtime-validation.ts',()=>({CONTRACT_INSTRUCTION:'repair source',ensureValidationRecipe:async(_:string,dir:string)=>{try{return JSON.parse(readFileSync(join(translate(dir),".lfg-validation.json"),"utf8"));}catch{return {};}},validateRevision:async(o:any)=>{await validation(o);return {id:"receipt",projectId:o.context.projectId,branch:o.branch,revision:o.revision,baseline:o.baseline,status:"passed",freshPassed:true,upgradePassed:true};}}));
mock.module('../src/services/merge-resolver.ts',()=>({runValidationRepair:async(o:any)=>{repairPrompt=o.prompt;repairs++;repair();}}));
mock.module('../src/services/ticket-document.ts',()=>({...originalTicketDocument,
 updateTicketDocument:async(o:any)=>{const path='docs/ticket.md';const fs=await import('node:fs');fs.mkdirSync(join(translate(o.dir),'docs'),{recursive:true});fs.writeFileSync(join(translate(o.dir),path),'# Implementation\nVerified source.');return {path,summary:'Implemented the ticket.',changed:true};},
 ticketDocumentMessage:()=> 'Implemented the ticket. [Details](docs/ticket.md)',
}));
const {publishValidatedTicket,publishValidatedMerge}=await import('../src/services/validated-git.ts');
function git(dir:string,args:string){const r=shell(`cd '${dir}' && git ${args}`);if(r.exitCode)throw new Error(r.output);return r.output.trim();}
async function fixture(fn:(o:any,repo:string,bare:string)=>Promise<void>){
 root=mkdtempSync(join(tmpdir(),'validated-git-'));const repo=join(root,'repo');const bare=join(root,'origin.git');repairs=0;repair=()=>{};validation=async()=>{};
 try{
  shell(`git init -q --bare '${bare}'; git init -q -b main '${repo}'`);
  git(repo,"config user.name Test");git(repo,"config user.email test@example.com");
  writeFileSync(join(repo,'base.txt'),'base');git(repo,'add .');git(repo,"commit -qm base");git(repo,`remote add origin 'file://${bare}'`);git(repo,'push -q origin main');
  git(repo,'checkout -qb feature/ticket');writeFileSync(join(repo,'feature.txt'),'feature');git(repo,'add .');git(repo,'commit -qm feature');
  await fn({workspaceId:'test',projectDir:repo,featureBranch:'feature/ticket',repoUrl:`file://${bare}`,validation:{projectId:'p',userId:'u',baselineBranch:'main'}},repo,bare);
 }finally{rmSync(root,{recursive:true,force:true});}
}
test('failed runtime validation cannot publish a ticket, even when repair reports success',()=>fixture(async(o,repo,bare)=>{
 validation=async()=>{throw new Error('Migration mismatch');};
 await expect(publishValidatedTicket(o)).rejects.toThrow('Migration mismatch');
 expect(git(repo,'ls-remote --heads origin refs/heads/feature/ticket')).toBe('');expect(repairs).toBe(1);
}));
test('unchanged candidate still validates and publishes the exact tested SHA',()=>fixture(async(o,repo)=>{
 const calls:string[]=[];validation=async(v)=>{calls.push(v.revision);};
 const first=await publishValidatedTicket(o);const second=await publishValidatedTicket(o);
 expect(calls).toEqual([first.sha,first.sha]);expect(second.sha).toBe(first.sha);
 expect(git(repo,'ls-remote --heads origin refs/heads/feature/ticket').split(/\s/)[0]).toBe(first.sha);
}));
test('integration validates a separate merged candidate and keeps the ticket checkout intact',()=>fixture(async(o,repo)=>{
 await publishValidatedTicket(o);const original=git(repo,'rev-parse HEAD');
 let tested='';validation=async(v)=>{tested=v.revision;expect(v.kind).toBe('integration');expect(v.sourceDir).not.toBe(repo);};
 const merged=await publishValidatedMerge({...o,targetBranch:'main'});
 expect(merged.sha).toBe(tested);expect(git(repo,'rev-parse HEAD')).toBe(original);expect(git(repo,'branch --show-current')).toBe('feature/ticket');
 expect(git(repo,'ls-remote --heads origin refs/heads/main').split(/\s/)[0]).toBe(tested);
}));
test('a failed integration cannot move the epic branch',()=>fixture(async(o,repo)=>{
 await publishValidatedTicket(o);const before=git(repo,'ls-remote --heads origin refs/heads/main');
 validation=async()=>{throw new Error('integration regression');};
 await expect(publishValidatedMerge({...o,targetBranch:'main'})).rejects.toThrow('integration regression');
 expect(git(repo,'ls-remote --heads origin refs/heads/main')).toBe(before);
}));
test('target movement while validating rejects publication and preserves the new target',()=>fixture(async(o,repo,bare)=>{
 await publishValidatedTicket(o);let moved='';
 validation=async()=>{moved=git(repo,"rev-parse HEAD");git(bare,`update-ref refs/heads/main ${moved}`);};
 await expect(publishValidatedMerge({...o,targetBranch:'main'})).rejects.toThrow('changed during validation');
 expect(git(bare,'rev-parse refs/heads/main')).toBe(moved);
}));

test('source repairs are committed and the new clean commit is revalidated before publishing',()=>fixture(async(o,repo)=>{
 const tested:string[]=[];
 validation=async(v)=>{tested.push(v.revision);if(tested.length===1)throw new Error('repair required');};
 repair=()=>writeFileSync(join(repo,'repair.txt'),'persisted source repair');
 const result=await publishValidatedTicket(o);
 expect(tested.length).toBe(2);expect(tested[0]).not.toBe(tested[1]);expect(result.sha).toBe(tested[1]);
 expect(git(repo,`show ${result.sha}:repair.txt`)).toBe('persisted source repair');
}));

test('epic candidate retains existing coverage while adding ticket tests',()=>fixture(async(o,repo)=>{
 git(repo,'checkout main');
 writeFileSync(join(repo,'.lfg-validation.json'),JSON.stringify({validation:{tests:['test base']},verificationPaths:['/base']}));
 git(repo,'add .');git(repo,'commit -qm contract');git(repo,'push -q origin main');
 git(repo,'checkout feature/ticket');
 writeFileSync(join(repo,'.lfg-validation.json'),JSON.stringify({validation:{tests:['test ticket']},verificationPaths:['/ticket']}));
 git(repo,'add .');git(repo,'commit -qm contract');
 // Put main in feature history, resolving the contract as a feature-only version.
 shell(`cd '${repo}'; git merge main --no-commit >/dev/null 2>&1; true`);
 writeFileSync(join(repo,'.lfg-validation.json'),JSON.stringify({validation:{tests:['test ticket']},verificationPaths:['/ticket']}));
 git(repo,'add .');git(repo,'commit -qm integrate-base');
 await publishValidatedTicket(o);
 const result=await publishValidatedMerge({...o,targetBranch:'main'});
 const recorded=JSON.parse(git(repo,`show ${result.sha}:.lfg-validation.json`));
 expect(recorded.validation.tests).toEqual(['test base','test ticket']);expect(recorded.verificationPaths).toEqual(['/base','/ticket']);
}));

test('documentation is committed and its final commit validated before publication',()=>fixture(async(o,repo)=>{
 o.validation.ticketId='ticket';const revisions:string[]=[];validation=async(v)=>{revisions.push(v.revision);};
 const result=await publishValidatedTicket(o);
 expect(revisions.length).toBe(2);expect(revisions[0]).not.toBe(revisions[1]);expect(result.sha).toBe(revisions[1]);
 expect(git(repo,`show ${result.sha}:docs/ticket.md`)).toContain('# Implementation');expect(result.documentation?.summary).toBe('Implemented the ticket.');
}));
test('failure validating the documentation commit cannot publish an earlier passing commit',()=>fixture(async(o,repo)=>{
 o.validation.ticketId='ticket';let calls=0;validation=async()=>{if(++calls>1)throw new Error('final validation failed');};
 await expect(publishValidatedTicket(o)).rejects.toThrow('final validation failed');
 expect(git(repo,'ls-remote --heads origin refs/heads/feature/ticket')).toBe('');
}));
test('repair checkpoint exists before rerunning validation and retains original history',()=>fixture(async(o,repo)=>{
 const original=git(repo,'rev-parse HEAD');let calls=0;
 repair=()=>{writeFileSync(join(repo,'fixed.txt'),'repair');};
 validation=async(v)=>{
   expect(git(repo,'status --porcelain')).toBe('');
   if(calls++===0)throw new Error('needs repair');
   expect(git(repo,'log -1 --format=%s')).toBe('fix: runtime validation checkpoint 1');
   expect(git(repo,`merge-base --is-ancestor ${original} HEAD`)).toBe('');
 };
 await publishValidatedTicket(o);expect(calls).toBe(2);
}));
test('commit announcement arrives before validation and identifies the committed work',()=>fixture(async(o,repo)=>{
 const events:string[]=[];
 o.validation.onCheckpoint=async(message:string)=>{events.push(message);expect(message).toContain(git(repo,'rev-parse HEAD').slice(0,12));expect(message).toContain('feature/ticket');expect(message).toContain('feature');};
 validation=async()=>{expect(events.length).toBe(1);expect(events[0]).toContain('Now verifying this commit');};
 await publishValidatedTicket(o);
 expect(events[0]).toContain('Committed');
}));

test('tool install failure selects environment repair and commits the corrected recipe before retry',()=>fixture(async(o,repo)=>{
 let calls=0;
 repair=()=>writeFileSync(join(repo,'.lfg-validation.json'),JSON.stringify({toolchain:['verify-compatible-ef || install-ef']}));
 validation=async()=>{if(calls++===0)throw new ValidationEnvironmentFailure('Downloading dotnet-ef failed','evidence');expect(git(repo,'status --porcelain')).toBe('');};
 await publishValidatedTicket(o);
 expect(repairPrompt).toContain('ENVIRONMENT');expect(repairPrompt).toContain('bounded diagnostic and tool-install commands');expect(repairPrompt).toContain('Preserve database mappings');expect(calls).toBe(2);
}));
test('environment recovery has its own budget after a source repair',()=>fixture(async(o,repo)=>{
 let calls=0;
 repair=()=>writeFileSync(join(repo,'.lfg-validation.json'),JSON.stringify({toolchain:['repair-'+repairs]}));
 validation=async()=>{calls++;if(calls===1)throw new Error('application error');if(calls<4)throw new ValidationEnvironmentFailure('download failed','evidence');};
 await publishValidatedTicket(o);expect(calls).toBe(4);expect(repairs).toBe(3);
}));
test('unchanged repeated environment failure remains blocked from publication',()=>fixture(async(o,repo)=>{
 validation=async()=>{throw new ValidationEnvironmentFailure('feed unreachable','evidence');};
 await expect(publishValidatedTicket(o)).rejects.toThrow('feed unreachable');expect(repairs).toBe(1);
 expect(git(repo,'ls-remote --heads origin refs/heads/feature/ticket')).toBe('');
}));
