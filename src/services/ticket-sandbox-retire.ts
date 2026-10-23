import { and, eq, inArray, lt } from 'drizzle-orm';
import { db } from '../config/db.ts';
import { sandboxes } from '../db/schema/sandbox.ts';
import { projectTickets } from '../db/schema/tickets.ts';
import { deleteWorkspace, execOnWorkspace, setNoSleep } from './mags.ts';
import { shellQuote } from './ticket-code.ts';
import { checkpointTicketWorkspace, discardTicketCheckpoint } from './ticket-workspace-checkpoint.ts';
import { isChatTurnActive } from './ticket-chat-turn.ts';
import { ticketWorkspaceRoot, withTicketWorkspaceLock } from './ticket-workspace.ts';

/**
 * Ticket build sandboxes are disposable. GitHub holds the code and the database holds
 * the agent's work journal, so a finished turn retires its VM: after a short grace
 * period (fast "one more tweak" follow-ups reuse it) the sweeper deletes it, and the
 * next follow-up starts a fresh clone of the prepared environment on the ticket branch.
 * Uncommitted or unpushed edits are the one exception: they are checkpointed first, and
 * a VM whose edits could not be saved is held (asleep) instead of deleted.
 */
export const TICKET_SANDBOX_GRACE_MS = Math.max(0, parseInt(process.env.TICKET_SANDBOX_GRACE_MIN || '10', 10)) * 60_000;
const DISPOSABLE = ['ticket', 'ticket-chat'];
const JOURNAL_MAX_ENTRIES = 8;
// A 'busy' row this old belongs to a turn that died with the server (no retire ran).
const ABANDONED_BUSY_MS = 3 * 60 * 60_000;
const SWEEPABLE = ['idle', 'sleeping', 'ready', 'busy'];
// Sandboxes parked before disposable sandboxes shipped are only swept when explicitly
// enabled: clearing them is a one-off bulk deletion across every project.
const LEGACY_BEFORE = new Date(process.env.TICKET_SANDBOX_LEGACY_BEFORE || '2026-10-23T15:00:00Z');
const isLegacy = (row: { status: string; updatedAt: Date }) => row.status !== 'idle' && row.updatedAt < LEGACY_BEFORE && process.env.TICKET_SANDBOX_SWEEP_LEGACY !== '1';
const JOURNAL_ENTRY_CHARS = 4000;

/** Outside the repository, so it is never committed; one file per ticket for shared VMs. */
export const ticketJournalPath = (ticketId: string) => `/data/.lfg-journal-${ticketId.slice(0, 12)}.md`;

export function ticketJournalInstruction(ticketId: string): string {
  return `

## Work journal (required before you finish)
This sandbox is deleted after your turn. The next turn starts in a fresh sandbox with only the code on the ticket branch and this journal, so write what the next agent needs. Before your final reply, overwrite ${ticketJournalPath(ticketId)} (outside the repository; never commit it) with short Markdown under these headings:
- **Changed**: what you changed this turn and why (files or areas).
- **Verified**: what you actually ran or checked, and the result.
- **Open**: anything unfinished, failing or unverified.
- **Setup notes**: commands, ports, env settings or quirks needed to build, run or test this project.
Keep it under 40 lines. No secrets or key values.`;
}

type JournalEntry = { at: string; kind: string; text: string };

export function workJournalBlock(details: unknown): string {
  const entries = ((details as { workJournal?: JournalEntry[] } | null)?.workJournal ?? []).filter(e => e?.text);
  if (!entries.length) return '';
  return `\n## Work journal from earlier turns (oldest first; the code on the branch is the source of truth)\n${entries.map(e => `### ${e.kind} · ${e.at}\n${e.text}`).join('\n\n')}\n`;
}

/** Move the journal the agent wrote into the ticket record. Missing or unreadable files are ignored. */
export async function collectTicketJournal(ticketId: string, workspaceId: string, kind: string): Promise<void> {
  const path = ticketJournalPath(ticketId);
  const r = await execOnWorkspace(workspaceId, `if [ -f ${shellQuote(path)} ]; then head -c ${JOURNAL_ENTRY_CHARS} ${shellQuote(path)}; rm -f ${shellQuote(path)}; fi`, { timeout: 20_000 }).catch(() => null);
  const text = r?.exitCode === 0 ? r.output.trim() : '';
  if (!text) return;
  const [ticket] = await db.select({ details: projectTickets.details }).from(projectTickets).where(eq(projectTickets.id, ticketId));
  if (!ticket) return;
  const details = (ticket.details ?? {}) as Record<string, unknown> & { workJournal?: JournalEntry[] };
  const workJournal = [...(details.workJournal ?? []), { at: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC', kind, text }].slice(-JOURNAL_MAX_ENTRIES);
  await db.update(projectTickets).set({ details: { ...details, workJournal } }).where(eq(projectTickets.id, ticketId));
}

/** 'published' when the checkout has no edits and HEAD is on the remote branch or is the recorded pushed commit. */
async function publishedState(workspaceId: string, root: string, branch: string | null, pushedSha: string | null): Promise<'published' | 'local' | 'unknown'> {
  if (!branch) return 'unknown';
  const sha = pushedSha && /^[a-f0-9]{40,64}$/i.test(pushedSha) ? pushedSha : '';
  const script = `set -u
cd ${shellQuote(root)} 2>/dev/null || { echo STATE_UNKNOWN; exit 0; }
[ "$(git symbolic-ref --short HEAD 2>/dev/null)" = ${shellQuote(branch)} ] || { echo STATE_UNKNOWN; exit 0; }
[ -z "$(git status --porcelain --untracked-files=normal 2>/dev/null)" ] || { echo STATE_LOCAL; exit 0; }
HEAD_SHA=$(git rev-parse HEAD)
if [ -n ${shellQuote(sha)} ] && [ "$HEAD_SHA" = ${shellQuote(sha)} ]; then echo STATE_PUBLISHED; exit 0; fi
git merge-base --is-ancestor HEAD ${shellQuote('refs/remotes/origin/' + branch)} 2>/dev/null && echo STATE_PUBLISHED || echo STATE_LOCAL`;
  const r = await execOnWorkspace(workspaceId, script, { timeout: 30_000 }).catch(() => null);
  const out = r?.output ?? '';
  return out.includes('STATE_PUBLISHED') ? 'published' : out.includes('STATE_LOCAL') ? 'local' : 'unknown';
}

/** Make the VM's work safe to lose: 'idle' when it is on GitHub or checkpointed, else 'held'. */
async function settle(ticketId: string, workspaceId: string, row: typeof sandboxes.$inferSelect): Promise<'idle' | 'held'> {
  const [ticket] = await db.select({ branch: projectTickets.githubBranch, sha: projectTickets.githubCommitSha }).from(projectTickets).where(eq(projectTickets.id, ticketId));
  const branch = ticket?.branch ?? row.currentBranch ?? null;
  const state = await publishedState(workspaceId, ticketWorkspaceRoot(row), branch, ticket?.sha ?? null);
  if (state === 'published') { await discardTicketCheckpoint(ticketId).catch(() => {}); return 'idle'; } // restore from the branch, not an old snapshot
  if (state === 'unknown') return 'held';
  try { await checkpointTicketWorkspace(ticketId, workspaceId, ticketWorkspaceRoot(row), branch ?? undefined); return 'idle'; }
  catch (error) { console.error('[ticket-sandbox] checkpoint failed; holding sandbox', workspaceId, error); return 'held'; }
}

/**
 * End of a ticket turn. Saves the journal, then marks a dedicated VM idle for deletion
 * once its work is safe (on GitHub, or checkpointed). Never touches the preview VM.
 */
export async function retireTicketSandbox(ticketId: string, workspaceId: string | null | undefined, kind = 'Turn'): Promise<void> {
  if (!workspaceId) return;
  await collectTicketJournal(ticketId, workspaceId, kind).catch(error => console.warn('[ticket-sandbox] journal not saved', ticketId, (error as Error).message));
  if (workspaceId.startsWith('pv-')) return;
  const rows = await db.select().from(sandboxes).where(and(eq(sandboxes.ticketId, ticketId), eq(sandboxes.magsWorkspaceId, workspaceId), inArray(sandboxes.workspaceType, DISPOSABLE)));
  const first = rows[0];
  if (!first) return;
  const status = await settle(ticketId, workspaceId, first);
  await db.update(sandboxes).set({ status, updatedAt: new Date() }).where(inArray(sandboxes.id, rows.map(r => r.id)));
  // Let it idle-sleep either way: a VM pinned awake for hours stops answering commands.
  await setNoSleep(workspaceId, false).catch(() => {});
}

/** A turn is starting on this VM: keep the sweeper away from it. */
export async function markTicketSandboxBusy(workspaceId: string): Promise<void> {
  await db.update(sandboxes).set({ status: 'busy', updatedAt: new Date() }).where(and(eq(sandboxes.magsWorkspaceId, workspaceId), inArray(sandboxes.workspaceType, DISPOSABLE))).catch(() => {});
}

/** Delete idle ticket VMs past the grace period. Held VMs (unsaved edits) are never deleted. */
export async function sweepIdleTicketSandboxes(): Promise<number> {
  const cutoff = new Date(Date.now() - TICKET_SANDBOX_GRACE_MS);
  const rows = await db.select().from(sandboxes).where(and(inArray(sandboxes.workspaceType, DISPOSABLE), inArray(sandboxes.status, SWEEPABLE), lt(sandboxes.updatedAt, cutoff)));
  let deleted = 0;
  for (const row of rows) {
    if (!row.ticketId || !row.magsWorkspaceId || row.magsWorkspaceId.startsWith('pv-')) continue;
    const ticketId = row.ticketId, workspaceId = row.magsWorkspaceId;
    // Cheap checks first, so the workspace lock is only taken for real candidates.
    if ((row.status === 'busy' && Date.now() - row.updatedAt.getTime() < ABANDONED_BUSY_MS) || isLegacy(row) || isChatTurnActive(ticketId)) continue;
    try {
      await withTicketWorkspaceLock(ticketId, async () => {
        const [current] = await db.select().from(sandboxes).where(eq(sandboxes.id, row.id));
        if (!current || current.magsWorkspaceId !== workspaceId || !SWEEPABLE.includes(current.status) || current.updatedAt > cutoff) return;
        if (current.status === 'busy' && Date.now() - current.updatedAt.getTime() < ABANDONED_BUSY_MS) return;
        const [ticket] = await db.select({ q: projectTickets.queueStatus, branch: projectTickets.githubBranch, sha: projectTickets.githubCommitSha }).from(projectTickets).where(eq(projectTickets.id, ticketId));
        if (!ticket || /^(queued|executing|stopping)$/.test(ticket.q) || isChatTurnActive(ticketId)) return;
        // Rows not retired by a turn (older rows, the Coding editor) were never checked: settle first.
        if (current.status !== 'idle' && await settle(ticketId, workspaceId, current) !== 'idle') {
          await db.update(sandboxes).set({ status: 'held', updatedAt: new Date() }).where(eq(sandboxes.id, row.id));
          return;
        }
        await deleteWorkspace(workspaceId).catch(error => { if (!/404|not found/i.test((error as Error).message)) throw error; });
        await db.delete(sandboxes).where(eq(sandboxes.id, row.id));
        deleted++;
        console.log(`[ticket-sandbox] deleted idle ticket sandbox ${workspaceId} (ticket ${ticketId})`);
      });
    } catch (error) {
      console.warn('[ticket-sandbox] sweep skipped', workspaceId, (error as Error).message);
    }
  }
  return deleted;
}
