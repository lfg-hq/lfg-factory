// LFG Desktop running a project's app for the Preview tab: a real git repo, a tiny
// Node server as "the app", no cloud. Run on its own: bun test tests/desktop-preview.test.ts
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LocalPreview, detectPlan, formatConnection, localizeCommand, portOpen, previewCommands, validatePreviewPayload } from "../desktop/src/preview.ts";
import { Runner, type SocketLike } from "../desktop/src/runner.ts";
import type { PreviewPayload, PreviewPlan, PreviewUpdate, RunnerToServer } from "../desktop/src/protocol.ts";

const root = mkdtempSync(join(tmpdir(), "lfg-desktop-preview-"));
const bare = join(root, "origin.git");
const workRoot = join(root, "LFG");
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const sh = (cmd: string[], cwd?: string) => {
  const r = Bun.spawnSync(cmd, { cwd, env: gitEnv });
  if (r.exitCode) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
const freePort = () => new Promise<number>(resolve => {
  const srv = createServer().listen(0, "127.0.0.1", () => { const port = (srv.address() as { port: number }).port; srv.close(() => resolve(port)); });
});
const server = (greeting: string) =>
  `require("http").createServer((q, r) => r.end("${greeting} " + (process.env.GREETING || "") + " " + (process.env.REDIS_URL || ""))).listen(Number(process.env.PORT), process.env.HOST);\n`;

beforeAll(() => {
  const seed = join(root, "seed");
  mkdirSync(seed);
  sh(["git", "init", "-q", "-b", "main"], seed);
  writeFileSync(join(seed, "server.cjs"), server("main"));
  writeFileSync(join(seed, "package.json"), JSON.stringify({ name: "app", scripts: { dev: "node server.cjs --port 4321" } }));
  sh(["git", "add", "-A"], seed);
  sh(["git", "commit", "-qm", "app"], seed);
  sh(["git", "checkout", "-qb", "feature/rec-23"], seed);
  writeFileSync(join(seed, "server.cjs"), server("ticket"));
  sh(["git", "commit", "-qam", "ticket"], seed);
  sh(["git", "checkout", "-q", "main"], seed);
  sh(["git", "clone", "-q", "--bare", seed, bare]);
});

const running: LocalPreview[] = [];
afterAll(async () => { for (const p of running) await p.stop(); });

function payload(over: Partial<PreviewPayload> & { plan: PreviewPlan | null }): PreviewPayload {
  return { protocol: 3, projectId: "pub-rec", projectName: "Recruiting", repoUrl: `file://${bare}`, branch: null, label: "Default branch", refresh: true, env: {}, ...over };
}
function start(p: PreviewPayload, env: NodeJS.ProcessEnv = process.env) {
  const updates: PreviewUpdate[] = [];
  const preview = new LocalPreview(p, { workRoot, env, allowLocalRepos: true, startTimeoutMs: 20_000, update: u => updates.push(u) });
  running.push(preview);
  return { preview, updates, log: () => updates.flatMap(u => u.lines ?? []).join("\n"), lastSteps: () => updates.filter(u => u.steps).at(-1)?.steps ?? [] };
}

test("runs a ticket's branch on this computer and reports its localhost address", async () => {
  const port = await freePort();
  const plan: PreviewPlan = { installCmd: "echo installed > installed.txt", runCmd: "node server.cjs", port, databases: [] };
  const run = start(payload({ branch: "feature/rec-23", label: "REC-23 — SDR backend", plan, env: { GREETING: "hi" } }));
  const urls = await run.preview.start();
  expect(urls).toEqual([{ name: "web", url: `http://localhost:${port}`, port, primary: true }]);
  expect(await (await fetch(urls[0]!.url)).text()).toBe("ticket hi ");
  expect(run.updates.some(u => u.status === "running")).toBe(true);
  expect(run.lastSteps().map(s => [s.id, s.status])).toEqual([["code", "done"], ["node", "done"], ["install", "done"], ["start-web", "done"]]);
  // Its own folder, checked out detached, so a build can still take the branch.
  const dir = join(workRoot, "previews", "pub-rec");
  expect(existsSync(join(dir, "installed.txt"))).toBe(true);
  expect(Bun.spawnSync(["git", "symbolic-ref", "-q", "HEAD"], { cwd: dir }).exitCode).not.toBe(0);

  await run.preview.stop();
  expect(await portOpen(port)).toBe(false);
});

test("a plain restart reuses what's installed; switching branch fetches and installs again", async () => {
  const port = await freePort();
  const plan: PreviewPlan = { installCmd: "echo again >> installed.txt", runCmd: "node server.cjs", port, databases: [] };
  const again = start(payload({ branch: "feature/rec-23", plan, refresh: false }));
  await again.preview.start();
  expect(again.lastSteps().find(s => s.id === "install")?.status).toBe("skipped");
  expect(again.lastSteps().find(s => s.id === "code")?.status).toBe("skipped");
  await again.preview.stop();

  const main = start(payload({ branch: null, plan, refresh: false }));
  const urls = await main.preview.start();
  expect(main.lastSteps().find(s => s.id === "install")?.status).toBe("done");
  expect(await (await fetch(urls[0]!.url)).text()).toStartWith("main");
  await main.preview.stop();
});

test("a branch that isn't pushed yet is explained plainly", async () => {
  const run = start(payload({ branch: "feature/not-pushed", plan: { runCmd: "node server.cjs", port: await freePort(), databases: [] } }));
  await expect(run.preview.start()).rejects.toThrow("isn't on the remote yet");
});

test("an app that exits before it answers fails with its output; a busy port is named", async () => {
  const crash = start(payload({ plan: { runCmd: "echo 'Error: Cannot find module express' >&2; exit 1", port: await freePort(), databases: [] } }));
  await expect(crash.preview.start()).rejects.toThrow("Cannot find module express");

  const blocker = createServer().listen(0, "127.0.0.1");
  await new Promise(r => blocker.once("listening", r));
  const busyPort = (blocker.address() as { port: number }).port;
  const busy = start(payload({ plan: { runCmd: "node server.cjs", port: busyPort, databases: [] } }));
  await expect(busy.preview.start()).rejects.toThrow(`Port ${busyPort} is already in use`);
  blocker.close();
});

test("a database set in the project's Env settings is used as-is", async () => {
  const port = await freePort();
  const run = start(payload({
    plan: { runCmd: "node server.cjs", port, databases: [{ engine: "redis", connectionEnvVar: "REDIS_URL", connectionFormat: "url" }] },
    env: { REDIS_URL: "redis://cache.example:6379" },
  }));
  const urls = await run.preview.start();
  expect(await (await fetch(urls[0]!.url)).text()).toBe("main  redis://cache.example:6379");
  expect(run.log()).toContain("REDIS_URL: using the value from the project's Env settings.");
  await run.preview.stop();
});

test("a database the computer doesn't have is explained, not a silent failure", async () => {
  if (await portOpen(1433)) return; // this computer runs SQL Server; nothing to explain
  const git = sh(["which", "git"]);
  const run = start(payload({ plan: { runCmd: "node server.cjs", port: await freePort(), databases: [{ engine: "mssql", connectionEnvVar: "ConnectionStrings__Default", connectionFormat: "dotnet-sqlserver" }] } }),
    { ...process.env, PATH: `${dirname(git)}:/bin` }); // no Docker on this PATH
  await expect(run.preview.start()).rejects.toThrow(/This app needs SQL Server(, and this computer has neither SQL Server running nor Docker|\. Start Docker Desktop)/);
});

test("the runner asks first, runs the preview alongside builds, and stops it on cancel", async () => {
  const port = await freePort();
  const sent: RunnerToServer[] = [];
  let socket!: SocketLike;
  const asked: string[][] = [];
  const runner = new Runner({
    serverUrl: "http://lfg.test", token: "lfgr_x", workRoot, allowLocalRepos: true, previewStartTimeoutMs: 20_000,
    createSocket: () => (socket = { readyState: 1, send: d => { sent.push(JSON.parse(d)); }, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
    approve: async () => ({ approved: false }),
    approvePreview: async (_job, commands) => { asked.push(commands); return { approved: true }; },
  });
  runner.start();
  const deliver = (m: object) => socket.onmessage!({ data: JSON.stringify(m) });
  const until = async (fn: () => boolean) => { for (let i = 0; i < 300 && !fn(); i++) await Bun.sleep(50); };
  const plan: PreviewPlan = { runCmd: "node server.cjs", port, databases: [] };
  deliver({ type: "job.offer", job: { id: "job-1", type: "preview", payload: payload({ plan }) } });
  await until(() => sent.some(m => m.type === "job.preview" && m.update.status === "running"));
  expect(asked).toEqual([["node server.cjs"]]);
  expect(sent[0]).toEqual({ type: "job.accepted", jobId: "job-1" });
  const up = sent.find(m => m.type === "job.preview" && m.update.urls) as Extract<RunnerToServer, { type: "job.preview" }>;
  expect(up.update.urls?.[0]?.url).toBe(`http://localhost:${port}`);
  expect(runner.active.has("job-1")).toBe(true); // reported as active on reconnect

  deliver({ type: "job.cancel", jobId: "job-1" });
  await until(() => !runner.active.has("job-1"));
  expect(await portOpen(port)).toBe(false);
  expect(sent.some(m => m.type === "job.finished")).toBe(false); // the server already knows it's cancelled
  runner.stop();
});

test("a preview stopped while the person is still deciding never starts", async () => {
  const sent: RunnerToServer[] = [];
  let socket!: SocketLike;
  let decide!: (ok: { approved: true }) => void;
  const runner = new Runner({
    serverUrl: "http://lfg.test", token: "lfgr_x", workRoot, allowLocalRepos: true,
    createSocket: () => (socket = { readyState: 1, send: d => { sent.push(JSON.parse(d)); }, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
    approve: async () => ({ approved: false }),
    approvePreview: () => new Promise(r => { decide = r; }),
  });
  runner.start();
  const offer = { type: "job.offer", job: { id: "job-3", type: "preview", payload: payload({ plan: { runCmd: "node server.cjs", port: await freePort(), databases: [] } }) } };
  socket.onmessage!({ data: JSON.stringify(offer) });
  socket.onmessage!({ data: JSON.stringify(offer) }); // offered again after a reconnect: still one question
  await Bun.sleep(20);
  socket.onmessage!({ data: JSON.stringify({ type: "job.cancel", jobId: "job-3" }) });
  decide({ approved: true });
  await Bun.sleep(200);
  expect(sent).toEqual([]);
  expect(runner.active.size).toBe(0);
  runner.stop();
});

test("a runner with no way to ask declines previews", async () => {
  const sent: RunnerToServer[] = [];
  let socket!: SocketLike;
  const runner = new Runner({
    serverUrl: "http://lfg.test", token: "lfgr_x", workRoot, allowLocalRepos: true,
    createSocket: () => (socket = { readyState: 1, send: d => { sent.push(JSON.parse(d)); }, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
    approve: async () => ({ approved: false }),
  });
  runner.start();
  socket.onmessage!({ data: JSON.stringify({ type: "job.offer", job: { id: "job-2", type: "preview", payload: payload({ plan: null }) } }) });
  for (let i = 0; i < 50 && !sent.length; i++) await Bun.sleep(20);
  expect(sent[0]).toMatchObject({ type: "job.rejected", jobId: "job-2" });
  runner.stop();
});

test("plans, connection strings and commands are worked out for this computer", () => {
  const dir = join(root, "detect");
  mkdirSync(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "5" } }));
  writeFileSync(join(dir, "pnpm-lock.yaml"), "");
  expect(detectPlan(dir)).toMatchObject({ installCmd: "pnpm install", runCmd: "pnpm run dev", port: 5173 });
  expect(detectPlan(root)).toBeNull();

  const pg = { engine: "postgres" as const, host: "127.0.0.1", port: 5432, user: "postgres", password: "lfg", database: "recruiting" };
  expect(formatConnection("url", pg)).toBe("postgresql://postgres:lfg@127.0.0.1:5432/recruiting");
  expect(formatConnection("dotnet-npgsql", pg)).toBe("Host=127.0.0.1;Port=5432;Database=recruiting;Username=postgres;Password=lfg");
  expect(formatConnection("url", { ...pg, engine: "redis", port: 6379 })).toBe("redis://127.0.0.1:6379");

  expect(localizeCommand("cd /data/project && dotnet run --urls http://0.0.0.0:5000", "/Users/a/LFG/previews/x")).toBe("cd /Users/a/LFG/previews/x && dotnet run --urls http://127.0.0.1:5000");
  expect(previewCommands({ installCmd: "npm ci", runCmd: "npm run dev", port: 3000, databases: [], migrations: ["npx prisma migrate deploy"] }))
    .toEqual(["npm ci", "npx prisma migrate deploy", "npm run dev"]);

  const ok = payload({ plan: { runCmd: "x", port: 3000, databases: [] } });
  expect(validatePreviewPayload(ok, true)).toBeNull();
  expect(validatePreviewPayload({ ...ok, repoUrl: `file://${bare}` }, false)).toContain("repository URL");
  expect(validatePreviewPayload({ ...ok, branch: "--evil" }, true)).toContain("invalid branch");
  expect(validatePreviewPayload({ ...ok, plan: { runCmd: "x", port: 3000, databases: [], services: [{ name: "a", runCmd: "x", port: 3001, dir: "../../etc" }] } }, true)).toContain("outside the repository");
  expect(readFileSync(join(workRoot, "previews", ".pub-rec.json"), "utf8")).toContain("installedCommit");
});
