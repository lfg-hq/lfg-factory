/**
 * The fixed Node program behind preview data operations (accounts, test data).
 * Model input reaches it only as base64 JSON data (argv[1]), never as code.
 *
 * LFG Desktop runs the same program in a preview on the person's computer. Its copy,
 * desktop/src/preview-data-program.ts, is generated from this file:
 *   bun desktop/scripts/copy-data-program.ts
 * and tests/preview-data-program-copy.test.ts fails when the two differ.
 */
import {MSSQL_DATA_ADAPTER, IDENTITY_PASSWORD_ADAPTER} from './preview-mssql.ts';

export function previewDataProgram():string {
 return `
const {createRequire}=require('node:module');
const appRequire=createRequire(process.cwd()+'/package.json');
const input=JSON.parse(Buffer.from(process.argv[1],'base64').toString());
const clean=(v)=>Array.isArray(v)?v.map(clean):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,/password|token|secret|cookie/i.test(k)?'[redacted]':clean(x)])):v;
${MSSQL_DATA_ADAPTER}
(async()=>{
 if(input.kind==='listFiles'||input.kind==='readFile'){
  const fs=require('node:fs'),path=require('node:path');const root=fs.realpathSync(process.cwd());
  const target=fs.realpathSync(path.resolve(root,input.path));const relative=path.relative(root,target);
  const blocked=(p)=>p.split(path.sep).some(part=>part==='..'||['.git','node_modules'].includes(part)||part.startsWith('.env'));
  if(path.isAbsolute(relative)||blocked(relative)||blocked(input.path))throw Error('Use a source path within the selected checkout; environment files are available only through databaseInfo');
  if(input.kind==='listFiles'){console.log(JSON.stringify({path:relative||'.',entries:fs.readdirSync(target,{withFileTypes:true}).filter(e=>!blocked(e.name)).slice(0,200).map(e=>({name:e.name,directory:e.isDirectory()}))}));return;}
  const stat=fs.statSync(target);if(!stat.isFile()||stat.size>1000000)throw Error('Choose a source file under 1 MB');
  const content=fs.readFileSync(target,'utf8');console.log(JSON.stringify({path:relative,content:content.slice(input.offset,input.offset+20000),nextOffset:content.length>input.offset+20000?input.offset+20000:null}));return;
 }
 if(input.kind==='databaseInfo'){
  console.log(JSON.stringify({connections:input.connectionKeys.map(key=>{const value=process.env[key];if(!value)return {key,configured:false};try{const c=connection(value);return {key,configured:true,engine:c.engine,host:c.host,port:c.port,database:c.database,local:['localhost','127.0.0.1','[::1]'].includes(c.host)};}catch{return {key,configured:true,error:'Invalid connection URL'};}})}));return;
 }
 if(input.kind==='password'){
  const password=typeof input.password==='string'&&input.password.length>=8?input.password:'Preview!'+require('node:crypto').randomBytes(18).toString('base64url');
  let hash;
  ${IDENTITY_PASSWORD_ADAPTER}
  if(input.scheme==='better-auth'){const crypto=await import(appRequire.resolve('better-auth/crypto'));hash=await crypto.hashPassword(password);}
  else {const bcrypt=appRequire(input.scheme);hash=await bcrypt.hash(password,12);}
  console.log(JSON.stringify({password,hash}));return;
 }
 if(input.kind==='login'){
  const url=new URL(input.path,input.origin);if(url.origin!==input.origin)throw Error('Login must target the selected preview');
  const response=await fetch(url,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/json',Origin:input.origin},body:JSON.stringify(input.body),signal:AbortSignal.timeout(15000)});
  const cookies=response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  let checked=null;
  if(input.verifyPath&&cookies){const target=new URL(input.verifyPath,input.origin);if(target.origin!==input.origin)throw Error('Verification must target the selected preview');
   const result=await fetch(target,{redirect:'manual',headers:{Cookie:cookies},signal:AbortSignal.timeout(15000)});
   checked={status:result.status,body:clean(await result.json().catch(()=>null))};}
  console.log(JSON.stringify({loginStatus:response.status,sessionIssued:!!cookies,verification:checked}));return;
 }
 const value=process.env[input.connectionKey];if(!value)throw Error('Selected database connection is missing');
 const selected=connection(value);if(!['localhost','127.0.0.1','[::1]'].includes(selected.host))throw Error('Only the selected local development database is supported');
 if(selected.engine==='mssql'){console.log(JSON.stringify(mssqlData(selected,input)));return;}
 const url=new URL(value);
 const {Client}=appRequire('pg');const client=new Client({connectionString:value,connectionTimeoutMillis:5000});
 try{await client.connect();await client.query('BEGIN');await client.query("SET LOCAL statement_timeout = '10s'");
  const deadline=Date.now()+20000;
  const results=[];
  for(const [index,statement] of (input.kind==='transaction'?input.statements:[input]).entries()){
   if(Date.now()>deadline)throw Error('Data transaction deadline exceeded; transaction rolled back');
   const result=await client.query(statement.sql,statement.params);
   if(result.command!=='SELECT'&&result.rowCount>statement.maxAffectedRows)throw Error('Row limit exceeded; transaction rolled back');
   if(statement.expectedRows!==undefined&&result.rowCount!==statement.expectedRows)throw Error('Statement '+(index+1)+' did not match expectedRows; transaction rolled back');
   results.push({statement:index+1,affectedRows:result.rowCount,rows:clean(result.rows.slice(0,30))});
  }
  await client.query('COMMIT');console.log(JSON.stringify(input.kind==='transaction'?{database:url.pathname,committed:true,results}:{database:url.pathname,...results[0]}));
 }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{await client.end();}
})().catch(e=>{console.error(JSON.stringify({error:e.code||e.message}));process.exitCode=1;});`;
}
