import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {targetedSqlCommand} from '../src/services/preview-sql-target.ts';
import {validateSchemaTargets,schemaStepSchema} from '../src/services/preview-plan.ts';
test('multi-database recipes require known targets, legacy single database is compatible',()=>{
 const step=schemaStepSchema.parse({kind:'sqlScript',command:'seed.sql',verify:'check'});
 const dbs=[{engine:'mssql',connectionEnvVar:'WEB'},{engine:'mssql',connectionEnvVar:'ADMIN'}];
 expect(()=>validateSchemaTargets([step],dbs)).toThrow('SQL_TARGET_REQUIRED');
 expect(()=>validateSchemaTargets([{...step,connectionKey:'WRONG'}],dbs)).toThrow('Unknown');
 expect(()=>validateSchemaTargets([{...step,connectionKey:'WEB'}],dbs)).not.toThrow();
 expect(()=>validateSchemaTargets([step],dbs.slice(0,1))).not.toThrow();
});
test('SQL targets resolve current branch connection and reject external or context-switch scripts',()=>{
 const dir=mkdtempSync(join(tmpdir(),'sql-target-'));
 try {
  writeFileSync(join(dir,'docker'),'#!/usr/bin/env python3\nimport sys,json\nopen("args","w").write(json.dumps(sys.argv[1:]))\nopen("input","w").write(sys.stdin.read())\n',{mode:0o755});
  writeFileSync(join(dir,'seed.sql'),'\ufeffSELECT 1;');
  const run=(connection:string)=>spawnSync('bash',['-c',targetedSqlCommand('seed.sql','WEB','mssql','mssql',1433)],{cwd:dir,env:{...process.env,PATH:dir+':'+process.env.PATH,WEB:connection},encoding:'utf8'});
  for(const database of ['pv_branch_a','pv_branch_b']) {
   expect(run(`Server=127.0.0.1,1433;Database=${database};User Id=sa;Password=test;`).status).toBe(0);
   expect(JSON.parse(readFileSync(join(dir,'args'),'utf8')).at(-1)).toBe(database);
   expect(readFileSync(join(dir,'input'),'utf8')).toBe('SELECT 1;');
  }
  for(const connection of ['', 'Server=external;Database=app;User Id=sa;Password=test;', 'Server=localhost,1434;Database=app;User Id=sa;Password=test;']) expect(run(connection).status).not.toBe(0);
  writeFileSync(join(dir,'seed.sql'),'USE other;\nSELECT 1;');
  expect(run('Server=localhost;Database=app;User Id=sa;Password=test;').status).not.toBe(0);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
