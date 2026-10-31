/**
 * Seeds the isolated LFG Desktop test environment used by desktop/try.sh.
 *
 * Run with the test env file (never your real .env), e.g.
 *   bun --env-file=.desktop-test/test.env scripts/desktop-test-setup.ts .desktop-test
 *
 * Idempotent. Creates, inside <dir>:
 *   - the SQLite schema (lfg.db) if it isn't there yet
 *   - a verified test account, password kept in credentials.json
 *   - a local bare Git repo (demo-origin.git) with a tiny web page on `main`
 *   - a "Desktop runner demo" project pointing at that repo, with one ticket
 *   - a freshly paired computer (previous test pairings are revoked)
 * and prints the details as one JSON line.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const dir = resolve(process.argv[2] ?? ".desktop-test");
if (process.env.DATABASE_DRIVER !== "sqlite" || !process.env.DATABASE_URL?.startsWith(dir)) {
  console.error("Refusing to run: use the test env file, whose DATABASE_URL points inside " + dir);
  process.exit(2);
}
mkdirSync(dir, { recursive: true });

// ── Schema ───────────────────────────────────────────────────────────
const dbFile = process.env.DATABASE_URL;
const hasSchema = (() => {
  if (!existsSync(dbFile)) return false;
  const db = new Database(dbFile);
  try { return !!db.query("select 1 from sqlite_master where name = 'runner_job'").get(); } finally { db.close(); }
})();
if (!hasSchema) {
  const out = mkdtempSync(join(tmpdir(), "lfg-desktop-schema-"));
  const gen = Bun.spawnSync(["bun", "node_modules/drizzle-kit/bin.cjs", "generate", "--dialect", "sqlite", "--schema", "./src/db/schema/sqlite/index.ts", "--out", out]);
  if (gen.exitCode) { console.error(gen.stderr.toString()); process.exit(1); }
  const sqlite = new Database(dbFile);
  for (const f of readdirSync(out).filter(f => f.endsWith(".sql"))) sqlite.exec(readFileSync(join(out, f), "utf8"));
  sqlite.close();
}

const { eq, and, like } = await import("drizzle-orm");
const { db } = await import("../src/config/db.ts");
const { auth } = await import("../src/auth/index.ts");
const { users } = await import("../src/db/schema/users.ts");
const { projects } = await import("../src/db/schema/projects.ts");
const { projectTickets, ticketStages } = await import("../src/db/schema/tickets.ts");
const { runnerDevices } = await import("../src/db/schema/runners.ts");
const { teamAccess } = await import("../src/services/team-access.ts");
const { nextTicketKey } = await import("../src/utils/ticket-keys.ts");
const { createRunnerDevice } = await import("../src/services/runner/hub.ts");

// ── Test account ─────────────────────────────────────────────────────
const email = "desktop-test@lfg.localhost";
const credFile = join(dir, "credentials.json");
const saved = existsSync(credFile) ? JSON.parse(readFileSync(credFile, "utf8")) as { email: string; password: string } : null;
let [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
let password = saved?.password;
if (!user || !password) {
  password = randomBytes(12).toString("base64url");
  if (user) await db.delete(users).where(eq(users.id, user.id)); // lost its password: start over
  await auth.api.signUpEmail({ body: { email, password, name: "Desktop Tester" } });
  [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  writeFileSync(credFile, JSON.stringify({ email, password }, null, 2), { mode: 0o600 });
}
await db.update(users).set({ emailVerified: true }).where(eq(users.id, user!.id));
const userId = user!.id;

// ── Demo repository ──────────────────────────────────────────────────
const origin = join(dir, "demo-origin.git");
const git = (args: string[], cwd?: string) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "LFG Demo", GIT_AUTHOR_EMAIL: "demo@lfg.localhost", GIT_COMMITTER_NAME: "LFG Demo", GIT_COMMITTER_EMAIL: "demo@lfg.localhost" } });
  if (r.exitCode) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
if (!existsSync(origin)) {
  git(["init", "--bare", "-b", "main", origin]);
  const seed = mkdtempSync(join(tmpdir(), "lfg-desktop-seed-"));
  git(["clone", origin, seed]);
  writeFileSync(join(seed, "index.html"), `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Demo</title><link rel="stylesheet" href="style.css"></head>
<body>
  <h1>Hello from the demo app</h1>
  <p>A tiny page for trying LFG Desktop.</p>
</body>
</html>
`);
  writeFileSync(join(seed, "style.css"), "body { font-family: system-ui, sans-serif; margin: 3rem; background: #fff; color: #111; }\n");
  writeFileSync(join(seed, "README.md"), "# Demo app\n\nA static page used to test LFG Desktop. Open index.html in a browser.\n");
  git(["add", "-A"], seed);
  git(["commit", "-m", "Demo app"], seed);
  git(["push", "origin", "HEAD:main"], seed);
}

// ── Project and ticket ───────────────────────────────────────────────
const projectName = "Desktop runner demo";
let [project] = await db.select().from(projects).where(and(eq(projects.ownerId, userId), eq(projects.name, projectName))).limit(1);
if (!project) {
  const team = (await teamAccess(userId)).team;
  [project] = await db.insert(projects).values({
    name: projectName, description: "A local demo repo for trying LFG Desktop.", icon: "💻",
    ownerId: userId, organizationId: team.id, repoUrl: `file://${origin}`,
  }).returning();
  await db.insert(ticketStages).values([
    { name: "Backlog", color: "#6b7280", order: 0, isDefault: true, isCompleted: false },
    { name: "Todo", color: "#3b82f6", order: 1, isDefault: false, isCompleted: false },
    { name: "In Progress", color: "#f59e0b", order: 2, isDefault: false, isCompleted: false },
    { name: "In Review", color: "#8b5cf6", order: 3, isDefault: false, isCompleted: false },
    { name: "Failed / Blocked", color: "#ef4444", order: 4, isDefault: false, isCompleted: false },
    { name: "Done", color: "#22c55e", order: 5, isDefault: false, isCompleted: true },
    { name: "Archive", color: "#64748b", order: 6, isDefault: false, isCompleted: true },
  ].map(s => ({ ...s, projectId: project!.id })));
}
const ticketName = "Add a dark mode toggle";
let [ticket] = await db.select().from(projectTickets)
  .where(and(eq(projectTickets.projectId, project!.id), eq(projectTickets.name, ticketName), eq(projectTickets.queueStatus, "none"), like(projectTickets.status, "open")))
  .limit(1);
if (!ticket) {
  const [backlog] = await db.select().from(ticketStages).where(and(eq(ticketStages.projectId, project!.id), eq(ticketStages.name, "Backlog"))).limit(1);
  [ticket] = await db.insert(projectTickets).values({
    projectId: project!.id,
    ticketKey: await nextTicketKey(project!.id, project!.name),
    name: ticketName,
    description: "Add a button to index.html that switches the page between light and dark colours, and remembers the choice in localStorage.",
    acceptanceCriteria: ["A visible toggle button on the page", "Dark mode changes the background and text colours", "The choice survives a page reload"],
    stageId: backlog?.id ?? null,
  }).returning();
}

// ── Pair this computer ───────────────────────────────────────────────
const deviceName = `${hostname().replace(/\.local$/, "")} (test)`;
await db.update(runnerDevices).set({ revokedAt: new Date() }).where(eq(runnerDevices.userId, userId));
const { token } = await createRunnerDevice(userId, deviceName);

console.log(JSON.stringify({
  email, password, token, deviceName,
  projectUrl: `/projects/${project!.projectId}`,
  projectId: project!.projectId,
  ticketKey: ticket!.ticketKey,
  ticketName: ticket!.name,
  origin,
}));
process.exit(0);
