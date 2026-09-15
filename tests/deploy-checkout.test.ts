import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const guard=resolve('scripts/check-deploy-checkout.sh');
test('deployment guard detects missing tracked source and permits restored files',()=>{
 const dir=mkdtempSync(join(tmpdir(),'deploy-checkout-'));
 try{
  spawnSync('git',['init','-q',dir]);mkdirSync(join(dir,'src'));writeFileSync(join(dir,'src','required.ts'),'export {};');spawnSync('git',['add','src'],{cwd:dir});
  const check=()=>spawnSync('bash',[guard],{cwd:dir,encoding:'utf8'});
  expect(check().status).toBe(0);
  rmSync(join(dir,'src','required.ts'));const failed=check();expect(failed.status).toBe(1);expect(failed.stderr).toContain('src/required.ts');
  writeFileSync(join(dir,'src','required.ts'),'export {};');expect(check().status).toBe(0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('deployment guard rejects a folder with lost checkout metadata',()=>{
 const dir=mkdtempSync(join(tmpdir(),'deploy-no-git-'));
 try{const result=spawnSync('bash',[guard],{cwd:dir,encoding:'utf8'});expect(result.status).toBe(1);expect(result.stderr).toContain('Git checkout metadata');}finally{rmSync(dir,{recursive:true,force:true});}
});
