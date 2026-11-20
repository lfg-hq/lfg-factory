/**
 * Previews on the person's own computer.
 *
 * With "Use my computer for AI" on, the Preview tab runs the app through LFG Desktop
 * instead of starting a cloud sandbox: the computer checks out the branch in its own
 * preview folder, installs, starts the dev server(s) from the saved preview plan, and
 * reports the http://localhost address back here.
 *
 * A computer preview belongs to one person (it runs on their machine), so its state
 * lives on that person's runner job, not on the project's shared preview row. The job
 * stays "running" for as long as the app runs; stopping it cancels the job.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../config/db.ts";
import { runnerJobs } from "../../db/schema/runners.ts";
import { projects, projectEnvironmentVariables } from "../../db/schema/projects.ts";
import { projectEnvironments } from "../../db/schema/project-environments.ts";
import { projectTickets } from "../../db/schema/tickets.ts";
import { epics } from "../../db/schema/epics.ts";
import { decryptSecret } from "../../utils/crypto.ts";
import { ticketBranchName } from "../../utils/ticket-branch.ts";
import { broadcastToUser } from "../../ws/connection-manager.ts";
import { cancelJob, connectedRunnerFor, enqueueJob } from "./hub.ts";
import { localAiSettings } from "./opt-in.ts";
import { projectRunOn, ticketBuildWith } from "./build-target.ts";
import { RUNNER_PROTOCOL_VERSION, type PreviewPayload, type PreviewPhase, type PreviewPlan, type PreviewStep, type PreviewUpdate, type PreviewUrl } from "./protocol.ts";

/** Oldest runner protocol that knows how to run a preview. */
export const PREVIEW_PROTOCOL = 3;

export type PreviewWhere = { where: "computer" } | { where: "cloud"; reason?: string };

/**
 * Where this person's preview runs. The computer, when "Use my computer for AI" is on,
 * unless they asked for the cloud or the ticket being previewed is set to build in the cloud.
 */
export async function resolvePreviewWhere(userId: string, opts: { requested?: unknown; ticketId?: string | null; projectId?: string } = {}): Promise<PreviewWhere> {
  if (opts.requested === "cloud") return { where: "cloud" };
  // The ticket's own Build with choice wins, then the project's setting, then the person's.
  let ticketChoice: ReturnType<typeof ticketBuildWith> = null;
  if (opts.ticketId) {
    const [ticket] = await db.select({ details: projectTickets.details }).from(projectTickets).where(eq(projectTickets.id, opts.ticketId)).limit(1);
    ticketChoice = ticketBuildWith(ticket?.details);
    if (ticketChoice === "cloud") return { where: "cloud", reason: "This ticket is set to build in the cloud, so its preview runs there too." };
  }
  if (!ticketChoice && opts.projectId && opts.requested !== "computer") {
    const [p] = await db.select({ previewOn: projects.previewOn }).from(projects).where(eq(projects.id, opts.projectId)).limit(1);
    if (projectRunOn(p?.previewOn) === "cloud") return { where: "cloud" };
  }
  const settings = await localAiSettings(userId);
  if (!settings.enabled) return { where: "cloud" };
  return { where: "computer" };
}

// ── State ────────────────────────────────────────────────────────────

interface LocalState {
  status: PreviewPhase;
  steps: PreviewStep[];
  log: string;
  urls: PreviewUrl[];
  error: string | null;
  deviceName: string | null;
}
const MAX_LOG = 60_000;
const states = new Map<string, LocalState>(); // jobId → live state
const savedAt = new Map<string, number>();
const waiters = new Map<string, Set<(s: LocalState) => void>>();

const fresh = (): LocalState => ({ status: "detecting", steps: [], log: "", urls: [], error: null, deviceName: null });

function readSaved(job: typeof runnerJobs.$inferSelect): LocalState {
  const live = states.get(job.id);
  if (live) return live;
  try { if (job.summary) return { ...fresh(), ...(JSON.parse(job.summary) as Partial<LocalState>) }; } catch { /* not ours */ }
  return fresh();
}

async function save(jobId: string, state: LocalState, force = false) {
  const now = Date.now();
  if (!force && now - (savedAt.get(jobId) ?? 0) < 1500) return;
  savedAt.set(jobId, now);
  await db.update(runnerJobs).set({ summary: JSON.stringify(state) }).where(eq(runnerJobs.id, jobId));
}

const stamp = () => new Date().toISOString().slice(11, 19);

function payloadOf(job: typeof runnerJobs.$inferSelect): PreviewPayload | null {
  try { return JSON.parse(job.payload) as PreviewPayload; } catch { return null; }
}

function broadcast(job: typeof runnerJobs.$inferSelect, state: LocalState, message: string, lines: string[] = []) {
  const p = payloadOf(job);
  if (!p) return;
  for (const line of lines) broadcastToUser(job.userId, { type: "preview_log", projectId: p.projectId, line, level: "info", where: "computer" });
  broadcastToUser(job.userId, {
    type: "preview_status", projectId: p.projectId, where: "computer",
    status: state.status, message, previewUrl: primaryUrl(state) ?? undefined, error: state.error ?? undefined,
  });
}

/** The Steps view groups steps by phase, like the cloud's. */
const PHASES: Array<[RegExp, string]> = [[/^(code|databases)/, "prepare"], [/^(install|build)/, "install"], [/^(migrate|seed)/, "schema"], [/^start/, "run"]];
const withPhases = (steps: PreviewStep[]) => steps.map(s => ({ ...s, phase: PHASES.find(([re]) => re.test(s.id))?.[1] ?? "prepare" }));

const primaryUrl = (s: LocalState) => (s.urls.find(u => u.primary) ?? s.urls[0])?.url ?? null;

/** A runner reported progress on a preview job (called by the hub, in order per computer). */
export async function applyPreviewUpdate(job: typeof runnerJobs.$inferSelect, update: PreviewUpdate): Promise<void> {
  if (job.type !== "preview" || !["offered", "running"].includes(job.status)) return;
  const state = readSaved(job);
  states.set(job.id, state);
  const lines = (Array.isArray(update.lines) ? update.lines : []).map(l => `[${stamp()}] ${String(l).slice(0, 4000)}`);
  if (lines.length) state.log = (state.log + lines.join("\n") + "\n").slice(-MAX_LOG);
  const statusChanged = !!update.status && update.status !== state.status;
  if (update.status) state.status = update.status;
  if (Array.isArray(update.steps)) state.steps = update.steps.slice(0, 40).map(s => ({ id: String(s.id).slice(0, 40), label: String(s.label).slice(0, 200), status: s.status, ...(s.command ? { command: String(s.command).slice(0, 500) } : {}) }));
  if (Array.isArray(update.steps)) {
    const p = payloadOf(job);
    if (p) broadcastToUser(job.userId, { type: "preview_steps", projectId: p.projectId, where: "computer", steps: withPhases(state.steps) });
  }
  if (Array.isArray(update.urls)) state.urls = update.urls.filter(u => isLocalUrl(u.url)).slice(0, 10);
  if (update.error !== undefined) state.error = update.error ? String(update.error).slice(0, 2000) : null;
  await save(job.id, state, statusChanged || !!update.urls || !!update.error);
  broadcast(job, state, update.status === "running" ? "Running on your computer" : "", lines);
  if (state.status === "running" || state.status === "error") for (const fn of waiters.get(job.id) ?? []) fn(state);
}

/** The hub's lifecycle events for a preview job: accepted, declined, finished. */
export async function previewJobChanged(job: typeof runnerJobs.$inferSelect, change:
  | { type: "accepted"; deviceName: string }
  | { type: "rejected"; reason?: string }
  | { type: "finished"; ok: boolean; error?: string }): Promise<void> {
  const state = readSaved(job);
  states.set(job.id, state);
  let message = "";
  if (change.type === "accepted") {
    state.deviceName = change.deviceName;
    message = `Starting on ${change.deviceName}…`;
    state.log += `[${stamp()}] ${message}\n`;
  } else if (change.type === "rejected") {
    state.status = "error";
    state.error = change.reason ? `Your computer didn't run the preview: ${change.reason}` : "Your computer declined to run the preview.";
  } else if (change.ok) {
    state.status = "stopped";
    state.urls = [];
  } else {
    state.status = "error";
    state.error = change.error ?? state.error ?? "The preview stopped on your computer.";
    state.urls = [];
  }
  await save(job.id, state, true);
  broadcast(job, state, message);
  if (change.type !== "accepted") {
    for (const fn of waiters.get(job.id) ?? []) fn(state);
    states.delete(job.id);
    savedAt.delete(job.id);
  }
}

const isLocalUrl = (u: unknown) => typeof u === "string" && /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d{2,5}(\/|$)/.test(u);

// ── Starting and stopping ────────────────────────────────────────────

export class LocalPreviewError extends Error {
  constructor(message: string, readonly status: 400 | 404 = 400) { super(message); }
}

/** The saved cloud preview plan, in the shape the computer runs. Only the apps that are switched on. */
export function planFromManifest(raw: string | null | undefined): PreviewPlan | null {
  if (!raw) return null;
  let m: any;
  try { m = JSON.parse(raw); } catch { return null; }
  if (!m || typeof m.runCmd !== "string" || !m.runCmd.trim() || !Number.isInteger(m.port)) return null;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const services = (Array.isArray(m.services) ? m.services : [])
    .filter((s: any) => s && !s.primary && s.enabled && typeof s.runCmd === "string" && Number.isInteger(s.port))
    .map((s: any) => ({ name: String(s.name), runCmd: s.runCmd, port: s.port, ...(str(s.buildCmd) ? { buildCmd: str(s.buildCmd) } : {}), ...(str(s.dir) ? { dir: str(s.dir) } : {}) }));
  const databases = (Array.isArray(m.databases) ? m.databases : [])
    .filter((d: any) => d && ["postgres", "mysql", "redis", "mssql"].includes(d.engine) && typeof d.connectionEnvVar === "string")
    .map((d: any) => ({ engine: d.engine, connectionEnvVar: d.connectionEnvVar, connectionFormat: String(d.connectionFormat || "url"), ...(str(d.databaseName) ? { databaseName: str(d.databaseName) } : {}) }));
  return {
    ...(str(m.stack) ? { stack: str(m.stack) } : {}),
    ...(str(m.installCmd) ? { installCmd: str(m.installCmd) } : {}),
    ...(str(m.buildCmd) ? { buildCmd: str(m.buildCmd) } : {}),
    runCmd: m.runCmd.trim(),
    port: m.port,
    ...(services.length ? { services } : {}),
    databases,
    ...(Array.isArray(m.migrations) && m.migrations.length ? { migrations: m.migrations.filter((c: unknown) => typeof c === "string" && c.trim()) } : {}),
    ...(str(m.seedCmd) ? { seedCmd: str(m.seedCmd) } : {}),
  };
}

const RESERVED_ENV = new Set(["PATH", "HOME", "USER", "SHELL", "PWD", "TMPDIR", "NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"]);

/** The cloud preview's addresses, so the computer can point Env values that name them at localhost. */
function cloudOrigins(appUrl: string | null | undefined, alias: string | null | undefined): string[] {
  const out = new Set<string>();
  try { if (appUrl) out.add(new URL(appUrl).origin); } catch { /* not a URL */ }
  if (alias) out.add(`https://${alias}.${process.env.MAGS_APP_DOMAIN || "app.lfg.run"}`);
  return [...out];
}

async function projectEnv(projectId: string): Promise<Record<string, string>> {
  const rows = await db.select().from(projectEnvironmentVariables).where(eq(projectEnvironmentVariables.projectId, projectId));
  const out: Record<string, string> = {};
  for (const row of rows) {
    if (!row.hasValue || RESERVED_ENV.has(row.key) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.key)) continue;
    try { out[row.key] = decryptSecret(row.encryptedValue); } catch { /* unreadable: the Env tab says so */ }
  }
  return out;
}

/** The branch (and its label) for a ticket, an epic ("epic:<id>" or its branch), or the default. */
export async function resolvePreviewBranch(projectId: string, input: { ticketId?: string | null; branch?: string | null }): Promise<{ branch: string | null; label: string }> {
  if (input.ticketId) {
    const [t] = await db.select().from(projectTickets).where(and(eq(projectTickets.id, input.ticketId), eq(projectTickets.projectId, projectId))).limit(1);
    if (!t) throw new LocalPreviewError("Ticket not found", 404);
    return { branch: t.githubBranch || ticketBranchName(t), label: `${t.ticketKey ? `${t.ticketKey} — ` : ""}${t.name}`.slice(0, 80) };
  }
  const b = input.branch?.trim();
  if (!b || b === "(default)" || b === "default") return { branch: null, label: "Default branch" };
  if (!/^(?!-)(?!.*\.\.)[A-Za-z0-9._\/-]{1,200}$/.test(b)) throw new LocalPreviewError("That isn't a branch name LFG can run.");
  const [epic] = await db.select({ key: epics.epicKey, name: epics.name }).from(epics).where(and(eq(epics.projectId, projectId), eq(epics.branch, b))).limit(1);
  return { branch: b, label: epic ? `${epic.key ? `${epic.key} — ` : ""}${epic.name}`.slice(0, 80) : b };
}

const ACTIVE = ["queued", "offered", "running"];

async function latestJob(userId: string, projectId: string) {
  const [job] = await db.select().from(runnerJobs)
    .where(and(eq(runnerJobs.userId, userId), eq(runnerJobs.projectId, projectId), eq(runnerJobs.type, "preview")))
    .orderBy(desc(runnerJobs.createdAt)).limit(1);
  return job ?? null;
}

/**
 * Start (or restart) this person's preview of a project on their computer. Any earlier
 * preview of the same project on their computer is stopped first.
 * branch: the branch to run, null for the default; undefined keeps whatever ran last.
 */
export async function startLocalPreview(input: {
  projectId: string; userId: string; branch?: string | null; label?: string; refresh: boolean;
}) {
  const [project] = await db.select().from(projects).where(eq(projects.id, input.projectId)).limit(1);
  if (!project) throw new LocalPreviewError("Project not found", 404);
  if (!project.repoUrl) throw new LocalPreviewError("This project has no Git repository yet, so there's nothing to run. Build a ticket first; that creates the repository.");

  const previous = await latestJob(input.userId, project.id);
  const prevPayload = previous ? payloadOf(previous) : null;
  const branch = input.branch !== undefined ? input.branch : (prevPayload?.branch ?? null);
  const label = input.label ?? (input.branch !== undefined ? (branch ?? "Default branch") : (prevPayload?.label ?? "Default branch"));
  await stopActive(input.userId, project.id);

  const [env] = await db.select({ manifest: projectEnvironments.setupManifest, appUrl: projectEnvironments.appUrl, alias: projectEnvironments.stableAlias })
    .from(projectEnvironments).where(eq(projectEnvironments.projectId, project.id)).limit(1);
  const payload: PreviewPayload = {
    protocol: RUNNER_PROTOCOL_VERSION,
    projectId: project.projectId ?? project.id,
    projectName: project.name,
    repoUrl: project.repoUrl,
    branch,
    label,
    refresh: input.refresh,
    plan: planFromManifest(env?.manifest),
    env: await projectEnv(project.id),
    cloudOrigins: cloudOrigins(env?.appUrl, env?.alias),
  };
  const job = await enqueueJob({ userId: input.userId, projectId: project.id, ticketId: null, type: "preview", payload });
  const state = fresh();
  const runner = connectedRunnerFor(input.userId, PREVIEW_PROTOCOL);
  state.log = `[${stamp()}] ${runner ? `Sent to ${runner.deviceName}.` : waitingMessage(input.userId)}\n`;
  states.set(job.id, state);
  await save(job.id, state, true);
  broadcast(job, state, runner ? "Starting on your computer…" : "Waiting for your computer");
  return job;
}

function waitingMessage(userId: string) {
  return connectedRunnerFor(userId, 0)
    ? "Your LFG Desktop is too old to run previews. Update LFG Desktop and this preview starts there, or run it in the cloud."
    : "Waiting for your computer. Open LFG Desktop and the preview starts there.";
}

async function stopActive(userId: string, projectId: string) {
  const active = await db.select({ id: runnerJobs.id }).from(runnerJobs)
    .where(and(eq(runnerJobs.userId, userId), eq(runnerJobs.projectId, projectId), eq(runnerJobs.type, "preview"), inArray(runnerJobs.status, ACTIVE)));
  for (const { id } of active) await cancelJob(id);
  for (const { id } of active) { states.delete(id); savedAt.delete(id); }
  return active.length;
}

/** Stop this person's preview of a project on their computer. */
export async function stopLocalPreview(userId: string, projectId: string): Promise<void> {
  const job = await latestJob(userId, projectId);
  await stopActive(userId, projectId);
  if (job) {
    const p = payloadOf(job);
    if (p) broadcastToUser(userId, { type: "preview_status", projectId: p.projectId, where: "computer", status: "stopped", message: "Preview stopped" });
  }
}

/** Wait until a computer preview is up (or has failed), for callers that report the address. */
export function waitForLocalPreview(jobId: string, timeoutMs: number): Promise<{ previewUrl: string } | { error: string }> {
  return new Promise(resolve => {
    const done = (s: LocalState) => {
      clearTimeout(timer);
      waiters.get(jobId)?.delete(done);
      const url = primaryUrl(s);
      resolve(s.status === "running" && url ? { previewUrl: url } : { error: s.error ?? "The preview stopped on your computer." });
    };
    const timer = setTimeout(() => { waiters.get(jobId)?.delete(done); resolve({ error: "Still starting on your computer; the Preview tab shows its progress." }); }, timeoutMs);
    if (!waiters.has(jobId)) waiters.set(jobId, new Set());
    waiters.get(jobId)!.add(done);
  });
}

/** The Preview tab's state for this person's computer, in the same shape as the cloud's. */
export async function localPreviewState(userId: string, projectId: string) {
  const job = await latestJob(userId, projectId);
  const base = { where: "computer" as const, manifest: null, databaseIdentities: [], setupComplete: true };
  if (!job) return { ...base, previewStatus: "idle", previewUrl: null, error: null, branch: null, log: "", steps: [], services: [], deviceName: null, waiting: false, label: null };
  const p = payloadOf(job);
  const s = readSaved(job);
  const waiting = job.status === "queued";
  const status: PreviewPhase =
    job.status === "queued" || job.status === "offered" ? "detecting"
    : job.status === "running" ? s.status
    : job.status === "failed" || job.status === "rejected" ? "error"
    : s.status === "error" ? "error" : "stopped";
  const url = status === "running" ? primaryUrl(s) : null;
  return {
    ...base,
    previewStatus: status,
    previewUrl: url,
    error: status === "error" ? (s.error ?? job.error ?? "The preview stopped on your computer.") : null,
    branch: p?.branch ?? "(default)",
    label: p?.label ?? null,
    log: s.log + (waiting && !s.log.includes("Waiting") && !s.log.includes("too old") ? `${waitingMessage(userId)}\n` : ""),
    steps: withPhases(s.steps),
    services: status === "running" ? s.urls.map(u => ({ name: u.name, port: u.port, primary: !!u.primary, enabled: true, manual: false, dir: "", url: u.url })) : [],
    deviceName: s.deviceName,
    waiting,
    waitingMessage: waiting ? waitingMessage(userId) : null,
  };
}

/** Test hook. */
export function _resetLocalPreviewsForTests() { states.clear(); savedAt.clear(); waiters.clear(); }
