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
import { existsSync, mkdirSync, rmSync, writeFileSync, renameSync, readdirSync, statSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import os from "node:os";
import type { AgentEvent, AgentKind, ClaudeTaskPayload, PreviewUrl, RunnerJobOffer, RunnerToServer, ServerToRunner } from "./protocol.ts";
import { RUNNER_PROTOCOL_VERSION, isAgentEffort, isAgentModel } from "./protocol.ts";
import { LocalPreview, PreviewStopped, dependencyFingerprint, previewCommands, previewFolderName, validatePreviewPayload } from "./preview.ts";
import { AGENTS, detectAgents, runAgent } from "./agents.ts";
import { mustRun, run } from "./proc.ts";
import { PREVIEW_DATA_PROGRAM } from "./preview-data-program.ts";
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
export type PreviewDataJobOffer = Extract<RunnerJobOffer, { type: "preview_data" }>;

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
  /** Optional extra check before a data operation on a preview running here (none by default). */
  approvePreviewData?(job: PreviewDataJobOffer): Promise<ApprovalResult>;
  /** Docker Desktop is installed but stopped and a preview needs a database: ask to start it. */
  askStartDocker?(info: { projectName: string; engine: string }): Promise<boolean>;
  /** Ask before downloading a Node.js a preview needs. */
  approveNodeDownload?(info: { projectName: string; version: string; reason: string; folder: string }): Promise<boolean>;
  /** How long a preview's app gets to answer on its port. */
  previewStartTimeoutMs?: number;
  /** Claude Code tools this computer allows. A job can only narrow this list. */
  allowedTools?: string[];
  /** Builds run at once (each a full agent session and test run). Default: 3, fewer on a small machine. */
  maxParallel?: number;
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
  /** An agent started or stopped working here (builds and chat turns, not previews): the app keeps the computer awake meanwhile. */
  onBusy?(busy: boolean): void;
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
  private agents: Array<{ kind: AgentKind; version: string }> | undefined;
  /** When the server was last heard from, and whether it pings (older servers don't). */
  private lastHeard = 0;
  private serverPings = false;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  readonly active = new Map<string, ActiveJob>();
  /** Agents working right now (previews aside). */
  private working = 0;
  private markWorking(delta: 1 | -1) {
    const before = this.working > 0;
    this.working = Math.max(0, this.working + delta);
    if (before !== this.working > 0) this.opts.onBusy?.(this.working > 0);
  }
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
        // Updates sent while disconnected were lost, and the server may have given these up
        // for dead: report each preview still running here, so LFG shows it again.
        for (const e of this.previews.values()) {
          if (!e.urls?.length || e.stopping) continue;
          this.send({ type: "job.preview", jobId: e.jobId, update: { status: "running", urls: e.urls, error: "", steps: e.preview.currentSteps(), lines: ["Reconnected to LFG; the app kept running on this computer."] } });
        }
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
        // Data operations on a running preview: short, alongside everything else.
        if (msg.job.type === "preview_data") { void this.runPreviewData(msg.job); return; }
        if (msg.job.type !== "claude_task") return;
        this.queue.push(msg.job);
        void this.drain();
        return;
    }
  }

  /** Builds running now. Several at once, each in its own worktree; git steps on a shared clone take turns. */
  private building = 0;
  private parallel(): number {
    const fromEnv = Number(this.opts.env?.LFG_MAX_PARALLEL_BUILDS ?? process.env.LFG_MAX_PARALLEL_BUILDS);
    if (Number.isFinite(fromEnv) && fromEnv >= 1) return Math.min(8, Math.floor(fromEnv));
    if (this.opts.maxParallel) return this.opts.maxParallel;
    // Each build is an agent plus the project's test runs: about 5 GB apiece to stay comfortable.
    return Math.max(1, Math.min(3, Math.floor(os.totalmem() / (5 * 1024 ** 3))));
  }
  private drain() {
    while (this.queue.length && this.building < this.parallel()) {
      const job = this.queue.shift()!;
      this.building++;
      void this.runOffer(job).catch(() => {}).finally(() => { this.building--; this.drain(); });
    }
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
    this.markWorking(1);
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
        uploadWalkthrough: (report, frames) => this.uploadWalkthrough(job.id, report, frames),
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
      this.markWorking(-1);
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
    this.markWorking(1);
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
      this.markWorking(-1);
    }
  }

  /**
   * One step of a preview data operation (inspect code, query or change the database, hash a
   * test password, verify a login) on a preview running here. The server sends only the input;
   * this computer runs its own copy of LFG's fixed data program in the preview's folder, with
   * the preview's own database settings.
   */
  private async runPreviewData(job: PreviewDataJobOffer) {
    const p = job.payload;
    const reject = (reason: string) => this.send({ type: "job.rejected", jobId: job.id, reason });
    if (!p || typeof p.projectId !== "string" || !p.input || typeof p.input !== "object" || Array.isArray(p.input)) return reject("The data request is malformed.");
    const target = this.previews.get(previewFolderName(p.projectId))?.preview.dataTarget();
    if (!target) return reject("That preview isn't running on this computer.");
    // No separate prompt: the person approved running this preview here, and this only runs
    // LFG's own fixed data program against that preview's own local database.
    if (this.opts.approvePreviewData) {
      const decision = await this.opts.approvePreviewData(job).catch(() => ({ approved: false as const, reason: "Approval failed" }));
      if (!decision.approved) return reject(decision.reason ?? "Declined on this computer");
    }
    this.send({ type: "job.accepted", jobId: job.id });
    try {
      const data = Buffer.from(JSON.stringify(p.input)).toString("base64");
      const r = await run("node", ["-e", PREVIEW_DATA_PROGRAM, data], { cwd: target.dir, env: target.env, timeoutMs: 60_000 });
      const output = (r.stdout + r.stderr).slice(-12_000);
      this.send({ type: "job.finished", jobId: job.id, ok: true, summary: JSON.stringify({ exitCode: r.code, output }) });
    } catch (error) {
      this.send({ type: "job.finished", jobId: job.id, ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 2000) });
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

  /** POST the walkthrough to LFG over HTTPS with this computer's token (a video is too big for the socket). */
  private async uploadWalkthrough(jobId: string, report: WalkthroughReport, framesFile: string | null): Promise<void> {
    const form = new FormData();
    form.set("report", JSON.stringify(report));
    if (framesFile) form.set("frames", new Blob([readFileSync(framesFile)], { type: "application/octet-stream" }), "frames.mjpeg");
    const url = `${this.opts.serverUrl.replace(/\/+$/, "")}/api/runner/jobs/${encodeURIComponent(jobId)}/walkthrough`;
    const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${this.opts.token}` }, body: form, signal: AbortSignal.timeout(5 * 60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
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

// ── Installed packages shared between tickets ────────────────────────
// Copied with the file system's clone (APFS clonefile on a Mac, reflinks elsewhere when
// supported), so a copy takes seconds and almost no disk space.
const cloneArgs = (from: string, to: string) => process.platform === "darwin" ? ["-cR", from, to] : ["-R", "--reflink=auto", from, to];

/** Put cached node_modules into a fresh worktree. True when it did. */
export async function restorePackages(cache: string, worktree: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const from = join(cache, "node_modules"), to = join(worktree, "node_modules");
  if (!existsSync(from) || existsSync(to)) return false;
  const copied = await run("cp", cloneArgs(from, to), { env, timeoutMs: 5 * 60_000 });
  if (copied.code !== 0) { rmSync(to, { recursive: true, force: true }); return false; }
  return true;
}

/** Keep this worktree's node_modules for later tickets, when its package files are unchanged. */
export async function savePackages(worktree: string, cache: string, key: string, env: NodeJS.ProcessEnv): Promise<void> {
  const from = join(worktree, "node_modules");
  if (!existsSync(from) || existsSync(join(cache, "node_modules"))) return;
  // The agent changed the package files: these packages belong to a different fingerprint.
  if (await dependencyFingerprint(worktree, "ticket-build", null, env).catch(() => null) !== key) return;
  const tmp = cache + ".tmp-" + process.pid + "-" + Math.random().toString(36).slice(2, 8);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const copied = await run("cp", cloneArgs(from, join(tmp, "node_modules")), { env, timeoutMs: 5 * 60_000 });
  if (copied.code !== 0) { rmSync(tmp, { recursive: true, force: true }); return; }
  rmSync(cache, { recursive: true, force: true });
  renameSync(tmp, cache);
  // Keep the three most recent package sets per repository.
  const parent = join(cache, "..");
  const sets = readdirSync(parent).filter(n => !n.includes(".tmp-")).map(n => ({ n, t: statSync(join(parent, n)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const old of sets.slice(3)) rmSync(join(parent, old.n), { recursive: true, force: true });
}

const isOutOfSteps = (e: unknown) => /error_max_turns|max(imum)?[ _-]?turns/i.test(String((e as Error)?.message ?? e));
const FINISH_PROMPT = [
  "You reached the step limit for this run. Finish the ticket now in as few steps as possible:",
  "- complete any change that is still half done;",
  "- rerun only the tests that failed or that cover what you just changed, not the full suite again;",
  "- then stop and end with a short summary of what you changed and anything left undone.",
  "Do not commit, push or switch branches. LFG Desktop commits and pushes your changes when you finish.",
].join("\n");

interface TaskContext {
  workRoot: string;
  agent: AgentKind;
  bin?: string;
  allowedTools: string[];
  env: NodeJS.ProcessEnv;
  progress(text: string): void;
  agentEvent(event: AgentEvent): void;
  /** Send the walkthrough (its checks, and the recorded frames when there are any) to LFG. */
  uploadWalkthrough?(report: WalkthroughReport, framesFile: string | null): Promise<void>;
}

/** What the agent saw when it walked through the ticket in the browser. */
export interface WalkthroughReport {
  applicable: boolean;
  reason?: string;
  checks: Array<{ label: string; status: "passed" | "failed"; expected?: string; actual?: string }>;
}

// Builds of the same repository share its clone: one git step at a time there, while
// the agents themselves work side by side in their own worktrees.
const repoLocks = new Map<string, Promise<unknown>>();
export function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (repoLocks.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
  const tail = next.catch(() => {});
  repoLocks.set(key, tail);
  void tail.then(() => { if (repoLocks.get(key) === tail) repoLocks.delete(key); });
  return next;
}

export const WALKTHROUGH_PROMPT = [
  "The build is saved. Now show that the ticket works, the way a person would check it: in the browser.",
  "1. Start the app from this folder on a free port of its own (other tickets may be running apps on this computer; don't use the default port if it's taken). Use the project's own dev or start command and any local database or seed it needs for testing. Start it from a normal shell command with `nohup … > app.log 2>&1 &` and note its PID, not as a background task of yours: a background task that ends later would wake you after you've reported. Wait until it answers.",
  "2. Use the browser tool to open the app at its full http://localhost:<port> address. The browser is being recorded for the ticket's reviewers, so move at a person's pace: sign in if needed, then go through each acceptance criterion, doing what a user would do and checking what appears.",
  "3. Don't change the code now. If something doesn't work, record it as failed with what you saw.",
  "4. Stop the app you started.",
  "End your reply with one JSON block, and nothing after it:",
  "```json",
  '{"applicable": true, "checks": [{"label": "<the acceptance criterion, short>", "status": "passed" | "failed", "expected": "<what should happen>", "actual": "<what you saw>"}]}',
  "```",
  'If this ticket has nothing a person could see or do in a browser (a pure backend, data or tooling change), don\'t start anything: reply with {"applicable": false, "reason": "<one sentence>", "checks": []}.',
].join("\n");

/** The JSON block at the end of the walkthrough reply. */
export function parseWalkthrough(text: string | string[] | undefined): WalkthroughReport | null {
  // Every message the agent wrote, newest first: its report may not be its very last word
  // (a notification can wake it again afterwards, and it answers that instead).
  if (Array.isArray(text)) {
    for (const t of [...text].reverse()) { const r = parseWalkthrough(t); if (r) return r; }
    return null;
  }
  if (!text || !text.includes('"applicable"') && !text.includes('"checks"')) return null;
  const blocks = [...text.matchAll(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/g)].map(m => m[1]!);
  const raw = blocks.at(-1) ?? text.slice(text.lastIndexOf('{"applicable"'));
  try {
    const j = JSON.parse(raw) as Partial<WalkthroughReport>;
    const checks = (Array.isArray(j.checks) ? j.checks : []).slice(0, 30).flatMap(c => c && typeof c.label === "string" ? [{
      label: c.label.slice(0, 300), status: c.status === "passed" ? "passed" as const : "failed" as const,
      ...(typeof c.expected === "string" ? { expected: c.expected.slice(0, 600) } : {}),
      ...(typeof c.actual === "string" ? { actual: c.actual.slice(0, 600) } : {}),
    }] : []);
    return { applicable: j.applicable !== false, ...(typeof j.reason === "string" ? { reason: j.reason.slice(0, 300) } : {}), checks };
  } catch { return null; }
}

/** Apps the walkthrough left listening, started from inside this worktree: stop them. */
async function stopAppsFrom(worktree: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32") return;
  const listening = await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-t"], { env, timeoutMs: 15_000 }).catch(() => null);
  for (const pid of new Set((listening?.stdout ?? "").split("\n").map(s => s.trim()).filter(Boolean))) {
    const cwd = await run("lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"], { env, timeoutMs: 10_000 }).catch(() => null);
    const dir = (cwd?.stdout ?? "").split("\n").find(l => l.startsWith("n"))?.slice(1);
    if (dir && (dir === worktree || dir.startsWith(worktree + "/"))) { try { process.kill(Number(pid), "SIGTERM"); } catch { /* gone */ } }
  }
}

/**
 * After a build: the agent starts the app and goes through the acceptance criteria in a
 * recorded browser. Never fails the build; what it found goes to the ticket as feature testing.
 */
async function recordWalkthrough(job: BuildJobOffer, active: ActiveJob, ctx: TaskContext, worktree: string, sessionId: string, tools: string[]) {
  if (!ctx.uploadWalkthrough) return;
  const p = job.payload;
  const dir = join(ctx.workRoot, "recordings");
  mkdirSync(dir, { recursive: true });
  const frames = join(dir, `${job.id}.mjpeg`);
  rmSync(frames, { force: true });
  ctx.progress("Feature testing: starting the app on this computer and walking through the acceptance criteria in a recorded browser…");
  let report: WalkthroughReport | null = null;
  const said: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      runAgent(ctx.agent, {
        prompt: WALKTHROUGH_PROMPT, cwd: worktree, sessionId, allowedTools: tools, maxTurns: 60, env: ctx.env, bin: ctx.bin,
        model: isAgentModel(p.model) ? p.model : undefined, effort: "low",
        localMcp: { preview: { command: process.execPath, args: [PREVIEW_BROWSER_SCRIPT], env: {
          ELECTRON_RUN_AS_NODE: "1", LFG_BROWSER_ANY_LOCAL: "1", LFG_BROWSER_RECORD: frames,
          LFG_PREVIEW_PROFILE: join(dir, `profile-${job.id}`),
        } } },
        onEvent: event => { if (event.type === "text") said.push(event.text); else if (event.type === "result" && event.text) said.push(event.text); ctx.agentEvent(event); },
        onSpawn: child => { active.child = child; },
      }).finally(() => { active.child = undefined; }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { active.child?.kill("SIGTERM"); reject(new Error("The walkthrough took longer than 15 minutes.")); }, 15 * 60_000); }),
    ]);
    report = parseWalkthrough([...said, result.summary ?? ""]) ?? { applicable: true, checks: [], reason: "The agent didn't report its checks." };
  } catch (error) {
    if (active.cancelled) return;
    report = parseWalkthrough(said) ?? { applicable: true, checks: [], reason: `The walkthrough didn't finish: ${(error as Error).message.slice(0, 300)}` };
  } finally {
    clearTimeout(timer);
    await stopAppsFrom(worktree, ctx.env).catch(() => {});
    rmSync(join(dir, `profile-${job.id}`), { recursive: true, force: true });
  }
  const hasFrames = existsSync(frames) && statSync(frames).size > 0;
  await ctx.uploadWalkthrough(report, hasFrames ? frames : null)
    .catch(e => ctx.progress(`Feature testing: couldn't send the recording to LFG (${(e as Error).message.slice(0, 200)}).`));
  rmSync(frames, { force: true });
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
  const base = await withRepoLock(repoDir, async () => {
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
  return (await git(["rev-parse", "HEAD"], worktree)).trim();
  });
  check();

  // Installed packages from an earlier ticket with the same package files: a fresh
  // worktree has none, and reinstalling cost each ticket about a minute.
  const depsDir = join(ctx.workRoot, "deps", createHash("sha1").update(p.repoUrl).digest("hex").slice(0, 12));
  const depsKey = await dependencyFingerprint(worktree, "ticket-build", null, ctx.env).catch(() => null);
  if (depsKey && await restorePackages(join(depsDir, depsKey), worktree, ctx.env)) ctx.progress("Reused installed packages from an earlier ticket.");
  check();

  const tools = (p.allowedTools?.length ? p.allowedTools.filter(t => ctx.allowedTools.includes(t)) : ctx.allowedTools);
  ctx.progress(`Starting ${AGENTS[ctx.agent].label}…`);
  const attempt = (sessionId?: string) => runAgent(ctx.agent, {
    prompt: p.prompt, cwd: worktree, sessionId, allowedTools: tools, maxTurns: p.maxTurns, env: ctx.env, bin: ctx.bin,
    model: isAgentModel(p.model) ? p.model : undefined, effort: isAgentEffort(p.effort) ? p.effort : undefined,
    onEvent: ctx.agentEvent,
    onSpawn: child => { active.child = child; },
  }).finally(() => { active.child = undefined; });
  const first = attempt(p.sessionId).catch(async (error: Error) => {
    if (active.cancelled) throw new Error("Cancelled");
    if (!p.sessionId || isOutOfSteps(error)) throw error;
    // The earlier session may live on another computer, or have expired: start fresh.
    ctx.progress("Couldn't continue the earlier session here; starting a fresh one.");
    return attempt(undefined).catch((e: Error) => { throw active.cancelled ? new Error("Cancelled") : e; });
  });
  // Out of steps near the end loses everything, since nothing is committed until the agent
  // finishes. Continue the same session once, briefly, to finish and summarise.
  const finished = first.catch(async (error: Error & { sessionId?: string }) => {
    if (active.cancelled) throw new Error("Cancelled");
    if (!isOutOfSteps(error) || !error.sessionId) throw error;
    ctx.progress(`${AGENTS[ctx.agent].label} reached its step limit; continuing once to finish the ticket…`);
    return runAgent(ctx.agent, {
      prompt: FINISH_PROMPT, cwd: worktree, sessionId: error.sessionId, allowedTools: tools, maxTurns: 40, env: ctx.env, bin: ctx.bin,
      model: isAgentModel(p.model) ? p.model : undefined, effort: isAgentEffort(p.effort) ? p.effort : undefined,
      onEvent: ctx.agentEvent,
      onSpawn: child => { active.child = child; },
    }).finally(() => { active.child = undefined; }).catch((e: Error) => { throw active.cancelled ? new Error("Cancelled") : e; });
  });
  // Keep what the agent installed for the next ticket, whether or not this one finished.
  const { summary, sessionId: buildSession } = await finished.finally(() => depsKey ? savePackages(worktree, join(depsDir, depsKey), depsKey, ctx.env).catch(() => {}) : undefined);
  check();

  const identity = (await run("git", ["config", "user.email"], { cwd: worktree, env: ctx.env })).stdout.trim()
    ? [] : ["-c", "user.name=LFG Desktop", "-c", "user.email=lfg-desktop@localhost"];
  const saved = await withRepoLock(repoDir, async () => {
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
  return { commitSha, merge };
  });
  // Saved and merged: now show it working, recorded. Its findings never fail the build.
  if (p.walkthrough && ctx.agent === "claude" && buildSession) {
    await recordWalkthrough(job, active, ctx, worktree, buildSession, tools).catch(() => {});
    check();
  }
  return { branch: p.branch, commitSha: saved.commitSha, summary, ...saved.merge };
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
