import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {executeSandboxScript} from '../src/services/sandbox-script.ts';
import {buildConfigPatchScript} from '../src/services/preview-patches.ts';
import {consolidatePatchScript} from '../src/services/preview-patch-recovery.ts';
test('large repair normalization and replay use bounded shell arguments',async()=>{
 const root=mkdtempSync(join(tmpdir(),'large-repair-'));const clean=join(root,'clean'),warm=join(root,'warm');mkdirSync(clean);mkdirSync(warm);
 const exec=async(command:string,timeout:number)=>{
  expect(Buffer.byteLength(command)).toBeLessThan(25000);
  const r=spawnSync('bash',['-c',command],{encoding:'utf8',timeout,maxBuffer:8*1024*1024});
  return {exitCode:r.status??-1,output:r.stdout,stderr:r.stderr};
 };
 try {
  const before='a'.repeat(200000)+'\nold\n'+'b'.repeat(200000),after='x'.repeat(200000)+'\nnew\n'+'y'.repeat(200000);
  writeFileSync(join(clean,'config'),before);writeFileSync(join(warm,'config'),after);
  const patches=[{file:'config',find:before,replace:after}];
  const normalized=await executeSandboxScript(consolidatePatchScript(patches,clean,warm),30000,exec);
  expect(normalized.exitCode).toBe(0);const saved=JSON.parse(normalized.output!);
  for(const dir of [clean,warm]) {
   expect((await executeSandboxScript(buildConfigPatchScript(saved,dir),30000,exec)).exitCode).toBe(0);
   expect(readFileSync(join(dir,'config'),'utf8')).toBe(after);
  }
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('failed transfer cleans up and never executes a partial script',async()=>{
 const calls:string[]=[];
 const result=await executeSandboxScript('x'.repeat(50000),1234,async(command)=>{
  calls.push(command);return {exitCode:command.includes('printf')?1:0,output:''};
 });
 expect(result.exitCode).toBe(1);expect(calls.some(c=>c.includes('&& bash'))).toBe(false);expect(calls.at(-1)).toStartWith('rm -rf');
});
test('small scripts retain single request and requested timeout',async()=>{
 let calls=0;await executeSandboxScript('true',12345,async(command,timeout)=>{calls++;expect(timeout).toBe(12345);return {exitCode:0};});expect(calls).toBe(1);
});
