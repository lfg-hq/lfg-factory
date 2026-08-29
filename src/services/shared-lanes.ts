/**
 * Build lanes for the SHARED PREVIEW VM mode.
 *
 * A "lane" is one ticket working inside the project's always-on preview VM — its
 * own git worktree, sharing the box's toolchain caches, databases and running app.
 * The whole module is inert unless a project is set to `ticketBuildIsolation =
 * "shared"`; the default fresh-sandbox path never calls into it.
 *
 * Why bounded: the preview VM is 4 vCPU / 8 GB / 20 GB and is ALSO serving the app
 * and its databases. Pi sizes its heap to min(RAM-1GB, 4GB), so two unbounded agents
 * can ask for the whole box and the kernel OOM-killer picks a victim — quite possibly
 * Postgres or the preview, not the build that caused it. Two lanes is the honest
 * default; the third is only worth it with a lower per-agent heap cap.
 *
 * Why a credential check: Pi writes custom-provider credentials to ONE shared path
 * (/root/.pi/agent/models.json). Two concurrent builds needing DIFFERENT contents
 * there would clobber each other, so lanes that need an exclusive config only run
 * alongside lanes with identical credentials.
 */

import { execOnWorkspace } from "./mags.ts";

export type LaneKind = "build" | "chat";

export interface LaneRequest {
  ticketId: string;
  projectId: string;
  /** The always-on preview VM ("pv-…") this lane runs inside. */
  workspaceId: string;
  /** The lane's worktree directory name (not the absolute path). */
  dir: string;
  kind: LaneKind;
  /** provider|model|key-fingerprint — lanes needing different creds can't overlap. */
  credKey: string;
  /** True when this run writes the SHARED models.json (custom Pi providers). */
  exclusiveConfig: boolean;
}

interface Lane extends LaneRequest {
  startedAt: number;
  /** The in-VM pid of the agent runner, so Stop can be scoped to this lane. */
  pid?: number;
}

const lanes = new Map<string, Lane>(); // ticketId → lane

/** How many tickets may work in one preview VM at once. */
export function laneCapacity(): number {
  const n = parseInt(process.env.SHARED_LANE_MAX || "2", 10);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

/** Free-space floor (GB) below which a new lane is refused. */
export function laneMinFreeGb(): number {
  const n = parseFloat(process.env.SHARED_LANE_MIN_FREE_GB || "4");
  return Number.isFinite(n) && n > 0 ? n : 4;
}

export function activeLanes(workspaceId?: string): Lane[] {
  const all = [...lanes.values()];
  return workspaceId ? all.filter((l) => l.workspaceId === workspaceId) : all;
}

export function laneOf(ticketId: string): Lane | undefined {
  return lanes.get(ticketId);
}

/** Record the agent's in-VM pid so a Stop kills THIS lane and not its neighbours. */
export function noteLanePid(ticketId: string, pid: number | undefined): void {
  const l = lanes.get(ticketId);
  if (l && pid) l.pid = pid;
}

export function releaseLane(ticketId: string): void {
  lanes.delete(ticketId);
}

/** Free space on /data, in GB. Returns null when the VM can't be reached. */
export async function freeDiskGb(workspaceId: string): Promise<number | null> {
  try {
    const r = await execOnWorkspace(workspaceId, `df -P /data | awk 'NR==2{print $4}'`, { timeout: 45_000 });
    const kb = parseInt((r.output || "").trim().split(/\s+/)[0] ?? "", 10);
    return Number.isFinite(kb) ? kb / (1024 * 1024) : null;
  } catch {
    return null; // can't tell → don't block the build on a flaky probe
  }
}

export type LaneDecision =
  | { ok: true; release: () => void }
  | { ok: false; reason: string };

/**
 * Try to claim a lane. Refusals are informational, not errors — the caller leaves
 * the ticket queued and it runs when a lane frees.
 *
 * `onLowDisk` is a chance to evict finished tickets' worktrees before we give up.
 */
export async function tryAcquireLane(
  req: LaneRequest,
  onLowDisk?: () => Promise<void>,
): Promise<LaneDecision> {
  // Already in a lane (a retry, or a chat turn while its build runs) → reuse it.
  const existing = lanes.get(req.ticketId);
  if (existing) return { ok: true, release: () => { /* the original holder releases */ } };

  const here = activeLanes(req.workspaceId);
  if (here.length >= laneCapacity()) {
    return { ok: false, reason: `the preview VM is already running ${here.length} ticket${here.length === 1 ? "" : "s"} (limit ${laneCapacity()})` };
  }

  // Credential collision: Pi's models.json is one shared file per VM.
  const clash = here.find((l) => (l.exclusiveConfig || req.exclusiveConfig) && l.credKey !== req.credKey);
  if (clash) {
    return { ok: false, reason: "another ticket is building with a different model/key in this VM (they share one Pi config file)" };
  }

  let free = await freeDiskGb(req.workspaceId);
  if (free !== null && free < laneMinFreeGb() && onLowDisk) {
    await onLowDisk().catch(() => {});
    free = await freeDiskGb(req.workspaceId);
  }
  if (free !== null && free < laneMinFreeGb()) {
    return { ok: false, reason: `the preview VM is low on disk (${free.toFixed(1)} GB free, needs ${laneMinFreeGb()} GB)` };
  }

  lanes.set(req.ticketId, { ...req, startedAt: Date.now() });
  return { ok: true, release: () => releaseLane(req.ticketId) };
}

/** One ticket worktree living in the shared VM, as far as eviction is concerned. */
export interface WorktreeCandidate {
  ticketId: string;
  /** Ticket status: "done", "review", "failed", "in_progress"… */
  status: string | null;
  /** The ticket's branch, to compare against what the preview is serving. */
  branch: string | null;
  /** A pushed commit — proof the work exists somewhere other than this directory. */
  sha: string | null;
  /** Last time the ticket was touched; least-recently-touched is evicted first. */
  touched: Date | string | null;
}

/**
 * Decide WHICH worktrees may be removed to free space, and in what order.
 *
 * A worktree is a cache: its branch is on the remote, so removing it costs a
 * `git worktree add` plus a dependency install next time that ticket is built —
 * and nothing at all if it never is. What must never be removed is a directory
 * that is the ONLY copy of something, or one that's in use right now.
 *
 * Order: finished tickets first (nobody is coming back to them), then tickets whose
 * work is safely pushed, least-recently-touched first. That second tier is the one
 * that matters in practice — a real board parks a dozen tickets in In Review, and a
 * done-only policy would free nothing exactly when space runs out.
 */
export function planWorktreeEviction(
  candidates: WorktreeCandidate[],
  ctx: {
    /** The ticket asking for space — never evict the directory it's about to use. */
    keepTicketId?: string;
    /** The branch the preview is serving right now, if any. */
    liveBranch?: string | null;
    /** Include the "pushed but not finished" tier (In Review and friends). */
    includePushed: boolean;
  },
): WorktreeCandidate[] {
  const safe = candidates.filter((c) =>
    !!c.ticketId &&
    c.ticketId !== ctx.keepTicketId &&
    !lanes.has(c.ticketId) &&                                        // working right now
    !(c.branch && ctx.liveBranch && c.branch === ctx.liveBranch) &&  // on screen right now
    c.status !== "in_progress",
  );
  const age = (c: WorktreeCandidate) => new Date(c.touched ?? 0).getTime();
  const byAge = (a: WorktreeCandidate, b: WorktreeCandidate) => age(a) - age(b);
  const done = safe.filter((c) => c.status === "done").sort(byAge);
  // Only what is PUSHED. A build whose push failed has its sole copy in that
  // directory — deleting it would destroy the work outright.
  const pushed = ctx.includePushed
    ? safe.filter((c) => c.status !== "done" && !!c.sha).sort(byAge)
    : [];
  return [...done, ...pushed];
}

/**
 * What is actually eating /data, biggest first — so a "low on disk" refusal tells the
 * user where the space went instead of leaving them to guess.
 */
export async function topDiskConsumers(workspaceId: string, limit = 5): Promise<string> {
  try {
    const r = await execOnWorkspace(
      workspaceId,
      `du -sh /data/* 2>/dev/null | sort -rh | head -${limit} | awk '{printf "%s %s, ", $1, $2}'`,
      { timeout: 90_000 },
    );
    return (r.output || "").trim().replace(/,$/, "");
  } catch {
    return "";
  }
}

/**
 * Stop ONE lane without touching the rest of the box.
 *
 * The isolated path stops a build with pattern kills (`pkill -f pi-coding-agent`,
 * `pkill -f 'npm install'`…), which in a shared VM would also kill every other
 * ticket's agent and any install the preview is running. Here we kill the lane's
 * agent pid and everything whose working directory is that lane's worktree — which
 * is where the agent and every command it spawns run. busybox-safe (/proc + readlink,
 * no pgrep/pkill flags), and it never matches the shell running it.
 */
export function scopedStopScript(worktreeDir: string, pid?: number): string {
  return `
DIR="${worktreeDir}"
${pid ? `kill -9 ${pid} 2>/dev/null || true` : "true"}
for p in /proc/[0-9]*; do
  target="\${p##*/}"
  [ "$target" = "$$" ] && continue
  cwd="$(readlink "$p/cwd" 2>/dev/null)"
  case "$cwd" in
    "$DIR"|"$DIR"/*) kill -9 "$target" 2>/dev/null || true ;;
  esac
done
echo SCOPED_STOP_DONE`.trim();
}

/**
 * Claim a lane, waiting for one to free up. Used by CHAT, which is interactive —
 * the person is watching a "working…" indicator, so we wait rather than refuse, and
 * after the wait we proceed anyway (a slow answer beats no answer).
 */
export async function acquireLaneWaiting(
  req: LaneRequest,
  maxWaitMs: number,
  onWait?: (reason: string) => void,
): Promise<LaneDecision> {
  const deadline = Date.now() + maxWaitMs;
  let told = false;
  for (;;) {
    const d = await tryAcquireLane(req);
    if (d.ok) return d;
    if (Date.now() >= deadline) return d;
    if (!told) { told = true; onWait?.(d.reason); }
    await new Promise((r) => setTimeout(r, 3_000));
  }
}
