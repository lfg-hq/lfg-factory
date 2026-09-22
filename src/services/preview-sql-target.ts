import { shellQuote } from './preview-plan.ts';

/** Resolve the selected connection at execution time, after branch isolation. */
export function targetedSqlCommand(file:string, connectionKey:string, engine:string, container=engine, port=0):string {
  const data=Buffer.from(JSON.stringify({file,connectionKey,engine,container,port})).toString('base64');
  return `python3 - ${shellQuote(data)} <<'PY'
import base64,json,os,re,subprocess,sys
from urllib.parse import urlsplit,unquote
p=json.loads(base64.b64decode(sys.argv[1]))
value=os.environ.get(p['connectionKey'],'')
if not value: raise SystemExit('SQL target connection is missing: '+p['connectionKey'])
if '://' in value:
    u=urlsplit(value); actual_port=u.port or {'postgres':5432,'mysql':3306,'mssql':1433}.get(p['engine'],0); host=u.hostname; database=unquote(u.path.lstrip('/')); user=unquote(u.username or ''); password=unquote(u.password or '')
else:
    fields=dict((k.strip().lower(),v.strip()) for k,v in (part.split('=',1) for part in value.split(';') if '=' in part))
    rawhost=fields.get('server',fields.get('data source',fields.get('host','')))
    host=rawhost.split(',')[0]; actual_port=int(rawhost.split(',')[1] if ',' in rawhost else fields.get('port',{'postgres':5432,'mysql':3306,'mssql':1433}.get(p['engine'],0)))
    database=fields.get('database',fields.get('initial catalog','')); user=fields.get('user id',fields.get('username',fields.get('user',''))); password=fields.get('password',fields.get('pwd',''))
if actual_port != p['port'] or host not in ('localhost','127.0.0.1') or not database or not user or not password:
    raise SystemExit('SQL target must be a provisioned local connection with database and credentials; use an explicit command for external connections')
if database.lower() in ('master','model','msdb','tempdb','postgres','mysql','information_schema'):
    raise SystemExit('SQL target must be an application database')
text=open(p['file'],encoding='utf-8-sig').read()
# A script must not silently switch away from its selected database.
if re.search(r'(?im)^\\s*(USE\\s|RESTORE\\s+DATABASE\\b|:connect\\b)',text):
    raise SystemExit('SQL script changes database context; save a sandbox repair removing the context switch or an explicit migration command')
engine=p['engine']; container=p['container']
if engine=='mssql':
    cmd=['docker','exec','-i','-e','SQLCMDPASSWORD='+password,container,'sh','-c','c=/opt/mssql-tools18/bin/sqlcmd; test -x "$c" || c=/opt/mssql-tools/bin/sqlcmd; exec "$c" -S localhost -U "$1" -C -b -d "$2"','sh',user,database]
elif engine=='postgres':
    cmd=['docker','exec','-i','-e','PGPASSWORD='+password,container,'psql','-v','ON_ERROR_STOP=1','-U',user,'-d',database]
elif engine=='mysql':
    cmd=['docker','exec','-i','-e','MYSQL_PWD='+password,container,'mysql','-u',user,database]
else: raise SystemExit('Unsupported SQL target engine')
print('Applying SQL to connection '+p['connectionKey'],flush=True)
sys.exit(subprocess.run(cmd,input=text.encode()).returncode)
PY`;
}
