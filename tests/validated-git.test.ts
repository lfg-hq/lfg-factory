import { test, expect, mock } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import * as sandbox from "../src/services/validation-sandbox.ts";
const originalSandbox = {...sandbox};
let root='';let validation: (o:any)=>Promise<void> = async()=>{};let repairs=0;let repair:()=>void=()=>{};
const translate=(s:string)=>s.replaceAll('/data/validation-merge-',root+'/merge-');
// The host's wrapped base64 opens /dev/stdout, which this filesystem sandbox
// denies for redirected files. Decode through Python's existing stdout FD.
const shell=(script:string)=>{const command=translate(script).replaceAll("base64 -d", `python3 -c 'import base64,sys;sys.stdout.buffer.write(base64.b64decode(sys.stdin.buffer.read()))'`);const r=spawnSync('bash',['-c',command],{encoding:'utf8'});return {exitCode:r.status??1,output:r.stdout+'\n'+r.stderr};};
mock.module('../src/services/validation-sandbox.ts',()=>({...originalSandbox,validationShell:async(_:string,s:string)=>shell(s)}));
mock.module('../src/services/runtime-validation.ts',()=>({CONTRACT_INSTRUCTION:'repair source',ensureValidationRecipe:async(_:string,dir:string)=>{try{return JSON.parse(readFileSync(join(translate(dir),".lfg-validation.json"),"utf8"));}catch{return {};}},validateRevision:async(o:any)=>{await validation(o);return {id:"receipt",projectId:o.context.projectId,branch:o.branch,revision:o.revision,baseline:o.baseline,status:"passed",freshPassed:true,upgradePassed:true};}}));
mock.module('../src/services/merge-resolver.ts',()=>({runValidationRepair:async()=>{repairs++;repair();}}));
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
