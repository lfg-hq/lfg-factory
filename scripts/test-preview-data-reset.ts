/** Explicit integration check: disposable PostgreSQL + real Better Auth HTTP API.
 * Run with PG_BIN=/path/to/postgres/bin bun scripts/test-preview-data-reset.ts.
 * Never connects to project databases or reads project .env files.
 */
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:net';
import {Pool} from 'pg';
import {betterAuth} from 'better-auth';
import {getMigrations} from 'better-auth/db';
import {previewDataTools,previewDataWorkspaceCommand} from '../src/services/preview-data-operations.ts';
const execFile=promisify(execFileCallback);
const root=mkdtempSync(join(tmpdir(),'preview-reset-e2e-'));
const pgBin=process.env.PG_BIN;if(!pgBin)throw Error('Set PG_BIN to an installed PostgreSQL bin directory');
const socket=createServer();await new Promise<void>(r=>socket.listen(0,'127.0.0.1',r));const port=(socket.address() as any).port;await new Promise<void>(r=>socket.close(()=>r()));
let started=false;let pool:Pool|undefined;let server:ReturnType<typeof Bun.serve>|undefined;
try{
 await execFile(join(pgBin,'initdb'),['-D',join(root,'db'),'-A','trust','-U','fixture','--no-locale']);
 await execFile(join(pgBin,'pg_ctl'),['-D',join(root,'db'),'-l',join(root,'postgres.log'),'-o',`-h 127.0.0.1 -p ${port} -k ${root}`,'-w','start']);started=true;
 const connection=`postgres://fixture@127.0.0.1:${port}/postgres`;pool=new Pool({connectionString:connection});
 let auth:ReturnType<typeof betterAuth>;
 server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:request=>auth.handler(request)});
 const origin=server.url.origin;
 auth=betterAuth({database:pool,baseURL:origin,secret:'integration-only-secret-with-more-than-32-chars',emailAndPassword:{enabled:true},user:{additionalFields:{role:{type:'string',defaultValue:'admin'}}}});
 await (await getMigrations(auth.options)).runMigrations();
 const email='admin@preview.local';const oldPassword='OldPreview!123456';
 const account=await auth.api.signUpEmail({body:{email,name:'Preview admin',password:oldPassword}});
 await auth.api.signUpEmail({body:{email:'unrelated@preview.local',name:'Unrelated',password:'Unrelated!123456'}});
 const untouched=(await pool.query('SELECT * FROM account WHERE "userId" <> $1',[account.user.id])).rows;
 writeFileSync(join(root,'package.json'),'{"dependencies":{"better-auth":"installed","pg":"installed"}}');
 writeFileSync(join(root,'auth.ts'),'// Fixture: Better Auth with default password hashing and credential accounts.');
 symlinkSync(resolve('node_modules'),join(root,'node_modules'),'dir');
 const workerActions:string[]=[];
 const tools=previewDataTools({connectionKeys:['DATABASE_URL'],previewUrl:origin,workers:async action=>{workerActions.push(action);return {paused:action==='pause'};},run:async command=>{
  try{const r=await execFile('sh',['-c',previewDataWorkspaceCommand(root,command)],{env:{PATH:process.env.PATH,DATABASE_URL:connection},maxBuffer:1000000});return {exitCode:0,output:r.stdout};}catch(e:any){return {exitCode:1,output:e.stderr};}
 }});
 const call=async(name:keyof typeof tools,args:any={})=>{const r=await (tools[name].execute as any)(args,{});assert.equal(r.exitCode,0,r.output);return JSON.parse(r.output);};
 assert((await call('listFiles',{path:'.'})).entries.some((e:any)=>e.name==='auth.ts'));
 assert((await call('readFile',{path:'auth.ts',offset:0})).content.includes('Better Auth'));
 assert.equal((await call('databaseInfo')).connections[0].database,'/postgres');
 const rows=await call('database',{connectionKey:'DATABASE_URL',sql:'SELECT id, "userId" FROM account WHERE "providerId"=$1 AND "userId"=$2',params:['credential',account.user.id],maxAffectedRows:1});assert.equal(rows.rows.length,1);
 const generated=await call('generateTestPassword',{scheme:'better-auth'});
 const updated=await call('database',{connectionKey:'DATABASE_URL',sql:'UPDATE account SET password=$1 WHERE id=$2',params:[generated.hash,rows.rows[0].id],maxAffectedRows:1});assert.equal(updated.affectedRows,1);
 const login=await call('verifyLogin',{path:'/api/auth/sign-in/email',body:{email,password:generated.password},verifyPath:'/api/auth/get-session'});
 assert.equal(login.loginStatus,200);assert.equal(login.sessionIssued,true);assert.equal(login.verification.status,200);assert.equal(login.verification.body.user.id,account.user.id);assert.equal(login.verification.body.user.role,'admin');assert.equal(login.verification.body.session.token,'[redacted]');
 const old=await call('verifyLogin',{path:'/api/auth/sign-in/email',body:{email,password:oldPassword}});assert.equal(old.loginStatus,401);
 assert.deepEqual((await pool.query('SELECT * FROM account WHERE "userId" <> $1',[account.user.id])).rows,untouched);
 // Multi-table processing cleanup: real foreign keys, >20 records, one commit,
 // rollback on either a late SQL error or a failed postcondition, preserved auth.
 await pool.query('CREATE TABLE fixture_runs(id int primary key, tenant text); CREATE TABLE fixture_documents(id int primary key, run_id int references fixture_runs(id)); CREATE TABLE fixture_jobs(id int primary key, run_id int references fixture_runs(id))');
 await pool.query("INSERT INTO fixture_runs VALUES(1,'target'),(2,'keep'); INSERT INTO fixture_documents SELECT x,1 FROM generate_series(1,46) x; INSERT INTO fixture_documents VALUES(99,2); INSERT INTO fixture_jobs VALUES(1,1),(2,2)");
 const stmt=(sql:string,params:any[],maxAffectedRows:number,expectedRows?:number)=>({sql,params,maxAffectedRows,expectedRows});
 const deletions=[stmt('DELETE FROM fixture_jobs WHERE run_id=$1',[1],1,1),stmt('DELETE FROM fixture_documents WHERE run_id=$1',[1],46,46),stmt('DELETE FROM fixture_runs WHERE id=$1',[1],1,1)];
 for(const ending of [stmt('SELECT 1 FROM missing_fixture_table',[],0),stmt('SELECT id FROM fixture_documents WHERE run_id=$1',[1],0,1)]){
  const failed=await (tools.databaseTransaction.execute as any)({connectionKey:'DATABASE_URL',statements:[...deletions,ending]},{});assert.equal(failed.exitCode,1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM fixture_documents WHERE run_id=1')).rows[0].n,46);
  assert.equal((await pool.query('SELECT count(*)::int n FROM fixture_jobs WHERE run_id=1')).rows[0].n,1);
 }
 const result=await call('databaseTransaction',{connectionKey:'DATABASE_URL',statements:[...deletions,stmt('SELECT id FROM fixture_documents WHERE run_id=$1',[1],0,0),stmt('SELECT id FROM fixture_runs WHERE id=$1',[2],0,1)]});
 assert.equal(result.committed,true);assert.deepEqual(result.results.slice(0,3).map((r:any)=>r.affectedRows),[1,46,1]);
 assert.deepEqual((await pool.query('SELECT id FROM fixture_documents')).rows,[{id:99}]);
 assert.deepEqual((await pool.query('SELECT * FROM account WHERE "userId" <> $1',[account.user.id])).rows,untouched);
 assert.equal((await call('verifyLogin',{path:'/api/auth/sign-in/email',body:{email,password:generated.password}})).loginStatus,200);
 assert.deepEqual(workerActions,['pause','pause','pause']);
 console.log('PASS: atomic multi-table cleanup, 46 records, late-error/assertion rollback, unrelated data and login preserved; worker pause requested before every transaction.');
 console.log('PASS: source inspection → database selection → real Better Auth hash → PostgreSQL reset → HTTP login/session/admin role; old password rejected, identity and unrelated account preserved.');
}finally{server?.stop(true);await pool?.end();if(started)await execFile(join(pgBin,'pg_ctl'),['-D',join(root,'db'),'-m','immediate','-w','stop']);rmSync(root,{recursive:true,force:true});}
