import { db } from '../config/db.ts';
import { sandboxes } from '../db/schema/sandbox.ts';
import { projectEnvironments } from '../db/schema/project-environments.ts';
import { deleteWorkspace } from './mags.ts';

/**
 * Deletes Mags workspaces LFG no longer needs. A stopped VM keeps its disk on the host, and
 * LFG used to leave them all behind (sign-in VMs, instant apps, failed copies, old builds):
 * ~1,550 accumulated until no host had room for a new VM.
 *
 * Kept: anything active, every preview (pv-…), and every workspace an LFG record still points
 * at (ticket sandboxes are retired by their own sweeper, which checks for unsaved work first).
 * Ticket-kind leftovers (failed copies, fresh code VMs) go after 2 hours idle, everything else
 * after 2 days. Deletes are throttled per run.
 */
export type MagsWorkspace = { workspace_id: string; last_used?: string | null; has_active?: boolean };

const HOUR = 3_600_000;
const SHORT_LIVED = /^(clone|code|chat|epic-validation|validation)-/;
const SHORT_IDLE_MS = 2 * HOUR;
const LONG_IDLE_MS = 48 * HOUR;
export const REAP_PER_RUN = Number(process.env.MAGS_REAPER_BATCH ?? 150);

/** Which workspaces may be deleted now. Pure, for tests. */
export function reapable(list: MagsWorkspace[], keep: Set<string>, now = Date.now()): string[] {
  return list.filter(w => {
    const id = w.workspace_id;
    if (!id || w.has_active || id.startsWith('pv-') || keep.has(id)) return false;
    const lastUsed = Date.parse(w.last_used ?? '');
    if (!Number.isFinite(lastUsed)) return false; // unknown age: leave it
    return now - lastUsed > (SHORT_LIVED.test(id) ? SHORT_IDLE_MS : LONG_IDLE_MS);
  }).sort((a, b) => Date.parse(a.last_used ?? '') - Date.parse(b.last_used ?? '')).map(w => w.workspace_id);
}

async function listWorkspaces(): Promise<MagsWorkspace[]> {
  const token = process.env.MAGS_API_TOKEN;
  if (!token) return [];
  const base = (process.env.MAGS_API_URL || 'https://api.magpiecloud.com').replace(/\/+$/, '');
  const response = await fetch(`${base}/api/v2/mags-workspaces`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Mags workspace list HTTP ${response.status}`);
  const body: any = await response.json();
  return Array.isArray(body) ? body : (body.workspaces ?? body.items ?? body.data ?? []);
}

/** Workspaces LFG still points at: ticket sandboxes (any status) and project previews. */
async function referencedWorkspaces(): Promise<Set<string>> {
  const rows = await db.select({ id: sandboxes.magsWorkspaceId }).from(sandboxes);
  const previews = await db.select({ id: projectEnvironments.workspaceId }).from(projectEnvironments);
  return new Set([...rows, ...previews].map(r => r.id).filter((id): id is string => !!id));
}

export async function reapMagsWorkspaces(): Promise<{ deleted: number; failed: number; remaining: number }> {
  if (process.env.SANDBOX_BACKEND === 'docker' || process.env.MAGS_REAPER === 'off') return { deleted: 0, failed: 0, remaining: 0 };
  const candidates = reapable(await listWorkspaces(), await referencedWorkspaces());
  let deleted = 0, failed = 0;
  for (const id of candidates.slice(0, REAP_PER_RUN)) {
    try { await deleteWorkspace(id); deleted++; }
    catch (error) {
      if (/404|not found/i.test((error as Error).message ?? '')) { deleted++; continue; }
      failed++;
      console.warn('[mags-reaper] could not delete', id, (error as Error).message?.slice(0, 120));
    }
  }
  if (deleted || failed) console.log(`[mags-reaper] deleted ${deleted} idle workspace(s), ${failed} failed, ${Math.max(0, candidates.length - deleted - failed)} left for later runs`);
  return { deleted, failed, remaining: Math.max(0, candidates.length - deleted - failed) };
}

let started = false;
/** Runs every 10 minutes, starting 2 minutes after boot. */
export function startMagsReaper(): void {
  if (started) return;
  started = true;
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void reapMagsWorkspaces().catch(error => console.warn('[mags-reaper] run failed:', (error as Error).message))
      .finally(() => { running = false; });
  };
  setTimeout(tick, 2 * 60_000).unref?.();
  setInterval(tick, 10 * 60_000).unref?.();
}
