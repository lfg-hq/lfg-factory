import {test,expect} from 'bun:test';
import {previewDataCommand,previewDataTools,validateDataSql,previewDataWorkspaceCommand} from '../src/services/preview-data-operations.ts';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

test('data operations cannot expose arbitrary source-editing or build tools',async()=>{
 let calls=0;const tools=previewDataTools({run:async()=>{calls++;return {exitCode:0,output:''};},connectionKeys:['DATABASE_URL'],previewUrl:'https://preview.example'});
 expect(Object.keys(tools).sort()).toEqual(['backgroundWorkers','database','databaseInfo','databaseTransaction','generateTestPassword','listFiles','readFile','recallTestLogins','saveTestLogin','verifyLogin']);
 expect('inspect' in tools).toBe(false);
 expect((await (tools.database.execute as any)({connectionKey:'OTHER_DB',sql:'SELECT 1',params:[],maxAffectedRows:1},{})).error).toBeTruthy();
 expect(calls).toBe(0);
 // Full SQL on the local development database; only machine-level escapes stay blocked.
 for(const sql of ['DROP TABLE account','UPDATE account SET password=$1','DELETE FROM account','CREATE TABLE t (id int)','SELECT * INTO copy FROM account'])expect(validateDataSql(sql)).toBe(sql);
 for(const sql of ['COPY account TO PROGRAM x',"SELECT pg_read_file('/etc/passwd')","SELECT dblink_connect('x')"])expect(()=>validateDataSql(sql)).toThrow();
 expect(validateDataSql('UPDATE account SET password=$1 WHERE id=$2;')).toBe('UPDATE account SET password=$1 WHERE id=$2');
});

test('transactions validate every statement before pausing or running and do not bypass connection scope',async()=>{
 const calls:string[]=[];
 const tools=previewDataTools({previewUrl:'https://preview.example',connectionKeys:['DATABASE_URL'],workers:async action=>{calls.push(action);},run:async()=>{calls.push('sql');return {exitCode:0,output:'committed'};}});
 const invoke=(args:any)=>(tools.databaseTransaction.execute as any)(args,{});
 expect((await invoke({connectionKey:'OTHER',statements:[{sql:'SELECT 1'}]})).error).toBeTruthy();
 expect((await invoke({connectionKey:'DATABASE_URL',statements:[{sql:'DELETE FROM jobs WHERE id=$1',params:['one']},{sql:'COPY users TO PROGRAM \'x\''}]})).error).toBeTruthy();
 expect(calls).toEqual([]);
 expect((await invoke({connectionKey:'DATABASE_URL',statements:[{sql:'DELETE FROM jobs WHERE tenant=$1',params:['fixture'],maxAffectedRows:500,expectedRows:46}]})).exitCode).toBe(0);
 expect(calls).toEqual(['pause','sql']);
});

test('fixed database runner binds parameters, redacts credentials, and rolls back excessive writes',()=>{
 const root=mkdtempSync(join(tmpdir(),'preview-data-'));
 mkdirSync(join(root,'node_modules/pg'),{recursive:true});writeFileSync(join(root,'package.json'),'{}');
 const calls=join(root,'queries.jsonl');
 writeFileSync(join(root,'node_modules/pg/index.js'),`const fs=require('fs');exports.Client=class{async connect(){}async end(){}async query(sql,params){fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({sql,params})+'\\n');return {command:sql.startsWith('UPDATE')?'UPDATE':'SELECT',rowCount:Number(process.env.ROW_COUNT||1),rows:[{id:'kept',password:'secret-hash',accessToken:'secret-token'}]}}};`);
 const run=(host:string,rows:number)=>spawnSync('sh',['-c',previewDataCommand({kind:'database',connectionKey:'DATABASE_URL',sql:'UPDATE account SET password=$1 WHERE id=$2',params:['hash;$(touch injected)','existing'],maxAffectedRows:1})],{cwd:root,encoding:'utf8',env:{...process.env,DATABASE_URL:`postgres://user:secret@${host}/preview`,ROW_COUNT:String(rows)}});
 try{
  const success=run('127.0.0.1',1);expect(success.status).toBe(0);const out=JSON.parse(success.stdout);expect(out.rows[0]).toEqual({id:'kept',password:'[redacted]',accessToken:'[redacted]'});
  const query=readFileSync(calls,'utf8').trim().split('\n').map(s=>JSON.parse(s));expect(query.find(q=>q.sql.startsWith('UPDATE')).params).toEqual(['hash;$(touch injected)','existing']);expect(query.at(-1).sql).toBe('COMMIT');
  expect(run('127.0.0.1',2).status).not.toBe(0);expect(readFileSync(calls,'utf8').trim().split('\n').map(s=>JSON.parse(s)).at(-1).sql).toBe('ROLLBACK');
  const before=readFileSync(calls,'utf8');expect(run('production.example',1).status).not.toBe(0);expect(readFileSync(calls,'utf8')).toBe(before);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('structured inspection reads source and reports database metadata without exposing secrets',()=>{
 const root=mkdtempSync(join(tmpdir(),'preview-inspection-'));
 writeFileSync(join(root,'package.json'),'{}');writeFileSync(join(root,'auth.ts'),'export const auth = "better-auth";');writeFileSync(join(root,'.env'),'SECRET=hidden');
 const run=(input:Record<string,unknown>)=>spawnSync('sh',['-c',previewDataWorkspaceCommand(root,previewDataCommand(input))],{encoding:'utf8',env:{...process.env,DATABASE_URL:'postgres://user:private@127.0.0.1/epic'}});
 try{
  const list=JSON.parse(run({kind:'listFiles',path:'.'}).stdout);expect(list.entries.map((e:any)=>e.name)).toEqual(['auth.ts','package.json']);
  expect(JSON.parse(run({kind:'readFile',path:'auth.ts',offset:0}).stdout).content).toContain('better-auth');
  expect(run({kind:'readFile',path:'.env',offset:0}).status).not.toBe(0);
  expect(run({kind:'readFile',path:'/etc/hosts',offset:0}).status).not.toBe(0);
  const info=run({kind:'databaseInfo',connectionKeys:['DATABASE_URL']});expect(info.stdout).not.toContain('private');expect(JSON.parse(info.stdout).connections[0]).toMatchObject({key:'DATABASE_URL',local:true,database:'epic'});
  const invalid=spawnSync('sh',['-c',previewDataWorkspaceCommand(join(root,'missing'),"printf SHOULD_NOT_RUN")],{encoding:'utf8'});expect(invalid.status).not.toBe(0);expect(invalid.stdout).not.toContain('SHOULD_NOT_RUN');
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('INSERT INTO a Better Auth "user" table is accepted', () => {
  expect(validateDataSql('INSERT INTO "user" (id, email) VALUES ($1, $2)')).toContain('INSERT INTO');
});
