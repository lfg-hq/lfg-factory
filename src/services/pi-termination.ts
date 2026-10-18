/** Terminate only this launcher and descendants; never match processes by name. */
export function piTerminationScript(pid:string):string {
 if(!/^[1-9][0-9]*$/.test(pid) || Number(pid)<=1)throw new Error('Invalid Pi launcher PID');
 return `python3 - ${pid} <<'PY'
import os,sys,time,signal
root=int(sys.argv[1]); records={}
for name in os.listdir('/proc'):
 if not name.isdigit(): continue
 try:
  fields=open('/proc/'+name+'/stat').read().rsplit(')',1)[1].split()
  records[int(name)]=(int(fields[1]),fields[19],int(fields[2]))
 except (OSError,ValueError,IndexError): pass
selected={pid for pid,(_,_,group) in records.items() if pid==root or group==root}
while True:
 more={pid for pid,(parent,_,_) in records.items() if parent in selected}
 if more <= selected: break
 selected |= more
def same(pid):
 try: return open('/proc/'+str(pid)+'/stat').read().rsplit(')',1)[1].split()[19]==records[pid][1]
 except (OSError,IndexError): return False
for sig in (signal.SIGTERM,signal.SIGKILL):
 for pid in sorted(selected,reverse=True):
  if same(pid):
   try: os.kill(pid,sig)
   except ProcessLookupError: pass
 time.sleep(1)
for pid in selected:
 if same(pid):
  try:
   if open('/proc/'+str(pid)+'/stat').read().rsplit(')',1)[1].split()[0]!='Z': raise SystemExit('Pi process still alive after termination')
  except FileNotFoundError: pass
print('Stopped Pi launcher and its recorded descendants')
PY`;
}
export function missingPiExitReason(timedOut:boolean, kernelLog:string):string {
 if(timedOut)return 'Pi repair exceeded its time limit; its launcher and child processes were stopped before retry.';
 return 'Pi ended without an exit record; the cause is unconfirmed.'+(kernelLog ? ' Kernel OOM history exists, but does not establish that this Pi process was killed.' : '');
}
