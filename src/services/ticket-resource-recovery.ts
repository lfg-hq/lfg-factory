import {shellQuote} from './preview-plan.ts';
/** Inspect current resources; only orphaned compiler servers in this checkout are automatic cleanup. */
export function ticketResourceRecoveryScript(projectDir:string):string {
 return `timeout 20 python3 - ${shellQuote(projectDir)} <<'PY'
import os,sys,signal,json,shutil
root=os.path.realpath(sys.argv[1]); processes=[]
for name in os.listdir('/proc'):
 if not name.isdigit(): continue
 try:
  base='/proc/'+name
  fields=open(base+'/stat').read().rsplit(')',1)[1].split()
  cwd=os.path.realpath(os.readlink(base+'/cwd'))
  args=open(base+'/cmdline','rb').read().decode(errors='replace').split(chr(0))
  compiler=any('VBCSCompiler.dll' in arg or ('MSBuild.dll' in arg and any('/nodemode:' in a.lower() for a in args)) for arg in args)
  scoped=cwd==root or cwd.startswith(root+'/')
  if int(fields[1])==1 and scoped and compiler:
   os.kill(int(name),signal.SIGTERM)
   print('Stopped orphan compiler PID '+name)
  processes.append({'pid':int(name),'name':open(base+'/comm').read().strip(),'rss_kb':int(fields[21])*os.sysconf('SC_PAGE_SIZE')//1024,'in_checkout':scoped})
 except (OSError,ValueError,IndexError): pass
print('Disk bytes: '+str(shutil.disk_usage(root)))
st=os.statvfs(root);print('Free inodes: '+str(st.f_favail))
print(open('/proc/meminfo').read().split('SwapCached:')[0])
print(json.dumps(sorted(processes,key=lambda p:p['rss_kb'],reverse=True)[:12]))
PY
timeout 10 docker ps --format '{{.ID}} {{.Names}} {{.Image}} {{.Status}}' 2>/dev/null || true`;
}
