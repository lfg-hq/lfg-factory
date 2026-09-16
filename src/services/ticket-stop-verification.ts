/** Read-only confirmation in a dedicated ticket VM. Never use on shared preview VMs. */
export function ticketStopVerificationScript() {
  return `python3 - <<'PY'
import os, pathlib
me=os.getpid()
ancestors={me}
p=me
while p > 1:
 try:
  p=int(pathlib.Path('/proc/%s/stat'%p).read_text().rsplit(')',1)[1].split()[1]); ancestors.add(p)
 except (OSError,ValueError,IndexError): break
busy=[]
for entry in pathlib.Path('/proc').iterdir():
 if not entry.name.isdigit() or int(entry.name) in ancestors: continue
 try:
  stat=(entry/'stat').read_text().rsplit(')',1)[1].split()
  if stat[0]=='Z': continue
  cwd=os.readlink(entry/'cwd')
  cmd=(entry/'cmdline').read_bytes().replace(b'\\0',b' ').decode(errors='replace')
  if any(cwd==d or cwd.startswith(d+'/') for d in ['/data/project','/data/validation','/data/lfg-jobs']) or any(x in cmd for x in ['pi-coding-agent','pi -p','mode json','claude']): busy.append(entry.name)
 except FileNotFoundError: continue
 except (OSError,ValueError,IndexError): raise SystemExit('STOP_UNCONFIRMED: cannot inspect process '+entry.name)
if busy: raise SystemExit('STOP_UNCONFIRMED: ticket processes remain: '+','.join(busy))
print('TICKET_PROCESSES_STOPPED')
PY`;
}

export async function confirmTicketStopped(rows:Array<{ws:string|null;type:string}>, inspect:(workspace:string)=>Promise<{exitCode?:number;output?:string}>) {
  if(rows.some(r=>!r.ws || r.ws.startsWith("pv-") || !["ticket","ticket-chat"].includes(r.type)))throw new Error("Stop is not confirmed: this ticket needs scoped sandbox inspection.");
  for(const row of rows) {
    const result=await inspect(row.ws!);
    if(result.exitCode!==0 || result.output?.trim()!=="TICKET_PROCESSES_STOPPED")throw new Error("Stop is not confirmed: ticket processes remain or the sandbox could not be inspected. Retry Stop after the sandbox is reachable.");
  }
}
