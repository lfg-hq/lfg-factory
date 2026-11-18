/**
 * Previews on this computer: run the project's app from a branch and report its
 * http://localhost address back to LFG, so the Preview tab shows it without a cloud sandbox.
 *
 * Each project gets one preview folder, ~/LFG/previews/<project>, a git worktree of the
 * same clone builds use (~/LFG/repos/<hash>). It is separate from the build worktrees
 * (~/LFG/worktrees/<branch>) because a build recreates its worktree from scratch, which
 * would pull the files out from under a running app. The preview checks branches out
 * detached, so it never holds a branch a build needs.
 *
 * The commands come from the project's saved preview plan (install, build, run, ports),
 * which the person approves on this computer before the first run. Apps bind to
 * 127.0.0.1, so they aren't reachable from the local network.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import os from "node:os";
import { join } from "node:path";
import type { PreviewPayload, PreviewPlan, PreviewStep, PreviewUpdate, PreviewUrl } from "./protocol.ts";
import { mustRun, run } from "./proc.ts";
import { chooseDownload, currentNode, describe, downloadNode, fmt, installedNodes, nodeRequirements, pickInstalled, unmet, withNode, type NodeInstall, type Version } from "./node-runtime.ts";

export interface PreviewContext {
  workRoot: string;
  env: NodeJS.ProcessEnv;
  update(update: PreviewUpdate): void;
  /** Tests only: accept file:// repository URLs. */
  allowLocalRepos?: boolean;
  /** How long to wait for an app to answer on its port. Default 5 minutes. */
  startTimeoutMs?: number;
  /** Docker Desktop is installed but not running: ask the person to start it. Absent: don't ask. */
  askStartDocker?(info: { engine: string }): Promise<boolean>;
  /** Ask the person before downloading a Node.js the project needs. Absent: never download. */
  approveNodeDownload?(info: { version: string; reason: string; folder: string }): Promise<boolean>;
}

const REF = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._\/-]{1,200}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validatePreviewPayload(p: PreviewPayload, allowLocalRepos: boolean): string | null {
  if (!p || typeof p.projectId !== "string" || !p.projectId) return "The preview names no project.";
  if (p.branch !== null && (typeof p.branch !== "string" || !REF.test(p.branch))) return "The preview names an invalid branch.";
  const okRemote = /^(https:\/\/|ssh:\/\/|git@[\w.-]+:)/.test(p.repoUrl) || (allowLocalRepos && p.repoUrl.startsWith("file://"));
  if (!okRemote || p.repoUrl.startsWith("-")) return "The preview's repository URL isn't one this computer will clone.";
  if (p.plan) {
    const ports = [p.plan.port, ...(p.plan.services ?? []).map(s => s.port)];
    if (!ports.every(n => Number.isInteger(n) && n > 0 && n < 65536)) return "The preview plan has an invalid port.";
    if ((p.plan.services ?? []).some(s => s.dir && (s.dir.startsWith("/") || s.dir.split("/").includes("..")))) return "The preview plan names a folder outside the repository.";
  }
  if (Object.keys(p.env ?? {}).some(k => !ENV_KEY.test(k))) return "The preview has an invalid environment variable name.";
  return null;
}

/** Every command a preview would run, for the person to approve. */
export function previewCommands(plan: PreviewPlan | null): string[] {
  if (!plan) return [];
  return [
    plan.installCmd, plan.buildCmd, ...(plan.services ?? []).map(s => s.buildCmd),
    ...(plan.migrations ?? []), plan.seedCmd, plan.runCmd, ...(plan.services ?? []).map(s => s.runCmd),
  ].filter((c): c is string => !!c && !!c.trim());
}

export const previewFolderName = (projectId: string) => projectId.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 60) || "project";

// ── Databases ────────────────────────────────────────────────────────

type Engine = PreviewPlan["databases"][number]["engine"];
// `port` is the engine's usual port (a server already running here); `dockerPort` is where LFG's
// own container listens, so it never collides with a database the person already runs.
const ENGINES: Record<Engine, { label: string; port: number; dockerPort: number; image: string; volume: string; dockerEnv: string[]; install: string }> = {
  postgres: { label: "Postgres", port: 5432, dockerPort: 55432, image: "postgres:16-alpine", volume: "/var/lib/postgresql/data", dockerEnv: ["POSTGRES_PASSWORD=lfg"], install: "brew install postgresql@16 && brew services start postgresql@16" },
  mysql: { label: "MySQL", port: 3306, dockerPort: 53306, image: "mysql:8.4", volume: "/var/lib/mysql", dockerEnv: ["MYSQL_ROOT_PASSWORD=lfg"], install: "brew install mysql && brew services start mysql" },
  redis: { label: "Redis", port: 6379, dockerPort: 56379, image: "redis:7-alpine", volume: "/data", dockerEnv: [], install: "brew install redis && brew services start redis" },
  mssql: { label: "SQL Server", port: 1433, dockerPort: 51433, image: "mcr.microsoft.com/mssql/server:2022-latest", volume: "/var/opt/mssql", dockerEnv: ["ACCEPT_EULA=Y", "MSSQL_SA_PASSWORD=Lfg-preview-1"], install: "Docker Desktop (SQL Server runs in Docker on a Mac)" },
};

export interface DbEndpoint { engine: Engine; host: string; port: number; user: string; password: string; database: string }

/** The connection string the app expects, in the plan's format. */
export function formatConnection(format: string, e: DbEndpoint): string {
  const auth = e.password ? `${encodeURIComponent(e.user)}:${encodeURIComponent(e.password)}` : encodeURIComponent(e.user);
  switch (format) {
    case "dotnet-npgsql": return `Host=${e.host};Port=${e.port};Database=${e.database};Username=${e.user}${e.password ? `;Password=${e.password}` : ""}`;
    case "dotnet-mysql": return `Server=${e.host};Port=${e.port};Database=${e.database};Uid=${e.user}${e.password ? `;Pwd=${e.password}` : ""}`;
    case "dotnet-sqlserver": return `Server=${e.host},${e.port};Database=${e.database};User Id=${e.user};Password=${e.password};TrustServerCertificate=True`;
    case "keyvalue": return `host=${e.host} port=${e.port} dbname=${e.database} user=${e.user}${e.password ? ` password=${e.password}` : ""}`;
    default:
      if (e.engine === "redis") return `redis://${e.host}:${e.port}`;
      if (e.engine === "mysql") return `mysql://${auth}@${e.host}:${e.port}/${e.database}`;
      if (e.engine === "mssql") return `sqlserver://${auth}@${e.host}:${e.port};database=${e.database}`;
      return `postgresql://${auth}@${e.host}:${e.port}/${e.database}`;
  }
}

export function portOpen(port: number, host = "127.0.0.1", timeoutMs = 700): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ port, host });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Working out a plan when LFG has none ─────────────────────────────

/** A plain guess from the repository's files, for projects LFG hasn't worked out a plan for yet. */
export function detectPlan(dir: string): PreviewPlan | null {
  const has = (f: string) => existsSync(join(dir, f));
  if (has("package.json")) {
    let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
    try { pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")); } catch { return null; }
    const script = pkg.scripts?.dev ? "dev" : pkg.scripts?.start ? "start" : null;
    if (!script) return null;
    const pm = has("bun.lock") || has("bun.lockb") ? "bun" : has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm";
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const text = pkg.scripts?.[script] ?? "";
    const explicit = text.match(/(?:--port|-p)[ =](\d{2,5})/);
    const port = explicit ? Number(explicit[1]) : deps.vite && !deps.next ? 5173 : 3000;
    return {
      stack: deps.next ? "Next.js" : deps.vite ? "Vite" : "Node.js",
      installCmd: pm === "npm" ? (has("package-lock.json") ? "npm ci" : "npm install") : `${pm} install`,
      runCmd: pm === "npm" ? `npm run ${script}` : `${pm} run ${script}`,
      port,
      databases: [],
    };
  }
  if (has("manage.py")) {
    return { stack: "Django", installCmd: has("requirements.txt") ? "python3 -m pip install -r requirements.txt" : undefined, runCmd: "python3 manage.py runserver 127.0.0.1:8000", port: 8000, databases: [], migrations: ["python3 manage.py migrate"] };
  }
  if (has("Gemfile") && has("bin/rails")) {
    return { stack: "Rails", installCmd: "bundle install", runCmd: "bin/rails server -b 127.0.0.1 -p 3000", port: 3000, databases: [], migrations: ["bin/rails db:prepare"] };
  }
  return null;
}

/** Point commands written for the cloud sandbox at this computer: its folder, and 127.0.0.1 only. */
export function localizeCommand(cmd: string, dir: string): string {
  return cmd.replace(/\/data\/project\b/g, dir).replace(/\b0\.0\.0\.0\b/g, "127.0.0.1");
}

// ── One running preview ──────────────────────────────────────────────

interface Meta { branch: string | null; installedCommit?: string; installedNode?: string; seeded?: string[] }

export class PreviewStopped extends Error { constructor() { super("Stopped"); } }

export class LocalPreview {
  private stopped = false;
  private children: ChildProcess[] = [];
  private steps: PreviewStep[] = [];
  private pending: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private exitHandlers: Array<(error: string) => void> = [];
  private isRunning = false;
  readonly dir: string;
  private readonly metaFile: string;
  private readonly repoDir: string;

  constructor(readonly payload: PreviewPayload, private readonly ctx: PreviewContext) {
    const name = previewFolderName(payload.projectId);
    this.dir = join(ctx.workRoot, "previews", name);
    this.metaFile = join(ctx.workRoot, "previews", `.${name}.json`);
    this.repoDir = join(ctx.workRoot, "repos", createHash("sha1").update(payload.repoUrl).digest("hex").slice(0, 12));
  }

  /** Called with a plain reason if the app stops by itself after it was running. */
  onExit(fn: (error: string) => void) { this.exitHandlers.push(fn); }

  private log(line: string) {
    this.pending.push(line);
    if (this.pending.length > 200) this.pending.splice(0, this.pending.length - 200);
    this.flushTimer ??= setTimeout(() => this.flush(), 400);
  }
  private flush(extra: PreviewUpdate = {}) {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    const lines = this.pending.splice(0);
    if (!lines.length && !Object.keys(extra).length) return;
    this.ctx.update({ ...extra, ...(lines.length ? { lines } : {}) });
  }
  private report(update: PreviewUpdate) { this.flush({ ...update, ...(update.steps ? {} : { steps: this.steps }) }); }

  private async step<T>(id: string, label: string, status: PreviewUpdate["status"], fn: () => Promise<T>, command?: string): Promise<T> {
    this.check();
    let s = this.steps.find(x => x.id === id);
    if (!s) { s = { id, label, status: "running", ...(command ? { command } : {}) }; this.steps.push(s); }
    s.status = "running";
    this.log(label);
    this.report({ status });
    try {
      const out = await fn();
      s.status = "done";
      this.report({});
      return out;
    } catch (error) {
      s.status = this.stopped ? "skipped" : "failed";
      this.report({});
      throw error;
    }
  }
  private skip(id: string, label: string, why: string) {
    this.steps.push({ id, label, status: "skipped" });
    this.log(`${label}: ${why}`);
  }
  private check() { if (this.stopped) throw new PreviewStopped(); }

  private readMeta(): Meta | null { try { return JSON.parse(readFileSync(this.metaFile, "utf8")); } catch { return null; } }
  private writeMeta(m: Meta) { writeFileSync(this.metaFile, JSON.stringify(m, null, 2)); }

  /** Run a shell command in the preview folder, streaming its output to the log. */
  private shell(cmd: string, env: NodeJS.ProcessEnv, cwd = this.dir, timeoutMs = 30 * 60_000): Promise<void> {
    this.check();
    const line = localizeCommand(cmd, this.dir);
    this.log(`$ ${line}`);
    return new Promise((resolve, reject) => {
      const child = spawn(env.SHELL && /zsh|bash/.test(env.SHELL) ? env.SHELL : "/bin/sh", ["-c", line], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
      this.children.push(child);
      let tail = "";
      const onData = (d: Buffer) => { const text = d.toString(); tail = (tail + text).slice(-3000); for (const l of text.split(/\r?\n/)) if (l.trim()) this.log(l.slice(0, 2000)); };
      child.stdout!.on("data", onData);
      child.stderr!.on("data", onData);
      const timer = setTimeout(() => killGroup(child, "SIGKILL"), timeoutMs);
      child.on("error", e => { clearTimeout(timer); reject(e); });
      child.on("close", code => {
        clearTimeout(timer);
        this.children = this.children.filter(c => c !== child);
        if (this.stopped) return reject(new PreviewStopped());
        if (code === 0) return resolve();
        const missing = /command not found|not found: |No such file or directory/.exec(tail) ? missingTool(line, tail) : null;
        reject(new Error(missing ?? `\`${line}\` failed (exit ${code}).\n${tail.trim().split("\n").slice(-15).join("\n")}`));
      });
    });
  }

  async start(): Promise<PreviewUrl[]> {
    const p = this.payload;
    const env: NodeJS.ProcessEnv = { ...this.ctx.env, GIT_TERMINAL_PROMPT: "0" };
    const git = (args: string[], cwd = this.repoDir) => mustRun("git", args, { cwd, env, timeoutMs: 10 * 60_000 }, `git ${args[0]}`);
    mkdirSync(join(this.ctx.workRoot, "repos"), { recursive: true });
    mkdirSync(join(this.ctx.workRoot, "previews"), { recursive: true });
    const meta = this.readMeta();
    const sameBranch = !!meta && meta.branch === p.branch && existsSync(join(this.dir, ".git"));
    const refresh = p.refresh || !sameBranch;

    // 1. The code.
    let commit = "";
    if (refresh) {
      commit = await this.step("code", `Get the code for ${p.label}`, "detecting", async () => {
        if (!existsSync(join(this.repoDir, ".git"))) {
          this.log(`Cloning ${p.repoUrl}…`);
          await mustRun("git", ["clone", "--", p.repoUrl, this.repoDir], { env, timeoutMs: 30 * 60_000 }, "git clone");
        }
        await git(["fetch", "--prune", "origin"]);
        let ref: string;
        if (p.branch) {
          ref = `origin/${p.branch}`;
          if ((await run("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: this.repoDir, env })).code !== 0) {
            throw new Error(`The branch ${p.branch} isn't on the remote yet. Build the ticket first (that pushes its branch), then preview it.`);
          }
        } else {
          await run("git", ["remote", "set-head", "origin", "-a"], { cwd: this.repoDir, env });
          ref = (await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).trim() || "origin/main";
        }
        if (!existsSync(join(this.dir, ".git"))) {
          await git(["worktree", "prune"]);
          await git(["worktree", "add", "--detach", this.dir, ref]);
        } else {
          await git(["checkout", "--detach", "--force", ref], this.dir);
        }
        const sha = (await git(["rev-parse", "HEAD"], this.dir)).trim();
        this.log(`On ${p.branch ?? ref.replace(/^origin\//, "")} at ${sha.slice(0, 7)}.`);
        return sha;
      });
    } else {
      commit = (await git(["rev-parse", "HEAD"], this.dir)).trim();
      this.skip("code", `Get the code for ${p.label}`, `reusing ${commit.slice(0, 7)} (Update & rebuild fetches the latest)`);
    }
    this.writeMeta({ ...(meta ?? {}), branch: p.branch, ...(refresh ? { installedCommit: undefined } : {}) });

    const plan = p.plan ?? detectPlan(this.dir);
    if (!plan) throw new Error("LFG has no saved way to run this app yet, and couldn't work one out on this computer. Run the preview once in the cloud so LFG can work out the setup, then switch back to your computer.");
    if (!p.plan) this.log(`No saved plan; running it as a ${plan.stack ?? "detected"} app: ${plan.runCmd}`);

    // 2. Databases.
    const appEnv: NodeJS.ProcessEnv = { ...env, ...p.env, HOST: "127.0.0.1" };
    if (plan.databases.length) {
      await this.step("databases", "Start the databases it needs", "provisioning", async () => {
        for (const d of plan.databases) {
          const configured = p.env[d.connectionEnvVar];
          if (configured && !pointsAtThisMachine(configured)) { this.log(`${d.connectionEnvVar}: using the value from the project's Env settings.`); continue; }
          if (configured) this.log(`${d.connectionEnvVar} in the project's Env settings points at the cloud preview's own database (localhost), so LFG makes one on this computer instead.`);
          const endpoint = await this.database(d.engine, d.databaseName || p.projectName, env);
          appEnv[d.connectionEnvVar] = formatConnection(d.connectionFormat, endpoint);
          this.log(`${d.connectionEnvVar} → ${ENGINES[d.engine].label} on ${endpoint.host}:${endpoint.port}, database "${endpoint.database}".`);
        }
      });
    }

    // 3. The Node.js this app needs (a JavaScript app only).
    const usesNode = existsSync(join(this.dir, "package.json"));
    let node: Version | null = null;
    if (usesNode) {
      node = await this.step("node", "Pick the Node.js version", "installing", () => this.chooseNode(appEnv));
    }

    // 4. Install and build (skipped on a plain restart of what's already installed).
    const before = this.readMeta();
    const fresh = before?.installedCommit !== commit || (!!node && before?.installedNode !== fmt(node));
    if (fresh && node && before?.installedNode && before.installedNode !== fmt(node)) {
      // Native modules were compiled for the other Node; start from a clean install.
      this.log(`Switching from Node ${before.installedNode} to ${fmt(node)}: reinstalling dependencies.`);
      rmSync(join(this.dir, "node_modules"), { recursive: true, force: true });
    }
    if (plan.installCmd) {
      if (fresh) {
        await this.step("install", "Install dependencies", "installing", async () => {
          await this.shell(plan.installCmd!, appEnv);
          // Installed packages can need a newer Node than the project says (Next.js 16: >= 20.9).
          if (node && unmet(node, nodeRequirements(this.dir)).length) {
            const next = await this.chooseNode(appEnv);
            if (next && fmt(next) !== fmt(node)) {
              node = next;
              this.log(`Reinstalling dependencies with Node ${fmt(node)}.`);
              rmSync(join(this.dir, "node_modules"), { recursive: true, force: true });
              await this.shell(plan.installCmd!, appEnv);
            }
          }
        }, plan.installCmd);
      } else this.skip("install", "Install dependencies", "already installed for this commit");
    }
    const builds = [plan.buildCmd, ...(plan.services ?? []).map(s => s.buildCmd)].filter((c): c is string => !!c);
    if (builds.length) {
      if (fresh) await this.step("build", "Build", "installing", async () => { for (const b of builds) await this.shell(b, appEnv); }, builds.join(" && "));
      else this.skip("build", "Build", "already built for this commit");
    }
    this.writeMeta({ ...(this.readMeta() ?? { branch: p.branch }), installedCommit: commit, ...(node ? { installedNode: fmt(node) } : {}) });

    // 5. Schema and seed data.
    if (plan.migrations?.length) {
      await this.step("migrate", "Set up the database schema", "seeding", async () => { for (const m of plan.migrations!) await this.shell(m, appEnv); }, plan.migrations.join(" && "));
    }
    if (plan.seedCmd) {
      const key = JSON.stringify(plan.databases.map(d => appEnv[d.connectionEnvVar] ?? ""));
      const seeded = this.readMeta()?.seeded ?? [];
      if (seeded.includes(key)) this.skip("seed", "Add sample data", "already added to this database");
      else {
        await this.step("seed", "Add sample data", "seeding", () => this.shell(plan.seedCmd!, appEnv), plan.seedCmd);
        this.writeMeta({ ...(this.readMeta() ?? { branch: p.branch }), seeded: [...seeded, key].slice(-10) });
      }
    }

    // 6. Start the app(s).
    const apps = [{ name: "web", runCmd: plan.runCmd, port: plan.port, dir: undefined as string | undefined, primary: true },
      ...(plan.services ?? []).map(s => ({ ...s, primary: false }))];
    for (const a of apps) appEnv[`${a.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_BASE_URL`] = `http://localhost:${a.port}`;
    const urls: PreviewUrl[] = [];
    for (const a of apps) {
      const url = await this.step(`start-${a.name}`, apps.length > 1 ? `Start ${a.name}` : "Start the app", "starting",
        () => this.launch(a, { ...appEnv, PORT: String(a.port) }), a.runCmd);
      urls.push({ name: a.name, url, port: Number(new URL(url).port), primary: a.primary });
    }
    this.isRunning = true;
    this.log(`Running on this computer: ${urls.map(u => u.url).join(", ")}`);
    this.report({ status: "running", urls, error: "" });
    return urls;
  }

  /**
   * Make `env` run a Node.js that meets what the project (and its packages) need: the shell's
   * default if it does, else one already installed (nvm, fnm, Volta, asdf, Homebrew, LFG's
   * own), else, with the person's OK, the official build from nodejs.org. Returns its version.
   */
  private async chooseNode(env: NodeJS.ProcessEnv): Promise<Version | null> {
    const reqs = nodeRequirements(this.dir);
    const current = await currentNode(env);
    if (!reqs.length || (current && !unmet(current, reqs).length)) {
      if (current) this.log(`Node.js ${fmt(current)}${reqs.length ? ` meets what this app needs (${describe(reqs)})` : ""}.`);
      return current;
    }
    const why = describe(current ? unmet(current, reqs) : reqs);
    const use = (n: NodeInstall) => {
      Object.assign(env, withNode(env, n.bin));
      this.log(`${current ? `Your default Node.js is ${fmt(current)}, but ${why}.` : `No Node.js on your PATH; ${why}.`} Using Node.js ${fmt(n.version)} (${n.source}).`);
      return n.version;
    };
    const installed = pickInstalled(installedNodes(this.ctx.workRoot), reqs);
    if (installed) return use(installed);

    const version = await chooseDownload(reqs).catch(() => null);
    if (!version) throw new Error(`This app needs a different Node.js (${why}), and none on this computer fits. Install one (for example with nvm), then press Update & rebuild.`);
    const folder = join(this.ctx.workRoot, "runtimes");
    const ok = this.ctx.approveNodeDownload
      ? await this.ctx.approveNodeDownload({ version: fmt(version), reason: why, folder })
      : false;
    if (!ok) throw new Error(`This app needs Node.js ${fmt(version)} or similar (${why}). It wasn't downloaded. Install it yourself (for example \`nvm install ${version[0]}\`), then press Update & rebuild.`);
    this.check();
    return use(await downloadNode(version, this.ctx.workRoot, line => this.log(line)));
  }

  /** A database for the app: one already running here, else a Docker container, else a plain explanation. */
  private async database(engine: Engine, name: string, env: NodeJS.ProcessEnv): Promise<DbEndpoint> {
    const e = ENGINES[engine];
    const database = name.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^([^a-z_])/, "_$1").slice(0, 50) || "app";
    // 1. Docker (its own container, its own port): nothing of the person's own databases is touched.
    let docker = await dockerState(env);
    if (docker === "running") return this.dockerDatabase(engine, database, env);
    // 2. A server for this engine already running here.
    if (await portOpen(e.port)) return this.localDatabase(engine, database, env);
    // 3. Docker is installed but not running: ask to start it.
    if (docker === "stopped") {
      const ok = this.ctx.askStartDocker ? await this.ctx.askStartDocker({ engine: e.label }) : false;
      if (!ok) throw new Error(`This app needs ${e.label}. Start Docker Desktop (LFG runs ${e.label} in it), then press Update & rebuild. Or run this preview in the cloud.`);
      this.log("Starting Docker Desktop…");
      await run("open", ["-a", "Docker"], { env }).catch(() => null);
      for (let i = 0; i < 120 && docker !== "running"; i++) { this.check(); await sleep(2000); docker = await dockerState(env); }
      if (docker !== "running") throw new Error("Docker Desktop didn't finish starting. Once its whale icon stops animating, press Update & rebuild.");
      return this.dockerDatabase(engine, database, env);
    }
    throw new Error(`This app needs ${e.label}, and this computer has neither ${e.label} running nor Docker. ` +
      `Install Docker Desktop (LFG then runs ${e.label} in it) or ${e.label} itself (${e.install}), then press Update & rebuild. Or run this preview in the cloud.`);
  }

  /** Use a database server already running on this computer, as the person's own user. */
  private async localDatabase(engine: Engine, database: string, env: NodeJS.ProcessEnv): Promise<DbEndpoint> {
    const e = ENGINES[engine];
    this.log(`${e.label} is already running on this computer (port ${e.port}); using database "${database}" there.`);
    if (engine === "postgres") {
      const made = await run("createdb", ["-h", "127.0.0.1", "-p", String(e.port), database], { env }).catch(() => null);
      if (made && made.code !== 0 && !/already exists/.test(made.stderr)) this.log(`Couldn't create database "${database}" (${made.stderr.trim().slice(0, 200)}); the app may create it.`);
    }
    return { engine, host: "127.0.0.1", port: e.port, user: engine === "mysql" ? "root" : engine === "mssql" ? "sa" : os.userInfo().username, password: "", database };
  }

  /** LFG's own container for this engine (one per engine, shared by projects, one database each). */
  private async dockerDatabase(engine: Engine, database: string, env: NodeJS.ProcessEnv): Promise<DbEndpoint> {
    const e = ENGINES[engine];
    const port = e.dockerPort;
    const container = `lfg-db-${engine}`;
    const state = await run("docker", ["inspect", "-f", "{{.State.Running}}", container], { env });
    if (state.code !== 0) {
      this.log(`Starting ${e.label} in Docker (${e.image}, port ${port})…`);
      await mustRun("docker", ["run", "-d", "--name", container, "--restart", "unless-stopped", "-p", `127.0.0.1:${port}:${e.port}`, "-v", `${container}-data:${e.volume}`,
        ...e.dockerEnv.flatMap(v => ["-e", v]), e.image], { env, timeoutMs: 15 * 60_000 }, `Starting ${e.label} in Docker`);
    } else if (state.stdout.trim() !== "true") {
      this.log(`Starting LFG's ${e.label} container…`);
      await mustRun("docker", ["start", container], { env }, `Starting ${e.label} in Docker`);
    } else {
      this.log(`${e.label} is running in Docker (port ${port}).`);
    }
    for (let i = 0; i < 90 && !(await portOpen(port)); i++) { this.check(); await sleep(1000); }
    if (!(await portOpen(port))) throw new Error(`${e.label} started in Docker but isn't answering on port ${port}. Check Docker Desktop, then press Update & rebuild.`);
    if (engine === "postgres") {
      for (let i = 0; i < 30; i++) { if ((await run("docker", ["exec", container, "pg_isready", "-U", "postgres"], { env })).code === 0) break; this.check(); await sleep(1000); }
      const made = await run("docker", ["exec", container, "createdb", "-U", "postgres", database], { env });
      if (made.code === 0) this.log(`Created database "${database}".`);
    } else if (engine === "mysql") {
      for (let i = 0; i < 60; i++) { if ((await run("docker", ["exec", container, "mysql", "-uroot", "-plfg", "-e", `CREATE DATABASE IF NOT EXISTS \`${database}\``], { env })).code === 0) break; this.check(); await sleep(2000); }
    }
    const password = engine === "postgres" || engine === "mysql" ? "lfg" : engine === "mssql" ? "Lfg-preview-1" : "";
    return { engine, host: "127.0.0.1", port, user: engine === "postgres" ? "postgres" : engine === "mysql" ? "root" : engine === "mssql" ? "sa" : "", password, database };
  }

  /** Start one app and wait until it answers. Returns its address. */
  private async launch(a: { name: string; runCmd: string; port: number; dir?: string }, env: NodeJS.ProcessEnv): Promise<string> {
    if (await portOpen(a.port)) {
      throw new Error(`Port ${a.port} is already in use on this computer, so ${a.name === "web" ? "the app" : a.name} can't start there. ` +
        `Stop whatever is using it (another dev server or preview), then press Update & rebuild.`);
    }
    const cmd = localizeCommand(a.runCmd, this.dir);
    const cwd = a.dir ? join(this.dir, a.dir) : this.dir;
    this.log(`$ ${cmd}`);
    const child = spawn(env.SHELL && /zsh|bash/.test(env.SHELL) ? env.SHELL : "/bin/sh", ["-c", cmd], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    this.children.push(child);
    let tail = "";
    let printedPort: number | null = null;
    const onData = (d: Buffer) => {
      const text = d.toString();
      tail = (tail + text).slice(-4000);
      for (const l of text.split(/\r?\n/)) if (l.trim()) this.log(`[${a.name}] ${l.slice(0, 2000)}`);
      const m = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})/.exec(text);
      if (m && !printedPort) printedPort = Number(m[1]);
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    let exited: number | null | undefined;
    child.on("close", code => {
      exited = code;
      this.children = this.children.filter(c => c !== child);
      if (this.stopped || !this.isRunning) return;
      const why = `${a.name === "web" ? "The app" : a.name} stopped on this computer (exit ${code}).\n${tail.trim().split("\n").slice(-15).join("\n")}`;
      for (const fn of this.exitHandlers) fn(why);
    });
    const deadline = Date.now() + (this.ctx.startTimeoutMs ?? 5 * 60_000);
    while (Date.now() < deadline) {
      this.check();
      if (exited !== undefined) {
        throw new Error(missingTool(cmd, tail) ?? `\`${cmd}\` exited (code ${exited}) before the app answered.\n${tail.trim().split("\n").slice(-20).join("\n")}`);
      }
      if (await portOpen(a.port)) return `http://localhost:${a.port}`;
      // The app chose another port than the plan says (it printed its address).
      if (printedPort && printedPort !== a.port && await portOpen(printedPort)) {
        this.log(`${a.name} is listening on ${printedPort}, not ${a.port} as planned; using ${printedPort}.`);
        return `http://localhost:${printedPort}`;
      }
      await sleep(1000);
    }
    throw new Error(`${a.name === "web" ? "The app" : a.name} didn't answer on port ${a.port} within ${Math.round((this.ctx.startTimeoutMs ?? 300_000) / 60_000)} minutes.\n${tail.trim().split("\n").slice(-15).join("\n")}`);
  }


  /** Stop every process this preview started, and wait for them to go. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.isRunning = false;
    this.flush();
    const children = [...this.children];
    for (const c of children) killGroup(c, "SIGTERM");
    const gone = (c: ChildProcess) => c.exitCode !== null || c.signalCode !== null;
    for (let i = 0; i < 50 && children.some(c => !gone(c)); i++) await sleep(100);
    for (const c of children) if (!gone(c)) killGroup(c, "SIGKILL");
  }
}

/** Docker on this computer: running, installed but stopped, or not installed. */
async function dockerState(env: NodeJS.ProcessEnv): Promise<"running" | "stopped" | "missing"> {
  const info = await run("docker", ["info", "--format", "{{.ServerVersion}}"], { env, timeoutMs: 20_000 }).catch(() => null);
  if (info && info.code === 0 && info.stdout.trim()) return "running";
  if (info || existsSync("/Applications/Docker.app") || existsSync(join(os.homedir(), "Applications/Docker.app"))) return "stopped";
  return "missing";
}

/**
 * A connection setting that points at this same machine (localhost, 127.0.0.1, ::1, 0.0.0.0).
 * In the project's Env settings, that's the cloud preview's own database, not one here.
 */
export function pointsAtThisMachine(value: string): boolean {
  const host = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^:/?#;]+)/i.exec(value.trim())?.[1]
    ?? /(?:^|;)\s*(?:host|server|data source)\s*=\s*([^;,\s]+)/i.exec(value)?.[1]
    ?? /(?:^|\s)host=(\S+)/.exec(value)?.[1];
  return !!host && /^(localhost|127(?:\.\d+){3}|\[?::1\]?|0\.0\.0\.0|host\.docker\.internal)$/i.test(host.trim());
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals) {
  try { if (child.pid) process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* gone */ } }
}

/** "npm: command not found" → which program is missing, said plainly. */
function missingTool(cmd: string, output: string): string | null {
  const m = /(?:command not found: |: command not found|not found: )\s*([\w.+-]+)|([\w.+-]+): command not found/.exec(output);
  const tool = m?.[1] ?? m?.[2] ?? cmd.trim().split(/\s+/)[0];
  if (!/command not found|not found: /.test(output)) return null;
  return `This app needs \`${tool}\`, which isn't installed on this computer (or isn't on your shell's PATH). Install it, then press Update & rebuild. Or run this preview in the cloud.`;
}
