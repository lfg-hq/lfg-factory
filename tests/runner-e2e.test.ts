// End to end: server hub ⇄ WebSocket ⇄ desktop runner ⇄ git, with a stand-in `claude`
// that edits a file and prints stream-json. No paid inference.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

const root = mkdtempSync(join(tmpdir(), "lfg-runner-e2e-"));
process.env.DATABASE_URL = join(root, "test.db");
process.env.DATABASE_DRIVER = "sqlite";
process.env.BETTER_AUTH_SECRET = "runner-e2e-secret-only-not-a-real-secret";
process.env.BETTER_AUTH_URL = "http://localhost:8000";
const generation = Bun.spawnSync(["bun", "node_modules/drizzle-kit/bin.cjs", "generate", "--dialect", "sqlite", "--schema", "./src/db/schema/sqlite/index.ts", "--out", join(root, "schema")]);
if (generation.exitCode) throw new Error(generation.stderr.toString());
const sqlite = new Database(process.env.DATABASE_URL);
for (const f of readdirSync(join(root, "schema")).filter(f => f.endsWith(".sql"))) sqlite.exec(readFileSync(join(root, "schema", f), "utf8"));
sqlite.close();

const { db } = await import("../src/config/db.ts");
const { users } = await import("../src/db/schema/users.ts");
const { projects } = await import("../src/db/schema/projects.ts");
const { projectTickets, ticketLogs } = await import("../src/db/schema/tickets.ts");
const { runnerJobs } = await import("../src/db/schema/runners.ts");
const hub = await import("../src/services/runner/hub.ts");
const { startTicketOnRunner } = await import("../src/services/runner/ticket-job.ts");
const { Runner } = await import("../desktop/src/runner.ts");
type SocketFactory = import("../desktop/src/runner.ts").SocketFactory;
type RunnerConn = import("../src/services/runner/hub.ts").RunnerConn;

const sh = (cmd: string[], cwd?: string) => {
  const r = Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.exitCode) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

// Same wiring as src/index.ts: device-token upgrade, sockets handed to the hub.
type Data = { deviceId: string; deviceName: string; userId: string; conn?: RunnerConn };
let server: ReturnType<typeof Bun.serve<Data, never>>;
const conn = (ws: import("bun").ServerWebSocket<Data>) => ws.data.conn ??= {
  deviceId: ws.data.deviceId, deviceName: ws.data.deviceName, userId: ws.data.userId,
  send: m => ws.send(JSON.stringify(m)), close: (c, r) => ws.close(c, r),
};

const bunSockets: SocketFactory = (url, headers) => new WebSocket(url, { headers } as any) as any;
const bare = join(root, "origin.git");
const fakeClaude = join(root, "claude");
let token = "";

beforeAll(async () => {
  await db.insert(users).values({ id: "erin", name: "Erin", email: "erin@example.com" });
  token = (await hub.createRunnerDevice("erin", "Erin's Mac")).token;

  server = Bun.serve<Data, never>({
    port: 0,
    async fetch(req, srv) {
      const device = await hub.authenticateRunnerToken(req.headers.get("authorization")?.replace(/^Bearer\s+/i, ""));
      if (!device) return new Response("Unauthorized", { status: 401 });
      return srv.upgrade(req, { data: { deviceId: device.id, deviceName: device.name, userId: device.userId } })
        ? undefined as unknown as Response : new Response("upgrade failed", { status: 500 });
    },
    websocket: {
      open: ws => { void hub.runnerOpened(conn(ws)); },
      close: ws => hub.runnerClosed(conn(ws)),
      message: (ws, data) => { void hub.runnerMessage(conn(ws), data as string); },
    },
  });

  sh(["git", "init", "--bare", "-b", "main", bare]);
  const seed = join(root, "seed");
  sh(["git", "clone", bare, seed]);
  writeFileSync(join(seed, "README.md"), "# App\n");
  sh(["git", "add", "-A"], seed);
  sh(["git", "commit", "-m", "init"], seed);
  sh(["git", "push", "origin", "HEAD:main"], seed);

  writeFileSync(fakeClaude, `#!/bin/bash
if [ "$1" = "--version" ]; then echo "2.9.9 (Claude Code)"; exit 0; fi
echo "export const login = true;" > login.ts
echo '{"type":"system","subtype":"init"}'
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu1","name":"Write","input":{"file_path":"login.ts"}}]}}'
echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu1","content":"File written"}]}}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Added the login module."}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"Added the login module."}'
`);
  chmodSync(fakeClaude, 0o755);
});
afterAll(() => server?.stop(true));

async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(50);
  }
}

test("a ticket started on the server is built and pushed by the person's computer", async () => {
  await db.insert(projects).values({ id: "e2e-p", projectId: "pub-e2e-p", name: "App", ownerId: "erin", repoUrl: `file://${bare}` });
  await db.insert(projectTickets).values({ id: "e2e-t", projectId: "e2e-p", ticketKey: "APP-1", name: "Add login", description: "Users can log in." });

  const prompts: string[] = [];
  const states: string[] = [];
  const runner = new Runner({
    serverUrl: `http://localhost:${server.port}`, token, workRoot: join(root, "work"),
    createSocket: bunSockets, claudeBin: fakeClaude, allowLocalRepos: true,
    approve: async job => { prompts.push(job.payload.prompt); return { approved: true }; },
    onState: s => states.push(s),
  });
  runner.start();
  await waitFor(async () => states.includes("connected"));

  const job = await startTicketOnRunner({ projectId: "e2e-p", ticketId: "e2e-t", actorId: "erin" });
  const done = await waitFor(async () => {
    const [row] = await db.select().from(runnerJobs).where(eq(runnerJobs.id, job.id));
    return row && /succeeded|failed/.test(row.status) ? row : null;
  });
  runner.stop();

  expect(done.error).toBeNull();
  expect(done.status).toBe("succeeded");
  expect(prompts[0]).toContain("Users can log in.");
  // The branch really landed on the remote, with Claude's file in it.
  expect(sh(["git", "--git-dir", bare, "rev-parse", "refs/heads/feature/app-1-add-login"])).toBe(done.commitSha!);
  expect(sh(["git", "--git-dir", bare, "show", `${done.commitSha}:login.ts`])).toBe("export const login = true;");
  expect(sh(["git", "--git-dir", bare, "log", "-1", "--format=%s", done.commitSha!])).toBe("APP-1: Add login");

  const [ticket] = await db.select().from(projectTickets).where(eq(projectTickets.id, "e2e-t"));
  expect([ticket!.status, ticket!.queueStatus, ticket!.githubBranch]).toEqual(["review", "none", "feature/app-1-add-login"]);
  const logs = (await db.select().from(ticketLogs).where(eq(ticketLogs.ticketId, "e2e-t"))).map(l => l.command ?? "");
  expect(logs.some(l => l.includes("Added the login module."))).toBe(true);
  expect(logs.some(l => l.startsWith("Pushed "))).toBe(true);
});

test("a wrong token is told it's unauthorized and stops retrying", async () => {
  const states: string[] = [];
  const runner = new Runner({
    serverUrl: `http://localhost:${server.port}`, token: "lfgr_wrong", workRoot: join(root, "work2"),
    createSocket: (url, headers) => {
      // Bun's WebSocket reports a rejected handshake only as a close; mark it the way socket.ts does for `ws`.
      const ws = bunSockets(url, headers);
      fetch(url.replace(/^ws/, "http"), { headers }).then(r => { if (r.status === 401) (ws as any).unauthorized = true; });
      return ws;
    },
    approve: async () => ({ approved: true }), onState: s => states.push(s),
  });
  runner.start();
  await waitFor(async () => states.includes("unauthorized") || null, 5_000);
  runner.stop();
});
