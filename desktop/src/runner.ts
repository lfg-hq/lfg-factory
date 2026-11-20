/**
 * The LFG Desktop runner: connects out to the company's LFG server and carries out
 * coding jobs on this computer with the Claude Code login already here.
 *
 * Plain Node (no Electron imports), so it runs inside the desktop app, from the
 * headless CLI (cli.ts), and in tests.
 *
 * What it will do for a job, and nothing else:
 *   clone/fetch the repo with this computer's own Git credentials,
 *   check out the ticket branch in a separate worktree,
 *   run `claude -p` there with a local allow-list of tools,
 *   commit whatever changed and push the branch.
 * The server never sends shell commands, and every job can be declined.
 */

import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import os from "node:os";
import type { AgentEvent, AgentKind, ClaudeTaskPayload, PreviewUrl, RunnerJobOffer, RunnerToServer, ServerToRunner } from "./protocol.ts";
import { RUNNER_PROTOCOL_VERSION, isAgentEffort, isAgentModel } from "./protocol.ts";
import { LocalPreview, PreviewStopped, previewCommands, previewFolderName, validatePreviewPayload } from "./preview.ts";
import { AGENTS, detectAgents, runAgent } from "./agents.ts";
import { mustRun, run } from "./proc.ts";
import { previewBrowserStateFile, type PreviewState } from "./preview-browser.ts";

export type RunnerState = "connecting" | "connected" | "disconnected" | "unauthorized" | "stopped";

/** The browser-style subset of WebSocket that both `ws` and Bun implement. */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type SocketFactory = (url: string, headers: Record<string, string>) => SocketLike & { unauthorized?: boolean };

/** A build (or ticket follow-up) on a repository: the kind of job that asks first. */
export type BuildJobOffer = Extract<RunnerJobOffer, { type: "claude_task" }>;

/** Run the project's app on this computer for the Preview tab. */
export type PreviewJobOffer = Extract<RunnerJobOffer, { type: "preview" }>;

export type ApprovalResult = { approved: true } | { approved: false; reason?: string };

export interface RunnerOptions {
  serverUrl: string;
  token: string;
  /** Where repos and worktrees live, e.g. ~/LFG. */
  workRoot: string;
  createSocket: SocketFactory;
  /** Ask the person whether to run this job. */
  approve(job: BuildJobOffer): Promise<ApprovalResult>;
  /** Ask the person whether to run this app's commands for a preview. Absent: previews are declined. */
  approvePreview?(job: PreviewJobOffer, commands: string[]): Promise<ApprovalResult>;
  /** Docker Desktop is installed but stopped and a preview needs a database: ask to start it. */
  askStartDocker?(info: { projectName: string; engine: string }): Promise<boolean>;
  /** Ask before downloading a Node.js a preview needs. */
  approveNodeDownload?(info: { projectName: string; version: string; reason: string; folder: string }): Promise<boolean>;
  /** How long a preview's app gets to answer on its port. */
  previewStartTimeoutMs?: number;
  /** Claude Code tools this computer allows. A job can only narrow this list. */
  allowedTools?: string[];
  /** Override an agent's executable (tests, or a CLI outside PATH). */
  agentBins?: Partial<Record<AgentKind, string>>;
  /** Same as agentBins.claude. */
  claudeBin?: string;
  /** Environment for git/claude (a GUI app should pass the login shell's PATH). */
  env?: NodeJS.ProcessEnv;
  appVersion?: string;
  /** Tests only: accept file:// repository URLs. */
  allowLocalRepos?: boolean;
  /** Reconnect when the server has been silent this long (it pings every 25 s). Default 75 s. */
  livenessMs?: number;
  onState?(state: RunnerState, detail?: string): void;
  onJob?(event: { jobId: string; title: string; phase: "started" | "finished" | "failed" | "declined" | "cancelled"; detail?: string }): void;
  log?(line: string): void;
}

export const DEFAULT_ALLOWED_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "Bash"];

interface ActiveJob { cancelled: boolean; child?: ChildProcess }

export class Runner {
  private socket: (SocketLike & { unauthorized?: boolean }) | null = null;
  private stopped = false;
  private backoff = 1000;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private queue: BuildJobOffer[] = [];
  private busy = false;
  private agents: Array<{ kind: AgentKind; version: string }> | undefined;
  /** When the server was last heard from, and whether it pings (older servers don't). */
  private lastHeard = 0;
  private serverPings = false;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  readonly active = new Map<string, ActiveJob>();
  /** Running previews, one per project: project id → its job and processes. */
  private readonly previews = new Map<string, PreviewEntry>();
  /** Preview offers still being approved or waiting for the one they replace, and any cancelled meanwhile. */
  private readonly previewOffers = new Set<string>();
  private readonly cancelledOffers = new Set<string>();
  state: RunnerState = "disconnected";

  constructor(private readonly opts: RunnerOptions) {}

  /**
   * The previews running here, for the chat agent's preview browser (preview-browser.ts):
   * it may only open these addresses, and re-reads this file on every step.
   */
  private syncPreviewState() {
    const state: PreviewState = { previews: [...this.previews.entries()].filter(([, e]) => e.urls?.length && !e.stopping)
      .map(([project, e]) => ({ project, projectName: e.preview.payload.projectName, dir: e.preview.dir, urls: e.urls! })) };
    try {
      const file = previewBrowserStateFile(this.opts.workRoot);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file + ".tmp", JSON.stringify(state));
      renameSync(file + ".tmp", file);
    } catch (e) { this.log(`could not record running previews: ${(e as Error).message}`); }
  }

  start(): void {
    this.stopped = false;
    this.syncPreviewState(); // nothing runs yet: forget previews from an earlier session
    this.connect();
    // A connection can die without a close event (sleep, a new Wi-Fi address, a proxy
    // dropping it, the server restarting while the laptop was away). Silence from a
    // server that pings means it's gone: start over rather than wait forever.
    const liveness = this.opts.livenessMs ?? 75_000;
    this.watchdog ??= setInterval(() => {
      // Connected to a server that pings, or still trying to connect: silence means dead.
      const watched = this.serverPings || this.state !== "connected";
      if (this.socket && watched && Date.now() - this.lastHeard > liveness) this.reconnectNow("no word from the server");
    }, Math.min(15_000, Math.max(50, liveness / 3)));
  }

  /** Drop the current connection (it may be dead) and connect again now: on wake, a network change, or silence. */
  reconnectNow(reason = "reconnecting"): void {
    if (this.stopped) return;
    const old = this.socket;
    this.socket = null;
    if (old) {
      old.onopen = old.onmessage = old.onclose = old.onerror = null;
      try { old.close(4000, reason); } catch { /* already gone */ }
    }
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    this.log(`reconnecting: ${reason}`);
    this.setState("disconnected", reason);
    this.backoff = 1000;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
    if (this.retry) clearTimeout(this.retry);
    for (const job of this.active.values()) { job.cancelled = true; job.child?.kill("SIGTERM"); }
    for (const p of this.previews.values()) { p.stopping ??= p.preview.stop(); }
    this.syncPreviewState();
    this.socket?.close(1000, "Runner stopped");
    this.setState("stopped");
  }

  private setState(state: RunnerState, detail?: string) {
    this.state = state;
    this.opts.onState?.(state, detail);
  }

  private log(line: string) { this.opts.log?.(`[runner] ${line}`); }

  private send(message: RunnerToServer) {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(message));
  }

  private connect() {
    if (this.stopped) return;
    const url = this.opts.serverUrl.replace(/\/+$/, "").replace(/^http/, "ws") + "/ws/runner";
    this.setState("connecting");
    const socket = this.opts.createSocket(url, { Authorization: `Bearer ${this.opts.token}` });
    this.socket = socket;
    this.lastHeard = Date.now();
    this.serverPings = false;
    socket.onopen = async () => {
      this.agents ??= await detectAgents(this.opts.env ?? process.env, this.bins());
      const claude = this.agents.find(a => a.kind === "claude");
      this.send({ type: "hello", appVersion: this.opts.appVersion, platform: `${process.platform}-${process.arch}`, claudeVersion: claude?.version ?? null, agents: this.agents, activeJobIds: [...this.active.keys()], protocol: RUNNER_PROTOCOL_VERSION });
    };
    socket.onmessage = (ev) => { this.lastHeard = Date.now(); void this.handle(String(ev.data)); };
    socket.onerror = () => { /* onclose follows */ };
    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.stopped) return;
      if (socket.unauthorized || ev.code === 4001) {
        this.setState("unauthorized", "This computer's token was rejected. Pair it again from Settings → Computers.");
        return;
      }
      this.setState("disconnected", ev.reason || undefined);
      this.retry = setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    };
  }

  private async handle(raw: string) {
    let msg: ServerToRunner;
    try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.type) {
      case "welcome":
        this.backoff = 1000;
        this.setState("connected", msg.deviceName);
        return;
      case "ping":
        this.serverPings = true;
        this.send({ type: "pong" });
        return;
      case "error":
        this.log(`server: ${msg.message}`);
        return;
      case "job.cancel": {
        const job = this.active.get(msg.jobId);
        if (job) { job.cancelled = true; job.child?.kill("SIGTERM"); }
        if (this.previewOffers.has(msg.jobId)) this.cancelledOffers.add(msg.jobId);
        for (const [key, p] of this.previews) {
          if (p.jobId !== msg.jobId) continue;
          p.stopping ??= p.preview.stop();
          this.syncPreviewState();
          void p.stopping.then(() => { if (this.previews.get(key) === p) this.previews.delete(key); this.active.delete(p.jobId); this.syncPreviewState(); });
        }
        this.queue = this.queue.filter(j => j.id !== msg.jobId);
        return;
      }
      case "job.offer":
        if (this.active.has(msg.job.id) || this.previewOffers.has(msg.job.id) || this.queue.some(j => j.id === msg.job.id)) return;
        // Chat turns answer right away, alongside any build: they don't touch repositories.
        if (msg.job.type === "chat_turn") { void this.runChatTurn(msg.job); return; }
        // Previews run alongside builds, in their own folder.
        if (msg.job.type === "preview") { void this.runPreview(msg.job); return; }
        if (msg.job.type !== "claude_task") return;
        this.queue.push(msg.job);
        void this.drain();
        return;
    }
  }

  /** One job at a time: each one is a full Claude Code session. */
  private async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) await this.runOffer(this.queue.shift()!);
    } finally { this.busy = false; }
  }

  private async runOffer(job: BuildJobOffer) {
    const title = `${job.payload.ticketKey ? job.payload.ticketKey + " " : ""}${job.payload.ticketTitle}`;
    const agent: AgentKind = job.payload.agent ?? "claude";
    const problem = !AGENTS[agent] ? `This computer doesn't know the agent "${agent}". Update LFG Desktop.`
      : this.agents && !this.agents.some(a => a.kind === agent) ? `${AGENTS[agent].label} isn't installed on this computer. Install it and run \`${AGENTS[agent].bin}\` once to sign in.`
      : validatePayload(job.payload, !!this.opts.allowLocalRepos);
    if (problem) {
      this.send({ type: "job.rejected", jobId: job.id, reason: problem });
      this.opts.onJob?.({ jobId: job.id, title, phase: "declined", detail: problem });
      return;
    }
    const decision = await this.opts.approve(job).catch(() => ({ approved: false as const, reason: "Approval failed" }));
    if (!decision.approved) {
      this.send({ type: "job.rejected", jobId: job.id, reason: decision.reason ?? "Declined on this computer" });
      this.opts.onJob?.({ jobId: job.id, title, phase: "declined", detail: decision.reason });
      return;
    }
    const active: ActiveJob = { cancelled: false };
    this.active.set(job.id, active);
    this.send({ type: "job.accepted", jobId: job.id });
    this.opts.onJob?.({ jobId: job.id, title, phase: "started" });
    try {
      const result = await runAgentTask(job, active, {
        agent,
        bin: this.bins()[agent],
        workRoot: this.opts.workRoot,
        allowedTools: this.opts.allowedTools ?? DEFAULT_ALLOWED_TOOLS,
        env: this.opts.env ?? process.env,
        progress: text => this.send({ type: "job.progress", jobId: job.id, text }),
        agentEvent: event => this.send({ type: "job.event", jobId: job.id, event }),
      });
      if (active.cancelled) { this.opts.onJob?.({ jobId: job.id, title, phase: "cancelled" }); return; }
      this.send({ type: "job.finished", jobId: job.id, ok: true, ...result });
      this.opts.onJob?.({ jobId: job.id, title, phase: "finished", detail: result.commitSha ? `Pushed ${result.branch}` : "No changes" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (active.cancelled) { this.opts.onJob?.({ jobId: job.id, title, phase: "cancelled" }); return; }
      this.send({ type: "job.finished", jobId: job.id, ok: false, error: message.slice(0, 2000) });
      this.opts.onJob?.({ jobId: job.id, title, phase: "failed", detail: message });
    } finally {
      this.active.delete(job.id);
    }
  }

  /**
   * One chat turn: the chosen agent answers with LFG's tools (MCP) and read-only access to
   * a scratch folder. It can't edit files or run commands here, so it doesn't ask first.
   */
  private async runChatTurn(job: Extract<RunnerJobOffer, { type: "chat_turn" }>) {
    const p = job.payload;
    const agent = p.agent;
    const active: ActiveJob = { cancelled: false };
    this.active.set(job.id, active);
    this.send({ type: "job.accepted", jobId: job.id });
    const fail = (error: string) => this.send({ type: "job.finished", jobId: job.id, ok: false, error: error.slice(0, 2000) });
    try {
      if (!AGENTS[agent]) return fail(`This computer doesn't know the agent "${agent}". Update LFG Desktop.`);
      if (this.agents && !this.agents.some(a => a.kind === agent)) {
        return fail(`${AGENTS[agent].label} isn't installed on this computer. Install it and run \`${AGENTS[agent].bin}\` once to sign in, or pick another agent in Settings.`);
      }
      const cwd = join(this.opts.workRoot, "chats", p.conversationId.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 80));
      mkdirSync(cwd, { recursive: true });
      const model = isAgentModel(p.model) ? p.model : undefined;
      const effort = isAgentEffort(p.effort) ? p.effort : undefined;
      const browser = this.previewBrowserFor(p.projectId);
      const attempt = (sessionId?: string) => runAgent(agent, {
        // No session to continue here: the fuller prompt carries the conversation so far.
        prompt: sessionId ? p.prompt : p.freshPrompt || p.prompt,
        instructions: p.instructions, instructionsMode: p.instructionsMode === "replace" ? "replace" : "append",
        model, effort, sessionId, mcp: p.mcp, readOnly: true, cwd,
        ...(browser ? { localMcp: browser.mcp, addDirs: browser.dirs } : {}),
        env: this.opts.env ?? process.env, bin: this.bins()[agent],
        onEvent: event => this.send({ type: "job.event", jobId: job.id, event }),
        onSpawn: child => { active.child = child; },
      }).finally(() => { active.child = undefined; });
      const result = await attempt(p.sessionId).catch((error: Error) => {
        if (active.cancelled || !p.sessionId) throw error;
        return attempt(undefined); // the session lives elsewhere or expired: answer fresh
      });
      if (!active.cancelled) this.send({ type: "job.finished", jobId: job.id, ok: true, summary: result.summary, sessionId: result.sessionId });
    } catch (error) {
      if (!active.cancelled) fail(error instanceof Error ? error.message : String(error));
    } finally {
      this.active.delete(job.id);
    }
  }

  /**
   * Run a project's app here for the Preview tab, until it's stopped or replaced. Its
   * progress, log and http://localhost address go back as job.preview updates.
   */
  private async runPreview(job: PreviewJobOffer) {
    this.previewOffers.add(job.id);
    try { await this.runPreviewOffer(job); } finally { this.previewOffers.delete(job.id); this.cancelledOffers.delete(job.id); }
  }

  private async runPreviewOffer(job: PreviewJobOffer) {
    const p = job.payload;
    const title = `Preview: ${p.projectName}`;
    const decline = (reason: string) => {
      this.send({ type: "job.rejected", jobId: job.id, reason });
      this.opts.onJob?.({ jobId: job.id, title, phase: "declined", detail: reason });
    };
    const problem = validatePreviewPayload(p, !!this.opts.allowLocalRepos);
    if (problem) return decline(problem);
    if (!this.opts.approvePreview) return decline("This computer doesn't run previews.");
    const decision = await this.opts.approvePreview(job, previewCommands(p.plan)).catch(() => ({ approved: false as const, reason: "Approval failed" }));
    if (!decision.approved) return decline(decision.reason ?? "Declined on this computer");

    // One preview per project here: the one it replaces must be gone (ports, files) first.
    const key = previewFolderName(p.projectId);
    const previous = this.previews.get(key);
    if (previous) { const stopping = previous.stopping ??= previous.preview.stop(); this.syncPreviewState(); await stopping; this.active.delete(previous.jobId); }
    if (this.cancelledOffers.has(job.id)) return; // stopped or replaced while the person was deciding

    const active: ActiveJob = { cancelled: false };
    this.active.set(job.id, active);
    this.send({ type: "job.accepted", jobId: job.id });
    const preview = new LocalPreview(p, {
      workRoot: this.opts.workRoot,
      env: this.opts.env ?? process.env,
      allowLocalRepos: this.opts.allowLocalRepos,
      startTimeoutMs: this.opts.previewStartTimeoutMs,
      askStartDocker: this.opts.askStartDocker ? info => this.opts.askStartDocker!({ ...info, projectName: p.projectName }) : undefined,
      approveNodeDownload: this.opts.approveNodeDownload ? info => this.opts.approveNodeDownload!({ ...info, projectName: p.projectName }) : undefined,
      update: update => this.send({ type: "job.preview", jobId: job.id, update }),
    });
    const entry: PreviewEntry = { jobId: job.id, preview };
    this.previews.set(key, entry);
    const current = () => this.previews.get(key) === entry && !active.cancelled;
    const finish = (error: string) => {
      if (this.previews.get(key) === entry) this.previews.delete(key);
      this.syncPreviewState();
      this.active.delete(job.id);
      if (active.cancelled) return;
      this.send({ type: "job.preview", jobId: job.id, update: { status: "error", error: error.slice(0, 2000) } });
      this.send({ type: "job.finished", jobId: job.id, ok: false, error: error.slice(0, 2000) });
      this.opts.onJob?.({ jobId: job.id, title, phase: "failed", detail: error });
    };
    preview.onExit(error => { if (current()) { void preview.stop(); finish(error); } });
    try {
      const urls = await preview.start();
      if (!current()) { await preview.stop(); return; }
      entry.urls = urls;
      this.syncPreviewState();
      this.opts.onJob?.({ jobId: job.id, title, phase: "started", detail: `Running at ${urls.map(u => u.url).join(", ")}` });
    } catch (error) {
      await (entry.stopping ??= preview.stop());
      if (error instanceof PreviewStopped || active.cancelled) {
        if (this.previews.get(key) === entry) this.previews.delete(key);
        this.syncPreviewState();
        this.active.delete(job.id);
        return;
      }
      finish(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * The preview browser for a chat turn (Claude Code): an MCP server on this computer that
   * can open only the previews running here — the turn's project's when the server says
   * which project it is — plus read access to those previews' code.
   */
  private previewBrowserFor(projectId: string | undefined) {
    const key = projectId ? previewFolderName(projectId) : undefined;
    this.syncPreviewState();
    const running = [...this.previews.entries()].filter(([k, e]) => (!key || k === key) && e.urls?.length && !e.stopping);
    return {
      mcp: {
        preview: {
          command: process.execPath,
          args: [PREVIEW_BROWSER_SCRIPT],
          env: {
            ELECTRON_RUN_AS_NODE: "1",
            LFG_PREVIEW_STATE: previewBrowserStateFile(this.opts.workRoot),
            ...(key ? { LFG_PREVIEW_PROJECT: key } : {}),
            LFG_PREVIEW_PROFILE: join(this.opts.workRoot, "preview-browser", key ?? "default"),
          },
        },
      },
      dirs: running.map(([, e]) => e.preview.dir).filter(d => existsSync(d)),
    };
  }

  private bins(): Partial<Record<AgentKind, string>> {
    return { ...(this.opts.claudeBin ? { claude: this.opts.claudeBin } : {}), ...this.opts.agentBins };
  }
}

interface PreviewEntry { jobId: string; preview: LocalPreview; stopping?: Promise<void>; urls?: PreviewUrl[] }

const PREVIEW_BROWSER_SCRIPT = fileURLToPath(new URL("./preview-browser.js", import.meta.url));

// ── Job execution ────────────────────────────────────────────────────

const REF = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._\/-]{1,200}$/;

export function validatePayload(p: ClaudeTaskPayload, allowLocalRepos: boolean): string | null {
  if (!p || typeof p.prompt !== "string" || !p.prompt.trim()) return "The job has no instructions.";
  if (!REF.test(p.branch) || !p.startFrom?.length || !p.startFrom.every(b => REF.test(b))) return "The job names an invalid branch.";
  const okRemote = /^(https:\/\/|ssh:\/\/|git@[\w.-]+:)/.test(p.repoUrl) || (allowLocalRepos && p.repoUrl.startsWith("file://"));
  if (!okRemote || p.repoUrl.startsWith("-")) return "The job's repository URL isn't one this computer will clone.";
  return null;
}

interface TaskContext {
  workRoot: string;
  agent: AgentKind;
  bin?: string;
  allowedTools: string[];
  env: NodeJS.ProcessEnv;
  progress(text: string): void;
  agentEvent(event: AgentEvent): void;
}

export async function runAgentTask(job: BuildJobOffer, active: ActiveJob, ctx: TaskContext)
  : Promise<{ branch: string; commitSha: string | null; summary?: string; mergeSha?: string; mergeError?: string }> {
  const p = job.payload;
  const repoDir = join(ctx.workRoot, "repos", createHash("sha1").update(p.repoUrl).digest("hex").slice(0, 12));
  const worktree = join(ctx.workRoot, "worktrees", p.branch.replace(/[^A-Za-z0-9._-]+/g, "-"));
  const git = (args: string[], cwd = repoDir) => mustRun("git", args, { cwd, env: ctx.env, timeoutMs: 10 * 60_000 }, `git ${args[0]}`);
  const check = () => { if (active.cancelled) throw new Error("Cancelled"); };

  mkdirSync(join(ctx.workRoot, "repos"), { recursive: true });
  mkdirSync(join(ctx.workRoot, "worktrees"), { recursive: true });
  if (!existsSync(join(repoDir, ".git"))) {
    ctx.progress(`Cloning ${p.repoUrl}…`);
    await mustRun("git", ["clone", "--", p.repoUrl, repoDir], { env: ctx.env, timeoutMs: 30 * 60_000 }, "git clone");
  } else {
    ctx.progress("Fetching the latest changes…");
  }
  await git(["fetch", "--prune", "origin"]);
  check();

  const remoteHas = async (b: string) => (await run("git", ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${b}`], { cwd: repoDir, env: ctx.env })).code === 0;
  let start: string | null = null;
  if (await remoteHas(p.branch)) start = `origin/${p.branch}`;
  else for (const b of p.startFrom) if (await remoteHas(b)) { start = `origin/${b}`; break; }
  if (!start) throw new Error(`None of these branches exist on the remote: ${[p.branch, ...p.startFrom].join(", ")}`);

  // A fresh worktree each time: the previous run's work is already pushed.
  if (existsSync(worktree)) {
    await run("git", ["worktree", "remove", "--force", worktree], { cwd: repoDir, env: ctx.env });
    rmSync(worktree, { recursive: true, force: true });
  }
  await git(["worktree", "prune"]);
  ctx.progress(`Checking out ${p.branch} from ${start}…`);
  await git(["worktree", "add", "-B", p.branch, worktree, start]);
  const base = (await git(["rev-parse", "HEAD"], worktree)).trim();
  check();

  const tools = (p.allowedTools?.length ? p.allowedTools.filter(t => ctx.allowedTools.includes(t)) : ctx.allowedTools);
  ctx.progress(`Starting ${AGENTS[ctx.agent].label}…`);
  const attempt = (sessionId?: string) => runAgent(ctx.agent, {
    prompt: p.prompt, cwd: worktree, sessionId, allowedTools: tools, maxTurns: p.maxTurns, env: ctx.env, bin: ctx.bin,
    model: isAgentModel(p.model) ? p.model : undefined, effort: isAgentEffort(p.effort) ? p.effort : undefined,
    onEvent: ctx.agentEvent,
    onSpawn: child => { active.child = child; },
  }).finally(() => { active.child = undefined; });
  const { summary } = await attempt(p.sessionId).catch(async (error: Error) => {
    if (active.cancelled) throw new Error("Cancelled");
    if (!p.sessionId) throw error;
    // The earlier session may live on another computer, or have expired: start fresh.
    ctx.progress("Couldn't continue the earlier session here; starting a fresh one.");
    return attempt(undefined).catch((e: Error) => { throw active.cancelled ? new Error("Cancelled") : e; });
  });
  check();

  const identity = (await run("git", ["config", "user.email"], { cwd: worktree, env: ctx.env })).stdout.trim()
    ? [] : ["-c", "user.name=LFG Desktop", "-c", "user.email=lfg-desktop@localhost"];
  if ((await git(["status", "--porcelain"], worktree)).trim()) {
    await git(["add", "-A"], worktree);
    await git([...identity, "commit", "-m", p.commitMessage || "LFG Desktop changes"], worktree);
  }
  const head = (await git(["rev-parse", "HEAD"], worktree)).trim();
  let commitSha: string | null = null;
  if (head !== base) {
    check();
    ctx.progress(`Pushing ${p.branch}…`);
    await git(["push", "-u", "origin", `HEAD:refs/heads/${p.branch}`], worktree);
    commitSha = head;
  }
  // Land the ticket branch on its epic branch, like a cloud build does. Runs even
  // when this run changed nothing, so earlier unmerged work on the branch lands too.
  const merge = await mergeIntoTarget(p, { ...ctx, repoDir, identity, check, tools });
  return { branch: p.branch, commitSha, summary, ...merge };
}

/** Merge the pushed ticket branch into `p.mergeInto` and push it. Conflicts go to the agent once. */
export async function mergeIntoTarget(p: ClaudeTaskPayload, ctx: TaskContext & {
  repoDir: string; identity: string[]; check(): void; tools: string[];
}): Promise<{ mergeSha?: string; mergeError?: string }> {
  const target = p.mergeInto;
  if (!target || target === p.branch || !REF.test(target)) return {};
  const git = (args: string[], cwd = ctx.repoDir) => mustRun("git", args, { cwd, env: ctx.env, timeoutMs: 10 * 60_000 }, `git ${args[0]}`);
  const tryGit = (args: string[], cwd: string) => run("git", args, { cwd, env: ctx.env, timeoutMs: 10 * 60_000 });
  const source = `refs/remotes/origin/${p.branch}`;
  const wt = join(ctx.workRoot, "worktrees", `merge-${target.replace(/[^A-Za-z0-9._-]+/g, "-")}`);
  const dropWorktree = async () => {
    if (existsSync(wt)) await run("git", ["worktree", "remove", "--force", wt], { cwd: ctx.repoDir, env: ctx.env });
    rmSync(wt, { recursive: true, force: true });
    await run("git", ["worktree", "prune"], { cwd: ctx.repoDir, env: ctx.env });
  };
  try {
    // The target can move while we merge (another ticket landing): fetch and retry once.
    for (let round = 0; round < 2; round++) {
      ctx.check();
      await git(["fetch", "--prune", "origin"]);
      if ((await tryGit(["rev-parse", "--verify", "--quiet", source], ctx.repoDir)).code !== 0) return {};
      const targetRef = `refs/remotes/origin/${target}`;
      const targetExists = (await tryGit(["rev-parse", "--verify", "--quiet", targetRef], ctx.repoDir)).code === 0;
      if (targetExists && (await tryGit(["merge-base", "--is-ancestor", source, targetRef], ctx.repoDir)).code === 0) {
        return { mergeSha: (await git(["rev-parse", targetRef])).trim() }; // already on the epic branch
      }
      await dropWorktree();
      // A missing epic branch starts as the ticket branch (which was cut from the epic's base).
      await git(["worktree", "add", "--detach", wt, targetExists ? targetRef : source]);
      if (targetExists) {
        ctx.progress(`Merging ${p.branch} into ${target}…`);
        const merged = await tryGit([...ctx.identity, "merge", "--no-ff", "-m", `Merge ${p.branch} into ${target}`, source], wt);
        if (merged.code !== 0) {
          const conflicts = (await tryGit(["diff", "--name-only", "--diff-filter=U"], wt)).stdout.trim();
          if (!conflicts) throw new Error(`git merge failed: ${(merged.stderr || merged.stdout).trim().slice(0, 300)}`);
          ctx.progress(`Merge conflicts in ${conflicts.split("\n").join(", ")}. Asking ${AGENTS[ctx.agent].label} to resolve them…`);
          await runAgent(ctx.agent, {
            prompt: [
              `Merging ticket branch ${p.branch} into ${target} hit conflicts in:`, conflicts, "",
              "Resolve every conflict so both sides' intent is kept, remove all conflict markers, and make sure the code still builds.",
              "Do not commit, push, abort the merge or switch branches. LFG Desktop finishes the merge.",
            ].join("\n"),
            cwd: wt, allowedTools: ctx.tools, maxTurns: 40, env: ctx.env, bin: ctx.bin,
            onEvent: ctx.agentEvent,
          });
          ctx.check();
          await git(["add", "-A"], wt);
          const left = (await tryGit(["diff", "--cached", "--name-only", "-G", "^(<<<<<<<|>>>>>>>) ", "HEAD"], wt)).stdout.trim();
          if (left) { await tryGit(["merge", "--abort"], wt); throw new Error(`conflicts left unresolved in ${left.split("\n").join(", ")}`); }
          await git([...ctx.identity, "commit", "--no-edit"], wt);
        }
      }
      ctx.check();
      ctx.progress(`Pushing ${target}…`);
      const pushed = await tryGit(["push", "origin", `HEAD:refs/heads/${target}`], wt);
      if (pushed.code === 0) return { mergeSha: (await git(["rev-parse", "HEAD"], wt)).trim() };
      if (round === 1) throw new Error(`push to ${target} was rejected: ${(pushed.stderr || pushed.stdout).trim().slice(0, 300)}`);
    }
    return {};
  } catch (error) {
    if ((error as Error).message === "Cancelled") throw error;
    return { mergeError: `Couldn't merge ${p.branch} into ${target}: ${(error as Error).message}` };
  } finally {
    await dropWorktree().catch(() => {});
  }
}

export { run } from "./proc.ts";

export const defaultWorkRoot = () => join(os.homedir(), "LFG");
