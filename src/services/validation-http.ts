import { shellQuote } from './preview-plan.ts';
/** Five bounded probes; retain transport, process, listener and application evidence. */
export function validationHttpCommand(url:string,root:string):string {
 return `python3 - ${shellQuote(url)} ${shellQuote(root)} <<'LFG_HTTP'
import sys,subprocess,time,pathlib,re,os
url,root=sys.argv[1:]; root=pathlib.Path(root)
body=root/'http-body.txt'; headers=root/'http-headers.txt'; attempts=[]
for attempt in range(1,6):
    body.unlink(missing_ok=True);headers.unlink(missing_ok=True)
    r=subprocess.run(['curl','--silent','--show-error','--max-time','3','--max-filesize','65536','--output',str(body),'--dump-header',str(headers),'--write-out','%{http_code}',url],capture_output=True,text=True)
    status=r.stdout.strip()
    if re.fullmatch('[23][0-9]{2}',status):
        print('HTTP check passed: '+url+' status='+status+' attempt='+str(attempt)+'/5');sys.exit(0)
    attempts.append('Attempt '+str(attempt)+'/5: HTTP '+(status or '000')+', curl exit '+str(r.returncode)+': '+r.stderr.strip())
    if attempt<5: time.sleep(2)
lines=['HTTP validation failed: GET '+url+' after 5 attempts.',*attempts]
def tail(path,n):
    try:
        with path.open('rb') as f: f.seek(0,2);f.seek(max(0,f.tell()-n));return f.read(n).decode('utf8','replace')
    except OSError:return '(unavailable)'
try:
    pid=int((root/'app.pid').read_text().strip());os.kill(pid,0);lines.append('App process '+str(pid)+': running')
except (OSError,ValueError):lines.append('App process: exited or PID unavailable')
for cmd in [['ss','-ltn'],['netstat','-ltn']]:
    try:
        r=subprocess.run(cmd,capture_output=True,text=True,timeout=3)
        if r.returncode==0:lines.append('Listening sockets:\\n'+r.stdout[-3000:]);break
    except (OSError,subprocess.TimeoutExpired):pass
logs=tail(root/'app.log',16000).splitlines()
selected=[l for l in logs if re.search(r'exception|error|fail|fatal|listening on|started|shutting down|address already|connection refused',l,re.I)]
lines.append('Relevant app output:\\n'+'\\n'.join(dict.fromkeys(selected or logs[-20:]))[-7000:])
lines.append('HTTP headers:\\n'+tail(headers,1500))
lines.append('Response excerpt:\\n'+tail(body,2000))
report='\\n'.join(lines)
(root/'http-diagnostic.txt').write_text(report)
print(report)
sys.exit(1)
LFG_HTTP`;
}
