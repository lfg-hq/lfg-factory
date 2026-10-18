/** Fixed adapter source embedded in the preview data runner. Inputs never become shell code. */
export const MSSQL_DATA_ADAPTER = String.raw`
function connection(value) {
 if (/^postgres(?:ql)?:/i.test(value)) { const u=new URL(value);return {engine:'postgres',host:u.hostname,port:Number(u.port||5432),database:u.pathname.slice(1),value}; }
 const fields=Object.fromEntries(value.split(';').filter(Boolean).map(p=>{const i=p.indexOf('=');return [p.slice(0,i).trim().toLowerCase(),p.slice(i+1).trim()];}));
 const server=(fields.server||fields['data source']||'').replace(/^tcp:/i,'');
 const [host,port]=server.split(',');
 if(!host || !(fields.database||fields['initial catalog']))throw Error('Unsupported connection format');
 return {engine:'mssql',host,port:Number(port||1433),database:fields.database||fields['initial catalog'],user:fields['user id']||fields.uid,password:fields.password||fields.pwd};
}
function sqlString(value) {return "CONVERT(nvarchar(max),0x"+Buffer.from(String(value),'utf16le').toString('hex')+")";}
function mssqlData(c,input) {
 const {spawnSync}=require('node:child_process');
 if(!c.user||!c.password)throw Error('SQL Server credentials are missing');
 const inspect=spawnSync('docker',['inspect','mssql'],{encoding:'utf8',timeout:5000});
 if(inspect.status!==0)throw Error('Managed SQL Server container is unavailable');
 const container=JSON.parse(inspect.stdout)[0];
 const ports=container.NetworkSettings?.Ports?.['1433/tcp']||[];
 if(!ports.some(p=>Number(p.HostPort)===c.port))throw Error('Connection does not match the managed SQL Server port');
 const statements=input.kind==='transaction'?input.statements:[input];
 let script='SET NOCOUNT ON; SET XACT_ABORT ON; SET LOCK_TIMEOUT 10000; BEGIN TRY BEGIN TRANSACTION; DECLARE @results nvarchar(max)=N\'[]\', @rows nvarchar(max), @count int;\n';
 for(const [i,s] of statements.entries()) {
  // Parameters use @p1, @p2, ...; replace with unique declared variables, never literals in SQL text.
  const sql=s.sql.replace(/@p(\d+)\b/g,(_,n)=>'@s'+i+'p'+n);
  for(const [j,value] of (s.params||[]).entries()) {
   script+='DECLARE @s'+i+'p'+(j+1)+' '+(typeof value==='number'?'float':typeof value==='boolean'?'bit':'nvarchar(max)')+' = '+(value===null?'NULL':typeof value==='number'?String(value):typeof value==='boolean'?(value?'1':'0'):sqlString(value))+';\n';
  }
  if(/^\s*select\b/i.test(sql))script+='SET @rows=('+sql+' FOR JSON PATH, INCLUDE_NULL_VALUES); SET @count=(SELECT COUNT(*) FROM OPENJSON(@rows));\n';
  else script+=sql+'; SET @count=@@ROWCOUNT; SET @rows=N\'[]\';\n';
  if(!/^\s*select\b/i.test(sql))script+='IF @count>'+Number(s.maxAffectedRows??1000)+" THROW 51000,'Row limit exceeded; transaction rolled back',1;\n";
  if(s.expectedRows!==undefined)script+='IF @count<>'+Number(s.expectedRows)+" THROW 51000,'Expected rows did not match; transaction rolled back',1;\n";
  script+="SET @results=JSON_MODIFY(@results,'append $',JSON_QUERY((SELECT "+(i+1)+" AS statement,@count AS affectedRows,JSON_QUERY(@rows) AS rows FOR JSON PATH, WITHOUT_ARRAY_WRAPPER)));\n";
 }
 script+="IF DATALENGTH(@results)>1000000 THROW 51000,'Transaction receipt too large; narrow the query',1; COMMIT; SELECT @results; END TRY BEGIN CATCH IF @@TRANCOUNT>0 ROLLBACK; THROW; END CATCH;";
 const command='client=/opt/mssql-tools18/bin/sqlcmd; test -x "$client" || client=/opt/mssql-tools/bin/sqlcmd; exec "$client" -S localhost -U "$1" -d "$2" -C -b -r 1 -y 0 -w 65535 -t 25';
 const result=spawnSync('docker',['exec','-i','-e','SQLCMDPASSWORD','mssql','sh','-c',command,'sh',c.user,c.database],{input:script,encoding:'utf8',timeout:35000,maxBuffer:4*1024*1024,env:{...process.env,SQLCMDPASSWORD:c.password}});
 if(result.status!==0)throw Error('SQL Server transaction failed or timed out; inspect schema and constraints. No success was confirmed.');
 const start=result.stdout.indexOf('['),end=result.stdout.lastIndexOf(']');
 if(start<0||end<start)throw Error('SQL Server returned no readable transaction receipt; verify data before retrying.');
 const results=JSON.parse(result.stdout.slice(start,end+1)).map(r=>({...r,rows:clean(r.rows.slice(0,30))}));
 return input.kind==='transaction'?{database:c.database,committed:true,results}:{database:c.database,...results[0]};
}
`;

/** ASP.NET Core Identity v3 format: marker, PRF, iterations, salt length, salt, subkey. */
export const IDENTITY_PASSWORD_ADAPTER = String.raw`
if(input.scheme==='aspnet-identity-v3') {
 const crypto=require('node:crypto');
 const iterations=input.iterations||100000;
 if(!Number.isInteger(iterations)||iterations<10000||iterations>1000000)throw Error('Invalid Identity iteration count');
 const salt=crypto.randomBytes(16),header=Buffer.alloc(13);header[0]=1;
 header.writeUInt32BE(2,1);header.writeUInt32BE(iterations,5);header.writeUInt32BE(salt.length,9);
 hash=Buffer.concat([header,salt,crypto.pbkdf2Sync(password,salt,iterations,32,'sha512')]).toString('base64');
} else
`;
