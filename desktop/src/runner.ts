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

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import type { ClaudeTaskPayload, RunnerJobOffer, RunnerToServer, ServerToRunner } from "./protocol.ts";

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

export type ApprovalResult = { approved: true } | { approved: false; reason?: string };

export interface RunnerOptions {
  serverUrl: string;
  token: string;
  /** Where repos and worktrees live, e.g. ~/LFG. */
  workRoot: string;
  createSocket: SocketFactory;
  /** Ask the person whether to run this job. */
  approve(job: RunnerJobOffer): Promise<ApprovalResult>;
  /** Claude Code tools this computer allows. A job can only narrow this list. */
  allowedTools?: string[];
  claudeBin?: string;
  /** Environment for git/claude (a GUI app should pass the login shell's PATH). */
  env?: NodeJS.ProcessEnv;
  appVersion?: string;
  /** Tests only: accept file:// repository URLs. */
  allowLocalRepos?: boolean;
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
  private queue: RunnerJobOffer[] = [];
  private busy = false;
  private claudeVersion: string | null | undefined;
  readonly active = new Map<string, ActiveJob>();
  state: RunnerState = "disconnected";

  constructor(private readonly opts: RunnerOptions) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    for (const job of this.active.values()) { job.cancelled = true; job.child?.kill("SIGTERM"); }
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
    socket.onopen = async () => {
      this.claudeVersion ??= await this.detectClaude();
      this.send({ type: "hello", appVersion: this.opts.appVersion, platform: `${process.platform}-${process.arch}`, claudeVersion: this.claudeVersion, activeJobIds: [...this.active.keys()] });
    };
    socket.onmessage = (ev) => { void this.handle(String(ev.data)); };
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
        this.send({ type: "pong" });
        return;
      case "error":
        this.log(`server: ${msg.message}`);
        return;
      case "job.cancel": {
        const job = this.active.get(msg.jobId);
        if (job) { job.cancelled = true; job.child?.kill("SIGTERM"); }
        this.queue = this.queue.filter(j => j.id !== msg.jobId);
        return;
      }
      case "job.offer":
        if (msg.job.type !== "claude_task" || this.active.has(msg.job.id) || this.queue.some(j => j.id === msg.job.id)) return;
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

  private async runOffer(job: RunnerJobOffer) {
    const title = `${job.payload.ticketKey ? job.payload.ticketKey + " " : ""}${job.payload.ticketTitle}`;
    const problem = validatePayload(job.payload, !!this.opts.allowLocalRepos);
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
      const result = await runClaudeTask(job, active, {
        workRoot: this.opts.workRoot,
        claudeBin: this.opts.claudeBin ?? "claude",
        allowedTools: this.opts.allowedTools ?? DEFAULT_ALLOWED_TOOLS,
        env: this.opts.env ?? process.env,
        progress: text => this.send({ type: "job.progress", jobId: job.id, text }),
        agentEvent: event => this.send({ type: "job.agent_event", jobId: job.id, event }),
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

  private async detectClaude(): Promise<string | null> {
    try {
      const r = await run(this.opts.claudeBin ?? "claude", ["--version"], { env: this.opts.env ?? process.env, timeoutMs: 10_000 });
      return r.code === 0 ? r.stdout.trim().slice(0, 80) : null;
    } catch { return null; }
  }
}

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
  claudeBin: string;
  allowedTools: string[];
  env: NodeJS.ProcessEnv;
  progress(text: string): void;
  agentEvent(event: Record<string, unknown>): void;
}

export async function runClaudeTask(job: RunnerJobOffer, active: ActiveJob, ctx: TaskContext)
  : Promise<{ branch: string; commitSha: string | null; summary?: string }> {
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
  ctx.progress("Starting Claude Code…");
  const summary = await runClaude(ctx, active, worktree, p, tools);
  check();

  if ((await git(["status", "--porcelain"], worktree)).trim()) {
    const identity = (await run("git", ["config", "user.email"], { cwd: worktree, env: ctx.env })).stdout.trim()
      ? [] : ["-c", "user.name=LFG Desktop", "-c", "user.email=lfg-desktop@localhost"];
    await git(["add", "-A"], worktree);
    await git([...identity, "commit", "-m", p.commitMessage || "LFG Desktop changes"], worktree);
  }
  const head = (await git(["rev-parse", "HEAD"], worktree)).trim();
  if (head === base) return { branch: p.branch, commitSha: null, summary };
  check();
  ctx.progress(`Pushing ${p.branch}…`);
  await git(["push", "-u", "origin", `HEAD:refs/heads/${p.branch}`], worktree);
  return { branch: p.branch, commitSha: head, summary };
}

function runClaude(ctx: TaskContext, active: ActiveJob, cwd: string, p: ClaudeTaskPayload, tools: string[]): Promise<string | undefined> {
  const args = ["-p", p.prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits",
    "--allowedTools", tools.join(","), ...(p.maxTurns ? ["--max-turns", String(p.maxTurns)] : [])];
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try { child = spawn(ctx.claudeBin, args, { cwd, env: ctx.env, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { reject(claudeMissing(e)); return; }
    active.child = child;
    let buffer = "", stderr = "", summary: string | undefined, failure: string | undefined;
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          ctx.agentEvent(event);
          if (event.type === "result") {
            if (event.is_error) failure = String(event.result ?? event.subtype ?? "Claude Code reported an error");
            else if (typeof event.result === "string") summary = event.result;
          }
        } catch { /* not JSON; ignore */ }
      }
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    child.on("error", e => reject(claudeMissing(e)));
    child.on("close", code => {
      active.child = undefined;
      if (active.cancelled) { reject(new Error("Cancelled")); return; }
      if (failure) { reject(new Error(failure)); return; }
      if (code !== 0) {
        const hint = /log ?in|auth|credential|401/i.test(stderr) ? " Open a terminal and run `claude` to sign in." : "";
        reject(new Error(`Claude Code exited with code ${code}.${hint} ${stderr.trim().slice(-800)}`.trim()));
        return;
      }
      resolve(summary);
    });
  });
}

function claudeMissing(e: unknown): Error {
  return (e as NodeJS.ErrnoException)?.code === "ENOENT"
    ? new Error("Claude Code isn't installed on this computer. Install it, run `claude` once to sign in, then try again.")
    : e instanceof Error ? e : new Error(String(e));
}

// ── Processes ────────────────────────────────────────────────────────

interface RunOpts { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }

export function run(cmd: string, args: string[], opts: RunOpts = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...(opts.env ?? process.env), GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => { stdout += d; });
    child.stderr.on("data", d => { stderr += d; });
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : null;
    child.on("error", e => { if (timer) clearTimeout(timer); reject(e); });
    child.on("close", code => { if (timer) clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
  });
}

async function mustRun(cmd: string, args: string[], opts: RunOpts, label: string): Promise<string> {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${label} failed: ${(r.stderr || r.stdout).trim().slice(-800)}`);
  return r.stdout;
}

export const defaultWorkRoot = () => join(os.homedir(), "LFG");
