import { shellQuote } from "./preview-plan.ts";
import { ValidationFailure } from "./validation-contract.ts";
import type { AppProfile } from "./app-profile.ts";

export type ScopedEngine = { engine: string; container: string; host: string; port: number; database: string; username: string; password: string };
export type ValidationEnvironment = { scope: string; root: string; port: number; engines: ScopedEngine[]; vars: Record<string,string> };
export async function validationShell(workspaceId: string, script: string, timeout = 60_000) {
  const { execOnWorkspace } = await import("./mags.ts");
  const encoded = Buffer.from(script).toString("base64");
  const result = await execOnWorkspace(workspaceId, `echo ${encoded} | base64 -d | bash`, { timeout });
  return { exitCode: result.exitCode ?? -1, output: (result.output || "") + (result.stderr ? "\n" + result.stderr : "") };
}

/** No project lookup: provisioning always targets the caller's exact build workspace. */
export function environmentScript(root: string, scope: string, databases: AppProfile["databases"]): string {
  if (!/^val-[a-f0-9-]+$/.test(scope)) throw new Error("Invalid validation scope");
  const data = Buffer.from(JSON.stringify({ root, scope, databases })).toString("base64");
  return `python3 - ${shellQuote(data)} <<'PYEOF'
import base64,json,sys,subprocess,os,socket,secrets,time
c=json.loads(base64.b64decode(sys.argv[1])); engines=[]; variables={}
os.makedirs(c['root'],exist_ok=True)
def docker(*args,check=True):
    r=subprocess.run(['docker',*args],capture_output=True,text=True)
    if check and r.returncode: raise SystemExit('Validation Docker operation failed: '+args[0])
    return r
for kind in dict.fromkeys(d['engine'] for d in c['databases']):
    name=c['scope']+'-'+kind; pw='Lfg!'+secrets.token_hex(24); db='app'; user='app'
    image={'postgres':'postgres:16-alpine','mysql':'mysql:8.0','mssql':'mcr.microsoft.com/mssql/server:2022-latest','redis':'redis:7-alpine'}[kind]
    port={'postgres':5432,'mysql':3306,'mssql':1433,'redis':6379}[kind]
    flags=[]; command=[]
    if kind=='postgres': flags=['-e','POSTGRES_USER=app','-e','POSTGRES_PASSWORD='+pw,'-e','POSTGRES_DB=app']
    elif kind=='mysql': flags=['-e','MYSQL_USER=app','-e','MYSQL_PASSWORD='+pw,'-e','MYSQL_ROOT_PASSWORD='+pw,'-e','MYSQL_DATABASE=app']
    elif kind=='mssql': user='sa'; flags=['-e','ACCEPT_EULA=Y','-e','MSSQL_SA_PASSWORD='+pw,'-e','MSSQL_PID=Developer']
    else: user='default'; command=['redis-server','--requirepass',pw]
    docker('run','-d','--name',name,'--label','lfg.validation='+c['scope'],'-p','127.0.0.1::'+str(port),*flags,image,*command)
    exposed=docker('port',name,str(port)+'/tcp').stdout.strip().rsplit(':',1)[1]
    engine={'engine':kind,'container':name,'host':'127.0.0.1','port':int(exposed),'database':db,'username':user,'password':pw}
    engines.append(engine)
    # Persist allocation as it happens so cancellation/failure can clean exact resources.
    json.dump(engines,open(c['root']+'/engines.json','w'))
    for attempt in range(120):
        if kind=='postgres': r=docker('exec','-e','PGPASSWORD='+pw,name,'psql','-U',user,'-d',db,'-tAc','SELECT 1',check=False)
        elif kind=='mysql': r=docker('exec','-e','MYSQL_PWD='+pw,name,'mysql','-u'+user,db,'-Nse','SELECT 1',check=False)
        elif kind=='mssql': r=docker('exec','-e','SQLCMDPASSWORD='+pw,name,'sh','-c','c=/opt/mssql-tools18/bin/sqlcmd; test -x "$c" || c=/opt/mssql-tools/bin/sqlcmd; exec "$c" -S localhost -U sa -C -b -Q "IF DB_ID(\\'app\\') IS NULL CREATE DATABASE app; SELECT 1"',check=False)
        else: r=docker('exec','-e','REDISCLI_AUTH='+pw,name,'redis-cli','ping',check=False)
        if r.returncode==0: break
        time.sleep(2)
    else: raise SystemExit(kind+' readiness timed out')
    created={'app'}
    for spec in [s for s in c['databases'] if s['engine']==kind]:
        fmt=spec['connectionFormat']; p=str(exposed); db=spec.get('databaseName','app')
        if not db.replace('_','').isalnum() or not (db[0].isalpha() or db[0]=='_'): raise SystemExit('Invalid logical database name')
        if db not in created and kind!='redis':
            created.add(db)
            if kind=='postgres': docker('exec',name,'psql','-U',user,'-d','app','-v','ON_ERROR_STOP=1','-c','CREATE DATABASE "'+db+'"')
            elif kind=='mysql': docker('exec','-e','MYSQL_PWD='+pw,name,'mysql','-uroot','-e','CREATE DATABASE IF NOT EXISTS '+chr(96)+db+chr(96)+'; GRANT ALL ON '+chr(96)+db+chr(96)+'.* TO app;')
            else: docker('exec','-e','SQLCMDPASSWORD='+pw,name,'sh','-c','c=/opt/mssql-tools18/bin/sqlcmd; test -x "$c" || c=/opt/mssql-tools/bin/sqlcmd; exec "$c" -S localhost -U sa -C -b -Q "CREATE DATABASE ['+db+']"')
        if fmt=='dotnet-sqlserver': value='Server=127.0.0.1,'+p+';Database='+db+';User Id='+user+';Password='+pw+';TrustServerCertificate=True;MultipleActiveResultSets=True;'
        elif fmt=='dotnet-npgsql': value='Host=127.0.0.1;Port='+p+';Database='+db+';Username='+user+';Password='+pw+';'
        elif fmt=='dotnet-mysql': value='Server=127.0.0.1;Port='+p+';Database='+db+';Uid='+user+';Pwd='+pw+';'
        elif fmt=='keyvalue': value='127.0.0.1:'+p+',password='+pw if kind=='redis' else 'Host=127.0.0.1;Port='+p+';Database='+db+';Username='+user+';Password='+pw+';'
        else: value={'postgres':'postgresql','mysql':'mysql','redis':'redis','mssql':'sqlserver'}[kind]+'://'+user+':'+pw+'@127.0.0.1:'+p+('/'+db if kind!='redis' else '/0')
        variables[spec['connectionEnvVar']]=value
sock=socket.socket();sock.bind(('127.0.0.1',0));app_port=sock.getsockname()[1];sock.close()
result={'scope':c['scope'],'root':c['root'],'port':app_port,'engines':engines,'vars':variables}
json.dump(result,open(c['root']+'/environment.json','w'))
print('Environment ready')
PYEOF`;
}

/** A detached command with an explicit process group; cancellation/deadline kill only it. */
export async function runValidationCommand(o: {
  workspaceId: string; cwd: string; command: string; root: string; timeoutMs?: number;
  cancelled?: () => boolean; log?: (message:string) => void; vars?: Record<string,string>;
}) {
  const id = crypto.randomUUID(); const base = `${o.root}/cmd-${id}`;
  const env = Object.entries(o.vars ?? {}).map(([k,v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? `export ${k}=${shellQuote(v)}` : "").join("\n");
  const script = `set -e\ncd ${shellQuote(o.cwd)}\n${env}\n${o.command}\n`;
  const body = Buffer.from(script).toString("base64");
  const launch = await validationShell(o.workspaceId, `mkdir -p ${shellQuote(o.root)}; echo ${body} | base64 -d > ${shellQuote(base+'.sh')}; setsid bash -c ${shellQuote(`timeout -k 10 ${Math.ceil((o.timeoutMs ?? 1_800_000)/1000)} bash ${shellQuote(base+'.sh')} > ${shellQuote(base+'.log')} 2>&1; echo $? > ${shellQuote(base+'.exit')}`)} </dev/null >/dev/null 2>&1 & echo $! > ${shellQuote(base+'.pid')}; echo STARTED`);
  if (launch.exitCode !== 0 || !launch.output.includes("STARTED")) throw new ValidationFailure("Could not launch validation command");
  const stop = () => validationShell(o.workspaceId, `p=$(cat ${shellQuote(base+'.pid')}); case "$p" in ''|*[!0-9]*) exit 1;; esac; kill -TERM -- -"$p" 2>/dev/null || true; sleep 1; kill -KILL -- -"$p" 2>/dev/null || true`).catch(()=>{});
  const deadline=Date.now()+(o.timeoutMs ?? 1_800_000); let heartbeat=0;
  try {
    while (Date.now()<deadline) {
      if (o.cancelled?.()) throw new Error("__CANCELLED__");
      const state=await validationShell(o.workspaceId, `test -f ${shellQuote(base+'.exit')} && { echo DONE; cat ${shellQuote(base+'.exit')}; } || echo RUNNING`,15_000);
      if(state.output.startsWith('DONE')) {
        const output=await validationShell(o.workspaceId, `head -c 12000 ${shellQuote(base+'.log')}; tail -c 6000 ${shellQuote(base+'.log')}`,15_000);
        return {exitCode:Number(state.output.split('\n')[1]),output:output.output};
      }
      if(Date.now()-heartbeat>15_000) { heartbeat=Date.now();o.log?.("Validation command is running…"); }
      await new Promise(r=>setTimeout(r,1500));
    }
    throw new ValidationFailure("Validation command timed out; its process group was stopped");
  } finally { await stop(); }
}
export function cleanupEnvironmentScript(scope: string, root: string) {
  if (!/^val-[a-f0-9-]+$/.test(scope) || root !== `/data/validation/${scope}`) throw new Error("Invalid validation cleanup scope");
  return `for c in $(docker ps -aq --filter ${shellQuote('label=lfg.validation='+scope)}); do docker rm -fv "$c" >/dev/null 2>&1 || true; done; rm -rf ${shellQuote(root)}`;
}
