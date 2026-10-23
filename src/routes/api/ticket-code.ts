import { Hono } from 'hono';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { requireAuth } from '../../auth/middleware.ts';
import { getProjectAccess } from '../../auth/project-access.ts';
import { db } from '../../config/db.ts';
import { projectTickets } from '../../db/schema/tickets.ts';
import { sandboxes } from '../../db/schema/sandbox.ts';
import { isChatTurnActive } from '../../services/ticket-chat-turn.ts';
import { ticketCodeCommand, shellQuote } from '../../services/ticket-code.ts';
import { execOnWorkspace, setNoSleep } from '../../services/mags.ts';
import { openTicketWorkspace, withTicketWorkspaceLock } from '../../services/ticket-workspace.ts';
import { checkpointTicketWorkspace } from '../../services/ticket-workspace-checkpoint.ts';
import type { auth } from '../../auth/index.ts';
const opening = new Map<string, {message:string; result?:Awaited<ReturnType<typeof openTicketWorkspace>>; error?:string}>();
const api = new Hono<{ Variables: { user: typeof auth.$Infer.Session.user } }>();
api.use('*', requireAuth as any);
api.all('/:projectId/tickets/:ticketId/code/:action', async c => {
  const { projectId, ticketId, action } = c.req.param();
  const access = await getProjectAccess(projectId, c.get('user').id);
  if (!access) return c.json({ error: 'Project not found' }, 404);
  const [ticket] = await db.select().from(projectTickets).where(and(eq(projectTickets.id, ticketId), eq(projectTickets.projectId, access.project.id)));
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404);
  const mutate = ['save', 'commit', 'exec'].includes(action);
  if (!['tree', 'file', 'save', 'commit', 'exec'].includes(action)) return c.json({ error: 'Not found' }, 404);
  if (c.req.method !== (mutate ? 'POST' : 'GET')) return c.json({ error: 'Method not allowed' }, 405);
  if (mutate) {
    const origin = c.req.header('Origin');
    if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: 'Invalid origin' }, 403);
    if (!access.permissions.canEditFiles) return c.json({ error: 'You do not have permission to edit this project' }, 403);
    if (ticket.queueStatus === 'executing' || isChatTurnActive(ticketId)) return c.json({ error: 'An agent is working on this ticket. Wait for it to finish before editing or running commands.' }, 409);
  }
  let workspaceId: string, root: string, branch: string;
  if (action === 'tree') {
    const key = `${ticketId}:${c.get('user').id}`;
    let state = opening.get(key);
    if (!state) {
      state = {message:'Checking ticket workspace…'};
      opening.set(key,state);
      const current = state;
      void openTicketWorkspace({project:access.project,ticket,actorId:c.get('user').id,canRestore:access.permissions.canEditFiles,
        progress:message=>{current.message=message;}}).then(result=>{current.result=result;}).catch(error=>{
          console.error('[ticket-code] workspace recovery failed', {ticketId, error: error instanceof Error ? error.message : 'Unknown failure'});
          current.error='The ticket workspace could not be opened. ' + (error instanceof Error ? error.message.replace(/https?:\/\/[^\s]+/g,'[repository]').replace(/Bearer\s+[^\s]+/gi,'[credential]').slice(0,700) : 'Retry shortly.');
        }).finally(()=>{const expiry=setTimeout(()=>{if(opening.get(key)===current) opening.delete(key);},300_000); expiry.unref?.();});
    }
    if (!state.result && !state.error) return c.json({preparing:true,message:state.message},202);
    opening.delete(key);
    if (state.error) return c.json({error:state.error},409);
    ({workspaceId,root,branch}=state.result!);
  } else {
    const [sb] = await db.select().from(sandboxes).where(and(eq(sandboxes.ticketId,ticketId),eq(sandboxes.projectId,access.project.id),inArray(sandboxes.workspaceType,['ticket','ticket-worktree','ticket-chat']))).orderBy(desc(sandboxes.updatedAt)).limit(1);
    if (!sb?.magsWorkspaceId) return c.json({error:'Open or refresh Coding to restore the ticket workspace.'},409);
    workspaceId=sb.magsWorkspaceId;
    root=sb.workspaceType==='ticket-worktree' ? `/data/wt-ticket-${ticketId.slice(0,12)}` : '/data/project';
    branch=ticket.githubBranch || sb.currentBranch || '';
    if (!branch) return c.json({error:'This ticket has no code branch yet. Build it first.'},409);
  }
  try {
    if (Number(c.req.header('content-length') || 0) > 1500000) return c.json({ error: 'Request too large' }, 413);
    const raw = mutate ? await c.req.text() : '';
    if (raw.length > 1500000) return c.json({ error: 'Request too large' }, 413);
    const body = mutate ? JSON.parse(raw) : {};
    const operation = async () => {
    if (action === 'exec') {
      if (typeof body.command !== 'string' || !body.command.trim() || body.command.length > 4000) return c.json({ error: 'Enter a command of up to 4,000 characters' }, 400);
      const script = `cd ${shellQuote(root)} || exit 1\n[ "$(git symbolic-ref --short HEAD)" = ${shellQuote(branch)} ] || { echo 'Ticket checkout branch changed'; exit 1; }\n${body.command}`;
      const result = await execOnWorkspace(workspaceId, `printf %s ${shellQuote(Buffer.from(script).toString('base64'))} | base64 -d | timeout 60 sh`, { timeout: 65_000 });
      return c.json({ output: result.output.slice(-60000), exitCode: result.exitCode, truncated: result.output.length > 60000 });
    }
    if (mutate && (typeof body.path !== 'string' || typeof body.version !== 'string')) return c.json({ error: 'Path and file version are required' }, 400);
    if (action === 'save' && typeof body.content !== 'string') return c.json({ error: 'File content is required' }, 400);
    if (action === 'commit' && (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 2000)) return c.json({ error: 'Enter a commit message (up to 2,000 characters)' }, 400);
    const result = await ticketCodeCommand(workspaceId, { action, root, branch, base: c.req.query('base') || 'main', path: mutate ? body.path : c.req.query('path'), content: body.content, version: body.version, message: body.message, author: c.get('user').name || 'LFG user', email: c.get('user').email });
    if (result.error) return c.json(result, 409);
    if (action === 'tree') Object.assign(result, { canEdit: access.permissions.canEditFiles && ticket.queueStatus !== 'executing' && !isChatTurnActive(ticketId), root });
    if (action === 'commit') await db.update(projectTickets).set({ githubCommitSha: result.sha, updatedAt: new Date() }).where(eq(projectTickets.id, ticketId));
    return c.json(result);
    };
    if (!mutate) return await operation();
    return await withTicketWorkspaceLock(ticketId, async()=>{
      const [latest] = await db.select().from(projectTickets).where(eq(projectTickets.id,ticketId));
      if (latest?.queueStatus === 'executing' || isChatTurnActive(ticketId)) return c.json({error:'An agent is working on this ticket. Wait for it to finish.'},409);
      const dedicated = !root.startsWith('/data/wt-ticket-');
      if (dedicated) await setNoSleep(workspaceId,true);
      let response;
      try { response = await operation(); }
      finally {
        // Even a failed terminal command can have changed files. Never release the VM without a verified checkpoint.
        await checkpointTicketWorkspace(ticketId,workspaceId,root,branch);
        if (dedicated) await setNoSleep(workspaceId,false);
        // Editing counts as use: the idle-sandbox sweeper waits a full grace period after the last edit.
        await db.update(sandboxes).set({updatedAt:new Date()}).where(and(eq(sandboxes.ticketId,ticketId),eq(sandboxes.magsWorkspaceId,workspaceId))).catch(()=>{});
      }
      return response;
    });
  } catch (error) { console.error('[ticket-code] request failed', {ticketId,action,error:error instanceof Error ? error.message : 'Unknown failure'}); return c.json({ error: 'The request or its recovery checkpoint failed. Your sandbox changes have been retained; refresh Coding before retrying. The sandbox stays awake if checkpointing failed.' }, 503); }
});
export default api;
