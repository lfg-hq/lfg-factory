import {test,expect,mock} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
let root='';let validation:(o:any)=>Promise<void>=async()=>{};
const translate=(s:string)=>s.replaceAll('/data/validation-merge-',root+'/merge-');
const shell=(script:string)=>{const r=spawnSync('bash',['-c',translate(script)],{encoding:'utf8'});return {exitCode:r.status??1,output:r.stdout+'\n'+r.stderr};};
mock.module('../src/services/validation-sandbox.ts',()=>({validationShell:async(_:string,s:string)=>shell(s)}));
mock.module('../src/services/ticket-runtime.ts',()=>({runTicketRuntime:async(o:any)=>{
 await validation(o);
 const dir=translate(o.projectDir);
 git(dir,'add -A');
 if(git(dir,'status --porcelain') || shell(`test -f "$(git -C '${dir}' rev-parse --git-path MERGE_HEAD)"`).exitCode===0)git(dir,"-c user.name=Test -c user.email=test@example.test commit -qm verified");
 return git(dir,'rev-parse HEAD');
}}));
const {publishValidatedTicket,publishValidatedMerge}=await import('../src/services/validated-git.ts');
function git(dir:string,args:string){const r=shell(`cd '${dir}' && git ${args}`);if(r.exitCode)throw new Error(r.output);return r.output.trim();}
async function fixture(fn:(o:any,repo:string,bare:string)=>Promise<void>){
 root=mkdtempSync(join(tmpdir(),'validated-git-'));const repo=join(root,'repo');const bare=join(root,'origin.git');validation=async()=>{};
 try{
  shell(`git init -q --bare '${bare}'; git init -q -b main '${repo}'`);
  git(repo,"config user.name Test");git(repo,"config user.email test@example.com");
  writeFileSync(join(repo,'base.txt'),'base');git(repo,'add .');git(repo,"commit -qm base");git(repo,`remote add origin 'file://${bare}'`);git(repo,'push -q origin main');
  git(repo,'checkout -qb feature/ticket');writeFileSync(join(repo,'feature.txt'),'feature');git(repo,'add .');git(repo,'commit -qm feature');
  await fn({workspaceId:'test',projectDir:repo,featureBranch:'feature/ticket',repoUrl:`file://${bare}`,validation:{projectId:'p',userId:'u',baselineBranch:'main'}},repo,bare);
 }finally{rmSync(root,{recursive:true,force:true});}
}
test('failed runtime checks cannot publish or commit pending ticket changes',()=>fixture(async(o,repo)=>{
 writeFileSync(join(repo,'pending.txt'),'pending');const before=git(repo,'rev-parse HEAD');
 validation=async()=>{throw new Error('app does not start');};
 await expect(publishValidatedTicket(o)).rejects.toThrow('app does not start');
 expect(git(repo,'rev-parse HEAD')).toBe(before);expect(git(repo,'ls-remote --heads origin refs/heads/feature/ticket')).toBe('');
}));
test('pending changes are checked before a single final ticket commit and push',()=>fixture(async(o,repo)=>{
 writeFileSync(join(repo,'pending.txt'),'pending');const before=git(repo,'rev-parse HEAD');let calls=0;
 validation=async()=>{calls++;expect(git(repo,'rev-parse HEAD')).toBe(before);expect(git(repo,'status --porcelain')).toContain('pending.txt');};
 const result=await publishValidatedTicket(o);expect(calls).toBe(1);expect(result.sha).not.toBe(before);
 expect(git(repo,'ls-remote --heads origin refs/heads/feature/ticket')).toContain(result.sha);
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
