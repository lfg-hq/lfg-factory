import { shellQuote } from "./preview-plan.ts";
/** Only rewrites connections authenticated with our provisioned credentials.
 * External/user-owned connections are intentionally left untouched. */
export function branchDatabaseScript(dir: string, branch: string, engines: Array<{engine:string;password:string;username:string;port:number;dbName:string}>): string {
  const payload = Buffer.from(JSON.stringify({ branch, engines })).toString("base64");
  return `python3 - ${shellQuote(dir)} ${shellQuote(payload)} <<'PYEOF'
import os, sys, re, json, base64, hashlib, shlex, subprocess
from urllib.parse import urlsplit, urlunsplit, unquote
base = os.path.realpath(sys.argv[1])
config = json.loads(base64.b64decode(sys.argv[2]))
engines = config["engines"]
redis_port = None
connections = {}
names = {}
def parts(value):
    return {k.strip().lower(): v.strip() for k,v in re.findall(r"([^;=]+)=([^;]*)", value)}
def rewrite(value):
    global redis_port
    for e in engines:
        if e["engine"] == "redis":
            if not value.startswith("redis://"): continue
            u = urlsplit(value)
            if u.hostname not in ("127.0.0.1", "localhost") or unquote(u.password or "") != e["password"]: continue
            name = "redis-pv-" + hashlib.sha256(config["branch"].encode()).hexdigest()[:16]
            if redis_port is None:
                exists = subprocess.run(["docker", "inspect", name], capture_output=True)
                if exists.returncode:
                    command = ["docker", "run", "-d", "--name", name, "--restart", "unless-stopped", "-p", "127.0.0.1::6379", "-v", "/data/"+name+":/data", "redis:7-alpine", "redis-server", "--appendonly", "yes", "--requirepass", e["password"]]
                else: command = ["docker", "start", name]
                started = subprocess.run(command, capture_output=True)
                if started.returncode: raise SystemExit("Cannot provision branch Redis")
                address = subprocess.run(["docker", "port", name, "6379/tcp"], capture_output=True, text=True)
                try: redis_port = int(address.stdout.strip().rsplit(":", 1)[1])
                except (ValueError, IndexError): raise SystemExit("Cannot discover branch Redis port")
                import time
                for attempt in range(30):
                    ready = subprocess.run(["docker", "exec", "-e", "REDISCLI_AUTH="+e["password"], name, "redis-cli", "ping"], capture_output=True, text=True)
                    if ready.returncode == 0 and "PONG" in ready.stdout: break
                    time.sleep(1)
                else: raise SystemExit("Branch Redis did not become ready")
            auth = u.netloc.rsplit("@", 1)[0]
            return urlunsplit((u.scheme, auth + "@127.0.0.1:" + str(redis_port), u.path, u.query, u.fragment))
        url = None
        if "://" in value:
            try: url = urlsplit(value)
            except ValueError: continue
            host, password = url.hostname or "", unquote(url.password or "")
            old = url.path.strip("/") or e["dbName"]
            port = url.port or e["port"]
        else:
            p = parts(value)
            host = p.get("server", p.get("host", p.get("data source", "")))
            password = p.get("password", p.get("pwd", ""))
            old = p.get("database", p.get("initial catalog", ""))
            port = int(p.get("port", e["port"]))
            if "," in host:
                host, rawport = host.rsplit(",", 1)
                try: port = int(rawport)
                except ValueError: continue
        if host not in ("localhost", "127.0.0.1") or password != e["password"] or port != e["port"] or not old:
            continue
        # Already scoped connections must not grow a new DB on every replay.
        prefix = "pv_" + hashlib.sha256(config["branch"].encode()).hexdigest()[:12] + "_"
        new = old if old.startswith(prefix) else prefix + hashlib.sha256(old.encode()).hexdigest()[:12]
        names[(e["engine"], new)] = e
        connections[value] = new
        if url: return urlunsplit((url.scheme, url.netloc, "/" + new, url.query, url.fragment))
        return re.sub(r"(?i)((?:Database|Initial Catalog)\\s*=\\s*)[^;]*", lambda m: m[1]+new, value)
    return value
files = {}
envfile = os.path.join(base, ".env")
if os.path.isfile(envfile):
    output = []
    for line in open(envfile):
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line.rstrip("\\n"))
        if not m: output.append(line); continue
        try:
            tokens = shlex.split(m[2])
            value = tokens[0] if len(tokens) == 1 else m[2]
        except ValueError: raise SystemExit("Unable to parse environment assignment: " + m[1])
        new = rewrite(value)
        output.append(m[1] + "=" + shlex.quote(new) + "\\n" if new != value else line)
    files[envfile] = "".join(output)
for root, dirs, fs in os.walk(base):
    dirs[:] = [d for d in dirs if d not in (".git", "node_modules", "bin", "obj")]
    for f in fs:
        if not (f.startswith("appsettings") and f.endswith(".json")): continue
        path = os.path.join(root, f)
        content = open(path, encoding="utf-8-sig").read()
        def replace(m):
            try: value = json.loads(m[0])
            except ValueError: return m[0]
            new = rewrite(value)
            return json.dumps(new) if new != value else m[0]
        files[path] = re.sub(r'"(?:[^"\\\\]|\\\\.)*"', replace, content)
for (engine, name), e in names.items():
    # Database identifiers are generated hex, never user-provided SQL.
    if engine == "mssql":
        cmd = ["docker", "exec", "-e", "SQLCMDPASSWORD="+e["password"], "mssql", "sh", "-c", 'client=/opt/mssql-tools18/bin/sqlcmd; test -x "$client" || client=/opt/mssql-tools/bin/sqlcmd; exec "$client" -S localhost -U "$1" -C -b -Q "$2"', "sh", e["username"], "IF DB_ID('"+name+"') IS NULL CREATE DATABASE ["+name+"]"]
    elif engine == "mysql":
        cmd = ["docker", "exec", "-e", "MYSQL_PWD="+e["password"], "mysql", "mysql", "-uroot", "-e", "CREATE DATABASE IF NOT EXISTS "+name+"; GRANT ALL ON "+name+".* TO 'app'@'%'"]
    else:
        prefix = ["docker", "exec", "-e", "PGPASSWORD="+e["password"], "postgres"]
        check = subprocess.run(prefix+["psql", "-U", e["username"], "-d", "postgres", "-tAc", "SELECT 1 FROM pg_database WHERE datname='"+name+"'"], capture_output=True, text=True)
        if check.returncode: raise SystemExit("Cannot inspect branch database (postgres)")
        if check.stdout.strip() == "1": continue
        cmd = prefix + ["createdb", "-U", e["username"], name]
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode: raise SystemExit("Cannot provision branch database ("+engine+")")
# Write only after provisioning succeeds; never print connection values.
for path, content in files.items():
    with open(path, "w", encoding="utf-8") as f: f.write(content)
print(json.dumps([{"engine": engine, "database": name} for engine, name in names]))
PYEOF`;
}
