import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../config/db.ts';
import { sandboxes } from '../db/schema/sandbox.ts';
import { projectTickets } from '../db/schema/tickets.ts';
import { projects } from '../db/schema/projects.ts';
import { execOnWorkspace, findJob, newWorkspaceV2, setNoSleep } from './mags.ts';
import { createTicketSandbox } from './ticket-sandbox-clone.ts';
import { resolveRepoAuth } from './repo-auth.ts';
import { resolveGitActor } from './git-access.ts';
import { shellQuote } from './ticket-code.ts';
import { checkpointTicketWorkspace, readTicketCheckpoint, restoreTicketCheckpoint } from './ticket-workspace-checkpoint.ts';
import { isChatTurnActive } from './ticket-chat-turn.ts';
export type TicketWorkspace = {workspaceId:string;root:string;branch:string};
export const ticketWorkspaceRoot = (sb:{workspaceType:string;ticketId:string|null}) => sb.workspaceType === 'ticket-worktree' ? `/data/wt-ticket-${sb.ticketId!.slice(0,12)}` : '/data/project';
export async function latestTicketWorkspace(projectId:string, ticketId:string) {
  return (await db.select().from(sandboxes).where(and(eq(sandboxes.projectId,projectId),eq(sandboxes.ticketId,ticketId),inArray(sandboxes.workspaceType,['ticket','ticket-chat','ticket-worktree']))).orderBy(desc(sandboxes.updatedAt)).limit(1))[0];
}
/** A database uniqueness constraint serializes recovery and browser writes across processes. */
export async function withTicketWorkspaceLock<T>(ticketId:string, operation:()=>Promise<T>):Promise<T> {
  const id = 'ticket-workspace-lock-' + ticketId;
  const [lock] = await db.insert(sandboxes).values({id,ticketId,workspaceType:'ticket-code-lock',status:'busy'}).onConflictDoNothing().returning();
  if (!lock) throw new Error('This ticket workspace is busy. Retry shortly. If an interrupted server left it locked, an administrator must reconcile the saved recovery before clearing the lock.');
  try { return await operation(); }
  finally { await db.delete(sandboxes).where(eq(sandboxes.id,id)); }
}
async function checkedExec(workspace:string, command:string) {
  const r = await execOnWorkspace(workspace,command,{timeout:120_000});
  // Never return clone output: it may contain credentials.
  if (r.exitCode !== 0) throw new Error('Could not restore the ticket repository. Check repository access and that the saved ticket branch or commit is available.');
  return r.output.trim();
}
export async function openTicketWorkspace(options:{project:typeof projects.$inferSelect;ticket:typeof projectTickets.$inferSelect;actorId:string;canRestore:boolean;continuation?:boolean;progress?:(message:string)=>void}):Promise<TicketWorkspace> {
  return withTicketWorkspaceLock(options.ticket.id, async()=>{
    const {project,ticket,actorId,progress=()=>{}} = options;
    const branch = ticket.githubBranch;
    if (!branch) throw new Error('This ticket has no code branch yet. Build it first.');
    const [freshTicket] = await db.select().from(projectTickets).where(eq(projectTickets.id,ticket.id));
    const active = freshTicket?.queueStatus === 'executing' || isChatTurnActive(ticket.id);
    if (active && !options.continuation) throw new Error('An agent is working on this ticket. Open Coding after it finishes.');
    const existing = await latestTicketWorkspace(project.id,ticket.id);
    if (existing?.magsWorkspaceId) {
      const workspaceId = existing.magsWorkspaceId, root = ticketWorkspaceRoot(existing);
      progress('Checking ticket workspace…');
      // Probe first: provider job listings may omit older live workspaces.
      const probe = async()=>execOnWorkspace(workspaceId,`git -C ${shellQuote(root)} symbolic-ref --short HEAD`,{timeout:20_000});
      let probeError: unknown;
      let result = await probe().catch(error=>{probeError=error;return null;});
      if (result?.exitCode === 0 && result.output.trim() !== branch) throw new Error('The existing checkout is on another branch. It has been preserved; switch it back before opening Coding.');
      if (result?.exitCode === 0 && result.output.trim() === branch) return {workspaceId,root,branch};
      const job = await findJob(workspaceId); // Transport/auth failures must not allocate a replacement.
      if (job && ['running','sleeping','pending','starting'].includes(job.status)) {
        progress('Waking ticket workspace…');
        await setNoSleep(job.jobId,true);
        for (let attempt=0;attempt<3;attempt++) {
          result = await probe().catch(()=>null);
          if (result?.exitCode === 0 && result.output.trim() === branch) { if (existing.workspaceType !== 'ticket-worktree') await setNoSleep(job.jobId,false); return {workspaceId,root,branch}; }
          await new Promise(resolve=>setTimeout(resolve,2000));
        }
        // A sandbox that never answers (long-awake VMs stop responding to commands) used to
        // fail every follow-up. Set it aside, untouched, and continue from the saved
        // checkpoint or the pushed branch in a fresh sandbox below.
        if (!options.canRestore || existing.workspaceType === 'ticket-worktree') throw new Error('The existing sandbox could not open the ticket checkout. It has been preserved; retry after it finishes waking.');
        progress('The previous sandbox is not responding. Continuing in a fresh sandbox from the saved work; the old one is kept as it was.');
        await db.update(sandboxes).set({workspaceType:'ticket-unresponsive',status:'unresponsive',updatedAt:new Date()}).where(eq(sandboxes.id,existing.id));
      } else {
        if (!job && !/HTTP 404.*(?:job not found|not found)/i.test(probeError instanceof Error ? probeError.message : '')) throw new Error('Sandbox availability is uncertain. Retry shortly; no replacement was created.');
        if (job && !['completed','stopped','error','failed','deleted'].includes(job.status)) throw new Error('Sandbox availability is uncertain. Retry shortly; no replacement was created.');
      }
    }
    if (!options.canRestore) throw new Error('The ticket workspace has expired. A project editor must open Coding to restore it.');
    const {gitUserId} = resolveGitActor(project,actorId);
    const auth = await resolveRepoAuth(project,gitUserId);
    if (!auth) throw new Error('Connect your repository access in Settings, or ask the project owner to share Git access, to restore this ticket.');
    const checkpoint = await readTicketCheckpoint(ticket.id);
    if (checkpoint && checkpoint.branch !== branch) throw new Error('Saved checkpoint branch does not match this ticket. Recovery stopped.');
    progress('Starting workspace from the prepared project environment…');
    const created = await createTicketSandbox({projectId:project.id,ticketId:ticket.id,userId:actorId,allowPreparedPreviewWithAppError:true,log:async message=>progress(message),fresh:()=>newWorkspaceV2(`code-${ticket.id.slice(0,8)}-${crypto.randomUUID().slice(0,8)}`,{vcpus:4,memoryMb:4096,diskGb:20,keepAlive:true,rootfsType:process.env.PREVIEW_ROOTFS || 'pi'})});
    progress('Restoring ticket code and saved edits…');
    // The clone is a new VM. Do not modify the source preview or an old ticket VM.
    const temp = '/data/lfg-code-' + crypto.randomUUID();
    if (checkpoint) {
      await restoreTicketCheckpoint(ticket.id,created.workspaceId,temp,branch);
      await checkedExec(created.workspaceId,`git -C ${shellQuote(temp)} remote add origin ${shellQuote(auth.authUrl)}`);
    } else {
      const ref = 'refs/remotes/origin/' + branch;
      const sha = ticket.githubCommitSha;
      if (sha && !/^[a-f0-9]{40,64}$/i.test(sha)) throw new Error('Invalid saved ticket commit');
      await checkedExec(created.workspaceId,`set -eu\ngit clone --no-checkout -- ${shellQuote(auth.authUrl)} ${shellQuote(temp)}\ngit -C ${shellQuote(temp)} check-ref-format --branch ${shellQuote(branch)} >/dev/null\ngit -C ${shellQuote(temp)} checkout -B ${shellQuote(branch)} ${shellQuote(sha || ref)}\n`);
    }
    // Keep ignored runtime configuration and dependencies inherited from the prepared clone.
    // Swap only after recovery has succeeded, retaining inherited files in a sibling directory.
    const inherited = '/data/lfg-inherited-' + crypto.randomUUID();
    await checkedExec(created.workspaceId,`set -eu\nif [ -e /data/project ]; then mv /data/project ${shellQuote(inherited)}; fi\nmv ${shellQuote(temp)} /data/project\ngit -C /data/project config user.name 'LFG user'\ngit -C /data/project config user.email 'ai@lfg.dev'\ntest "$(git -C /data/project symbolic-ref --short HEAD)" = ${shellQuote(branch)}`);
    const copyIgnored = `import os,pathlib,subprocess,shutil
source=pathlib.Path(${JSON.stringify(inherited)})
target=pathlib.Path('/data/project')
if (source/'.git').exists():
 r=subprocess.run(['git','-C',str(source),'ls-files','-z','--others','--ignored','--exclude-standard'],capture_output=True,check=True)
 for name in r.stdout.decode().split('\\0'):
  if not name: continue
  rel=pathlib.PurePosixPath(name)
  if rel.is_absolute() or '..' in rel.parts or '.git' in rel.parts: raise ValueError('Invalid inherited path')
  src=source/name; dst=target/name
  if dst.exists() or dst.is_symlink() or any(p.is_symlink() for p in dst.parents): continue
  if not src.is_file() or src.is_symlink(): continue
  dst.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(src,dst)
`;
    await checkedExec(created.workspaceId, `python3 -c ${shellQuote(copyIgnored)}`);
    // Preserve the checkpoint before publishing the replacement registration.
    await checkpointTicketWorkspace(ticket.id,created.workspaceId,'/data/project',branch);
    const registration = {projectId:project.id,ticketId:ticket.id,userId:actorId,magsWorkspaceId:created.workspaceId,magsJobId:created.jobId,workspaceType:'ticket',status:'ready',currentBranch:branch,updatedAt:new Date()};
    if (created.cloneIntentId) await db.update(sandboxes).set(registration).where(eq(sandboxes.id,created.cloneIntentId));
    else await db.insert(sandboxes).values(registration);
    await setNoSleep(created.jobId,false);
    progress('Ticket workspace ready');
    return {workspaceId:created.workspaceId,root:'/data/project',branch};
  });
}
/** Called before build/chat VMs are allowed to idle-sleep. Failure keeps them pinned. */
export async function preserveTicketWorkspaceBeforeSleep(workspaceId:string) {
  const rows = await db.select().from(sandboxes).where(and(eq(sandboxes.magsWorkspaceId,workspaceId),inArray(sandboxes.workspaceType,['ticket','ticket-chat'])));
  for (const row of rows) if (row.ticketId) {
    const [ticket] = await db.select().from(projectTickets).where(eq(projectTickets.id,row.ticketId));
    await withTicketWorkspaceLock(row.ticketId,()=>checkpointTicketWorkspace(row.ticketId!,workspaceId,ticketWorkspaceRoot(row),ticket?.githubBranch || undefined));
  }
}
