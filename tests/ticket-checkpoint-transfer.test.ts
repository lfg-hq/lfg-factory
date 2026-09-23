import {test,expect,mock} from 'bun:test';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const temp=await mkdtemp(join(tmpdir(),'lfg-checkpoint-test-'));
process.env.TICKET_CHECKPOINT_DIR=join(temp,'durable');
let corrupt=false;
mock.module('../src/services/mags.ts',()=>({execOnWorkspace:async(_ws:string,command:string)=>{
 const result=spawnSync('bash',['-c',command],{encoding:'utf8',maxBuffer:4*1024*1024});
 if(result.status) console.error(result.stderr);
 return {exitCode:result.status ?? 1,output:corrupt && command.includes('f.seek(')?'bad':result.stdout,stderr:result.stderr};
}}));
const {checkpointTicketWorkspace,readTicketCheckpoint,restoreTicketCheckpoint}=await import('../src/services/ticket-workspace-checkpoint.ts');
function git(root:string,...args:string[]){const r=spawnSync('git',['-C',root,...args],{encoding:'utf8'});if(r.status)throw new Error(r.stderr);return r.stdout.trim();}
test('actual archive transfer restores code and keeps previous checkpoint when transfer is corrupt',async()=>{
 try {
  const source=join(temp,'source');spawnSync('mkdir',['-p',source]);
  git(source,'init','-b','main');git(source,'config','user.name','Test');git(source,'config','user.email','test@lfg.dev');
  await writeFile(join(source,'file'),'base');git(source,'add','.');git(source,'commit','-m','base');git(source,'checkout','-b','feature/ticket');
  await writeFile(join(source,'file'),'unsaved-to-git');
  await checkpointTicketWorkspace('ticket','workspace',source,'feature/ticket');
  const checkpoint=await readTicketCheckpoint('ticket');expect(checkpoint?.branch).toBe('feature/ticket');
  const restored=join(temp,'restored');expect(await restoreTicketCheckpoint('ticket','workspace',restored,'feature/ticket')).toBe(true);
  expect(await readFile(join(restored,'file'),'utf8')).toBe('unsaved-to-git');expect(git(restored,'status','--porcelain')).toBe('M file');
  await expect(checkpointTicketWorkspace('ticket','workspace',source,'wrong-branch')).rejects.toThrow('branch changed');
  corrupt=true;await expect(checkpointTicketWorkspace('ticket','workspace',source,'feature/ticket')).rejects.toThrow('verification');
  expect((await readTicketCheckpoint('ticket'))?.sha256).toBe(checkpoint?.sha256);
 } finally {await rm(temp,{recursive:true,force:true});}
});
