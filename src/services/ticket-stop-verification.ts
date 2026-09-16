/** Read-only process inspection; shared VMs are restricted to the ticket worktree. */
export function ticketStopVerificationScript(worktreeDir?:string) {
  if(worktreeDir && !/^\/data\/wt-ticket-[A-Za-z0-9-]+$/.test(worktreeDir))throw new Error("Invalid ticket worktree path");
  return `python3 - <<'PY'
import os, pathlib
scope=${JSON.stringify(worktreeDir ?? "")}
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
  dirs=[scope] if scope else ['/data/project','/data/validation','/data/lfg-jobs']
  if any(cwd==d or cwd.startswith(d+'/') for d in dirs) or (not scope and any(x in cmd for x in ['pi-coding-agent','pi -p','mode json','claude'])): busy.append(entry.name)
 except FileNotFoundError: continue
 except (OSError,ValueError,IndexError): raise SystemExit('STOP_UNCONFIRMED: cannot inspect process '+entry.name)
if busy: raise SystemExit('STOP_UNCONFIRMED: ticket processes remain: '+','.join(busy))
print('TICKET_PROCESSES_STOPPED')
PY`;
}

export async function confirmTicketStopped(rows:Array<{ws:string|null;type:string}>, inspect:(workspace:string,shared:boolean)=>Promise<{exitCode?:number;output?:string}>) {
  for(const row of rows) {
    if(!row.ws)throw new Error(`Stop is not confirmed: ${row.type} sandbox has no workspace ID; repair its sandbox record.`);
    if(!["ticket","ticket-chat","ticket-worktree"].includes(row.type))throw new Error(`Stop is not confirmed: unsupported sandbox type ${row.type} for workspace ${row.ws}.`);
    const result=await inspect(row.ws,row.ws.startsWith("pv-") || row.type==="ticket-worktree");
    if(result.exitCode!==0 || result.output?.trim()!=="TICKET_PROCESSES_STOPPED")throw new Error(`Stop is not confirmed in ${row.ws}: ${result.output?.trim().slice(0,500) || "sandbox inspection failed"}`);
  }
}
