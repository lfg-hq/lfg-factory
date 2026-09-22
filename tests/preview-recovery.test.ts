import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {backupThenReset,databaseRecoveryScripts} from '../src/services/preview-db-recovery.ts';
import {replaceVerifiedPatches} from '../src/services/preview-patch-recovery.ts';
import {buildConfigPatchScript} from '../src/services/preview-patches.ts';
const engine={engine:'mssql' as const,host:'127.0.0.1',port:1433,username:'sa',password:'test-password',dbName:'dev',connectionString:''};
const backupId='11111111-1111-1111-1111-111111111111';
test('no reset after failed or unverified backup',async()=>{
 for(const backup of [{exitCode:1,output:'BACKUP_VERIFIED'},{exitCode:0,output:'done'}]) {
  let reset=false;
  await expect(backupThenReset({backup:async()=>backup,record:async()=>{},reset:async()=>{reset=true;return {exitCode:0,output:'DATABASE_RESET'};}})).rejects.toThrow('not attempted');expect(reset).toBe(false);
 }
});
test('backup location must be persisted before reset',async()=>{
 const events:string[]=[];
 await backupThenReset({backup:async()=>{events.push('backup');return {exitCode:0,output:'BACKUP_VERIFIED'};},record:async()=>{events.push('record');},reset:async()=>{events.push('reset');return {exitCode:0,output:'DATABASE_RESET'};}});
 expect(events).toEqual(['backup','record','reset']);
 let reset=false;
 await expect(backupThenReset({backup:async()=>({exitCode:0,output:'BACKUP_VERIFIED'}),record:async()=>{throw new Error('storage down');},reset:async()=>{reset=true;return {exitCode:0,output:''};}})).rejects.toThrow('storage down');expect(reset).toBe(false);
});
test('failed reset retains explicit backup recovery guidance',async()=>{
 await expect(backupThenReset({backup:async()=>({exitCode:0,output:'BACKUP_VERIFIED'}),record:async()=>{},reset:async()=>({exitCode:1,output:''})})).rejects.toThrow('backup is retained');
});
test('database identifiers and engine scope fail closed',()=>{
 for(const database of ['master','tempdb','dev]; DROP TABLE x']) expect(()=>databaseRecoveryScripts({engine,database,dir:'/data/project',connectionKey:'DB',backupId})).toThrow();
 expect(()=>databaseRecoveryScripts({engine:{...engine,engine:'mysql'},database:'dev',dir:'/data/project',connectionKey:'DB',backupId})).toThrow('managed SQL Server');
});
test('real connection guard rejects external, mismatched and missing credentials before Docker',()=>{
 const dir=mkdtempSync(join(tmpdir(),'recovery-'));
 try {
  const scripts=databaseRecoveryScripts({engine,database:'dev',dir,connectionKey:'DB',backupId});
  const guard=scripts.backup.slice(0,scripts.backup.indexOf('\nmkdir -p'));
  for(const value of ['Server=example.com;Database=dev;User Id=sa;Password=test-password;', 'Server=127.0.0.1;Database=other;User Id=sa;Password=test-password;','Server=127.0.0.1;Database=dev;User Id=sa;Password=wrong;']) {
   writeFileSync(join(dir,'.env'),`DB='${value}'\n`);expect(spawnSync('bash',['-c',guard]).status).not.toBe(0);
  }
  writeFileSync(join(dir,'.env'),"DB='Server=127.0.0.1,1433;Database=dev;User Id=sa;Password=test-password;'\n");
  expect(spawnSync('bash',['-c',guard]).status).toBe(0);
  expect(scripts.backup).toContain('RESTORE VERIFYONLY');expect(scripts.backup).toContain('COPY_ONLY');expect(scripts.backup).not.toContain('DROP DATABASE');expect(scripts.reset.indexOf('sha256sum -c')).toBeLessThan(scripts.reset.indexOf('DROP DATABASE'));
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('stale patch replacement qualifies clean and current before save',async()=>{
 const events:string[]=[];const patch={file:'a',find:'old',replace:'new'};
 await replaceVerifiedPatches([patch],{verifyClean:async()=>{events.push('clean');},verifyCurrent:async()=>{events.push('current');},save:async()=>{events.push('save');}});expect(events).toEqual(['clean','current','save']);
 let saved=false;
 await expect(replaceVerifiedPatches([patch],{verifyClean:async()=>{throw new Error('stale');},verifyCurrent:async()=>{},save:async()=>{saved=true;}})).rejects.toThrow('stale');expect(saved).toBe(false);
});
test('rejects chained and unverifiable deletion patches',async()=>{
 const io={verifyClean:async()=>{},verifyCurrent:async()=>{},save:async()=>{}};
 await expect(replaceVerifiedPatches([{file:'a',find:'x',replace:'y'},{file:'a',find:'y',replace:'z'}],io)).rejects.toThrow('one patch per file');
 await expect(replaceVerifiedPatches([{file:'a',find:'x',replace:''}],io)).rejects.toThrow('surrounding');
});
test('dry-run validates without writing and changed patches replay on clean and warm JSONC',()=>{
 const dir=mkdtempSync(join(tmpdir(),'patch-recovery-'));
 try{
  const file=join(dir,'appsettings.json');const original='// keep comment\n{"sink":"changed"}';writeFileSync(file,original);
  const old={file:'appsettings.json',find:'"obsolete"',replace:'"disabled"'};
  expect(spawnSync('bash',['-c',buildConfigPatchScript([old],dir,true)]).status).not.toBe(0);expect(readFileSync(file,'utf8')).toBe(original);
  const next={...old,find:'"changed"'};
  expect(spawnSync('bash',['-c',buildConfigPatchScript([next],dir,true)]).status).toBe(0);expect(readFileSync(file,'utf8')).toBe(original);
  for(let i=0;i<2;i++)expect(spawnSync('bash',['-c',buildConfigPatchScript([next],dir)]).status).toBe(0);
  expect(readFileSync(file,'utf8')).toContain('// keep comment');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('consolidation replaces obsolete chains and replays idempotently without unrelated files',async()=>{
 const {consolidatePatchScript}=await import('../src/services/preview-patch-recovery.ts');
 const root=mkdtempSync(join(tmpdir(),'consolidation-'));const clean=join(root,'clean'),warm=join(root,'warm');
 mkdirSync(clean);mkdirSync(warm);
 try {
  for (const [before,after] of [['alpha\nold\nfooter','alpha\nfinal\nfooter'],['abc','abcd'],['first\nmiddle\nlast','FIRST\nmiddle\nLAST']]) {
   writeFileSync(join(clean,'config'),before);writeFileSync(join(warm,'config'),after);
   writeFileSync(join(warm,'unrelated'),'do not capture');
   const captured=spawnSync('bash',['-c',consolidatePatchScript([{file:'config',find:'old',replace:'intermediate'},{file:'config',find:'intermediate',replace:'final'}],clean,warm)],{encoding:'utf8'});
   expect(captured.status).toBe(0);const patches=JSON.parse(captured.stdout);expect(patches.length).toBe(1);expect(patches[0].file).toBe('config');
   for (const dir of [clean,warm,clean,warm]) {
    expect(spawnSync('bash',['-c',buildConfigPatchScript(patches,dir)]).status).toBe(0);
    expect(readFileSync(join(dir,'config'),'utf8')).toBe(after);
   }
   writeFileSync(join(clean,'config'),'new branch content');
   expect(spawnSync('bash',['-c',buildConfigPatchScript(patches,clean)]).status).not.toBe(0);
   expect(readFileSync(join(clean,'config'),'utf8')).toBe('new branch content');
  }
  writeFileSync(join(warm,'created'),'new settings');
  const created=spawnSync('bash',['-c',consolidatePatchScript([{file:'created',find:'',replace:'new settings',create:true}],clean,warm)],{encoding:'utf8'});
  expect(created.status).toBe(0);
  for (const dir of [clean,warm]) expect(spawnSync('bash',['-c',buildConfigPatchScript(JSON.parse(created.stdout),dir)]).status).toBe(0);
  expect(readFileSync(join(clean,'created'),'utf8')).toBe('new settings');
  const noop=spawnSync('bash',['-c',consolidatePatchScript([{file:'unrelated',find:'x',replace:'y',create:true}],warm,warm)],{encoding:'utf8'});
  expect(JSON.parse(noop.stdout)).toEqual([]);
  expect(spawnSync('bash',['-c',consolidatePatchScript([{file:'../escape',find:'x',replace:'y'}],clean,warm)]).status).not.toBe(0);
 } finally {rmSync(root,{recursive:true,force:true});}
});
