import {shellQuote as q} from './preview-plan.ts';
import type {EngineHandle} from './project-sandbox.ts';

/** SQL Server backup includes schema AND data. Other engines fail closed for now. */
export function databaseRecoveryScripts(opts:{engine:EngineHandle;database:string;connectionKey:string;dir:string;backupId:string}) {
  const {engine,database,connectionKey,dir,backupId}=opts;
  if(engine.engine!=='mssql') throw new Error('Automatic reset currently supports managed SQL Server only');
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(database) || ['master','model','msdb','tempdb'].includes(database.toLowerCase())) throw new Error('Unsafe or system database name');
  if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(connectionKey) || !/^[a-f0-9-]{36}$/.test(backupId)) throw new Error('Invalid recovery identifier');
  const path=`/data/lfg-recovery/${backupId}`;
  const native=`/var/opt/mssql/data/lfg-recovery-${backupId}.bak`;
  const payload=Buffer.from(JSON.stringify({key:connectionKey,password:engine.password,port:engine.port,username:engine.username,database})).toString('base64');
  // Match the active connection to this provisioned engine, not just a model-supplied DB name.
  const guard=`python3 - ${q(dir+'/.env')} ${q(payload)} <<'PY'
import base64,json,re,shlex,sys
p=json.loads(base64.b64decode(sys.argv[2])); values={}
for line in open(sys.argv[1]):
    if '=' not in line: continue
    k,v=line.rstrip().split('=',1)
    if k==p['key']: values[k]=shlex.split(v)[0]
parts={k.strip().lower():v.strip() for k,v in re.findall(r'([^;=]+)=([^;]*)',values.get(p['key'],''))}
host=parts.get('server',parts.get('data source','')); port='1433'
if ',' in host: host,port=host.rsplit(',',1)
assert host in ('localhost','127.0.0.1') and int(port)==p['port'], 'External database reset refused'
assert parts.get('password',parts.get('pwd'))==p['password'], 'Database is not managed by this sandbox'
assert parts.get('user id',parts.get('uid'))==p['username'], 'Database user does not match managed engine'
assert parts.get('database',parts.get('initial catalog'))==p['database'], 'Database differs from active connection'
PY`;
  const sql=(statement:string)=>`docker exec -e ${q('SQLCMDPASSWORD='+engine.password)} mssql sh -c 'client=/opt/mssql-tools18/bin/sqlcmd; test -x "$client" || client=/opt/mssql-tools/bin/sqlcmd; exec "$client" -S localhost -U "$1" -C -b -Q "$2"' sh ${q(engine.username)} ${q(statement)}`;
  return {path,
    backup:`set -eu\numask 077\n${guard}\nmkdir -p ${q(path)}\ngit -C ${q(dir)} archive HEAD > ${q(path+'/source.tar')}\n${sql(`BACKUP DATABASE [${database}] TO DISK=N'${native}' WITH COPY_ONLY, INIT, CHECKSUM; RESTORE VERIFYONLY FROM DISK=N'${native}' WITH CHECKSUM;`)}\ndocker cp ${q('mssql:'+native)} ${q(path+'/database.bak')}\ntest -s ${q(path+'/database.bak')}\ndocker exec mssql sha256sum ${q(native)} | cut -d ' ' -f1 > ${q(path+'/native.sha256')}\nsha256sum ${q(path+'/database.bak')} | cut -d ' ' -f1 > ${q(path+'/copy.sha256')}\ncmp ${q(path+'/native.sha256')} ${q(path+'/copy.sha256')}\ncd ${q(path)}\nsha256sum database.bak source.tar > SHA256SUMS\nprintf '%s\\n' BACKUP_VERIFIED`,
    reset:`set -eu\n${guard}\ncd ${q(path)}\nsha256sum -c SHA256SUMS\n${sql(`RESTORE VERIFYONLY FROM DISK=N'${native}' WITH CHECKSUM; ALTER DATABASE [${database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${database}]; CREATE DATABASE [${database}];`)}\nprintf '%s\\n' DATABASE_RESET`,
  };
}

export async function backupThenReset(io:{backup:()=>Promise<{exitCode:number;output:string}>;record:()=>Promise<void>;reset:()=>Promise<{exitCode:number;output:string}>}) {
  const backup=await io.backup();
  if(backup.exitCode!==0 || !/^BACKUP_VERIFIED$/m.test(backup.output)) throw new Error('Database backup verification failed; reset was not attempted');
  await io.record(); // recovery location must be persisted before destruction
  const reset=await io.reset();
  if(reset.exitCode!==0 || !/^DATABASE_RESET$/m.test(reset.output)) throw new Error('Database reset did not complete; the verified backup is retained. Stop and inspect recovery logs.');
}
