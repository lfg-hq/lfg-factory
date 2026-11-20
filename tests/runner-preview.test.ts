// Previews on the person's computer: where they run, how they're offered to LFG Desktop,
// and how its reports become the Preview tab's state. Run on its own: bun test tests/runner-preview.test.ts
import { test, expect, beforeAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

const root = mkdtempSync(join(tmpdir(), "lfg-runner-preview-"));
process.env.DATABASE_URL = join(root, "test.db");
process.env.DATABASE_DRIVER = "sqlite";
process.env.BETTER_AUTH_SECRET = "runner-preview-secret-only-not-a-real-secret";
process.env.BETTER_AUTH_URL = "http://localhost:8000";
const generation = Bun.spawnSync(["bun", "node_modules/drizzle-kit/bin.cjs", "generate", "--dialect", "sqlite", "--schema", "./src/db/schema/sqlite/index.ts", "--out", join(root, "schema")]);
if (generation.exitCode) throw new Error(generation.stderr.toString());
const sqlite = new Database(process.env.DATABASE_URL);
for (const f of readdirSync(join(root, "schema")).filter(f => f.endsWith(".sql"))) sqlite.exec(readFileSync(join(root, "schema", f), "utf8"));
sqlite.close();

const { db } = await import("../src/config/db.ts");
const { users } = await import("../src/db/schema/users.ts");
const { projects, projectEnvironmentVariables } = await import("../src/db/schema/projects.ts");
const { projectEnvironments } = await import("../src/db/schema/project-environments.ts");
const { projectTickets } = await import("../src/db/schema/tickets.ts");
const { runnerJobs } = await import("../src/db/schema/runners.ts");
const { encryptSecret } = await import("../src/utils/crypto.ts");
const hub = await import("../src/services/runner/hub.ts");
const { setLocalAiSettings } = await import("../src/services/runner/opt-in.ts");
const preview = await import("../src/services/runner/preview-job.ts");
type Msg = import("../src/services/runner/protocol.ts").ServerToRunner;

function fakeConn(deviceId: string, userId: string, deviceName = deviceId) {
  const sent: Msg[] = [];
  const conn = { deviceId, userId, deviceName, closed: false, sent, send: (m: Msg) => { sent.push(m); }, close() { conn.closed = true; } };
  return conn;
}
const offers = (c: { sent: Msg[] }) => c.sent.filter(m => m.type === "job.offer") as Extract<Msg, { type: "job.offer" }>[];
const say = (c: ReturnType<typeof fakeConn>, m: object) => hub.runnerMessage(c, JSON.stringify(m));
const jobRow = async (id: string) => (await db.select().from(runnerJobs).where(eq(runnerJobs.id, id)))[0]!;

const manifest = {
  stack: "Next.js + Prisma", runtime: "node", framework: "next", toolchain: ["apk add nodejs"],
  installCmd: "npm ci", buildCmd: "", startupProject: "", runCmd: "npm run dev -- -H 0.0.0.0", port: 3000,
  services: [
    { name: "web", runCmd: "npm run dev", port: 3000, primary: true },
    { name: "admin", runCmd: "npm run admin", port: 3001, enabled: true, dir: "apps/admin" },
    { name: "docs", runCmd: "npm run docs", port: 3002, enabled: false },
  ],
  databases: [{ engine: "postgres", connectionEnvVar: "DATABASE_URL", connectionFormat: "url" }],
  migrations: ["npx prisma migrate deploy"], sqlScripts: [], seedCmd: "npm run seed", envVars: [],
};

let n = 0;
async function newProject() {
  n++;
  await db.insert(projects).values({ id: `p${n}`, projectId: `pub-p${n}`, name: `Recruiting ${n}`, ownerId: "alice", repoUrl: "https://github.com/acme/recruiting" });
  await db.insert(projectEnvironments).values({ projectId: `p${n}`, workspaceId: `ws-${n}`, setupManifest: JSON.stringify(manifest) } as any);
  await db.insert(projectTickets).values({ id: `t${n}`, projectId: `p${n}`, ticketKey: `REC-${n}`, name: "SDR backend", description: "x", githubBranch: `feature/rec-${n}` });
  await db.insert(projectEnvironmentVariables).values({ projectId: `p${n}`, key: "ELEVENLABS_API_KEY", encryptedValue: encryptSecret("sk-test") } as any);
  return { projectId: `p${n}`, ticketId: `t${n}`, publicId: `pub-p${n}` };
}

beforeAll(async () => {
  for (const id of ["alice", "bob"]) await db.insert(users).values({ id, name: id, email: `${id}@example.com` });
  await setLocalAiSettings("alice", { enabled: true });
});
beforeEach(() => { hub._resetRunnerHubForTests(); preview._resetLocalPreviewsForTests(); });

test("previews run on the computer when Use my computer for AI is on, unless asked for the cloud", async () => {
  const { ticketId } = await newProject();
  expect(await preview.resolvePreviewWhere("alice")).toEqual({ where: "computer" });
  expect(await preview.resolvePreviewWhere("alice", { requested: "cloud" })).toEqual({ where: "cloud" });
  expect(await preview.resolvePreviewWhere("bob")).toEqual({ where: "cloud" }); // setting off
  await db.update(projectTickets).set({ details: { buildWith: "cloud" } } as any).where(eq(projectTickets.id, ticketId));
  const pinned = await preview.resolvePreviewWhere("alice", { ticketId });
  expect(pinned.where).toBe("cloud");
  expect((pinned as { reason?: string }).reason).toContain("cloud");
});

test("the saved plan becomes the computer's plan: switched-on apps only, no Alpine toolchain", () => {
  const plan = preview.planFromManifest(JSON.stringify(manifest))!;
  expect(plan.runCmd).toBe("npm run dev -- -H 0.0.0.0");
  expect(plan.port).toBe(3000);
  expect(plan.services).toEqual([{ name: "admin", runCmd: "npm run admin", port: 3001, dir: "apps/admin" }]);
  expect(plan.databases).toEqual([{ engine: "postgres", connectionEnvVar: "DATABASE_URL", connectionFormat: "url" }]);
  expect(plan.migrations).toEqual(["npx prisma migrate deploy"]);
  expect(JSON.stringify(plan)).not.toContain("apk");
  expect(preview.planFromManifest(null)).toBeNull();
  expect(preview.planFromManifest(JSON.stringify({ runCmd: "", port: 3000 }))).toBeNull();
});

test("with no computer connected, the preview waits for it", async () => {
  const { projectId } = await newProject();
  const job = await preview.startLocalPreview({ projectId, userId: "alice", branch: null, refresh: true });
  expect(job.status).toBe("queued");
  expect(job.type).toBe("preview");
  expect(job.ticketId).toBeNull(); // never touches a ticket's status
  const state = await preview.localPreviewState("alice", projectId);
  expect(state.where).toBe("computer");
  expect(state.waiting).toBe(true);
  expect(state.waitingMessage).toContain("Waiting for your computer");
});

test("an LFG Desktop too old for previews isn't sent one, and the person is told to update", async () => {
  const { projectId } = await newProject();
  const oldMac = fakeConn("old-mac", "alice");
  await hub.runnerOpened(oldMac);
  await say(oldMac, { type: "hello", activeJobIds: [] }); // no protocol: version 2
  const job = await preview.startLocalPreview({ projectId, userId: "alice", branch: null, refresh: true });
  expect(offers(oldMac)).toHaveLength(0);
  expect((await jobRow(job.id)).status).toBe("queued");
  expect((await preview.localPreviewState("alice", projectId)).waitingMessage).toContain("Update LFG Desktop");

  // A newer computer connecting picks it up.
  const newMac = fakeConn("new-mac", "alice");
  await hub.runnerOpened(newMac);
  await say(newMac, { type: "hello", activeJobIds: [], protocol: 3 });
  expect(offers(newMac).map(o => o.job.id)).toContain(job.id);
});

test("offered with the plan, env and the ticket's branch; reports become the Preview tab's state", async () => {
  const { projectId, ticketId, publicId } = await newProject();
  const mac = fakeConn("mac", "alice", "Alice's Mac");
  await hub.runnerOpened(mac);
  await say(mac, { type: "hello", activeJobIds: [], protocol: 3 });
  const target = await preview.resolvePreviewBranch(projectId, { ticketId });
  expect(target.branch).toBe(`feature/rec-${n}`);
  const job = await preview.startLocalPreview({ projectId, userId: "alice", refresh: true, ...target });

  const offer = offers(mac).at(-1)!.job;
  expect(offer.type).toBe("preview");
  if (offer.type !== "preview") throw new Error("not a preview");
  expect(offer.payload.branch).toBe(`feature/rec-${n}`);
  expect(offer.payload.projectId).toBe(publicId);
  expect(offer.payload.plan?.runCmd).toBe("npm run dev -- -H 0.0.0.0");
  expect(offer.payload.env).toEqual({ ELEVENLABS_API_KEY: "sk-test" });
  expect(offer.payload.refresh).toBe(true);

  await say(mac, { type: "job.accepted", jobId: job.id });
  let state = await preview.localPreviewState("alice", projectId);
  expect(state.previewStatus).toBe("detecting");
  expect(state.waiting).toBe(false);
  expect(state.deviceName).toBe("Alice's Mac");

  await say(mac, { type: "job.preview", jobId: job.id, update: { status: "installing", lines: ["$ npm ci"], steps: [{ id: "install", label: "Install dependencies", status: "running" }] } });
  state = await preview.localPreviewState("alice", projectId);
  expect(state.previewStatus).toBe("installing");
  expect(state.log).toContain("$ npm ci");
  expect(state.steps[0]).toMatchObject({ id: "install", phase: "install", status: "running" });

  await say(mac, { type: "job.preview", jobId: job.id, update: { status: "running", urls: [
    { name: "web", url: "http://localhost:3000", port: 3000, primary: true },
    { name: "evil", url: "https://attacker.example", port: 443 }, // only this computer's own addresses are kept
  ] } });
  state = await preview.localPreviewState("alice", projectId);
  expect(state.previewStatus).toBe("running");
  expect(state.previewUrl).toBe("http://localhost:3000");
  expect(state.services.map(s => s.url)).toEqual(["http://localhost:3000"]);
  expect(state.branch).toBe(`feature/rec-${n}`);

  // The state survives a server restart (it's on the job row, not only in memory).
  preview._resetLocalPreviewsForTests();
  expect((await preview.localPreviewState("alice", projectId)).previewUrl).toBe("http://localhost:3000");

  // Bob can't report on Alice's preview.
  const bobsMac = fakeConn("bob-mac", "bob");
  await hub.runnerOpened(bobsMac);
  await say(bobsMac, { type: "job.preview", jobId: job.id, update: { status: "error", error: "nope" } });
  expect((await preview.localPreviewState("alice", projectId)).previewStatus).toBe("running");
});

test("restarting replaces the running preview, keeping its branch; stop cancels it on the computer", async () => {
  const { projectId, ticketId } = await newProject();
  const mac = fakeConn("mac2", "alice");
  await hub.runnerOpened(mac);
  await say(mac, { type: "hello", activeJobIds: [], protocol: 3 });
  const first = await preview.startLocalPreview({ projectId, userId: "alice", refresh: true, ...(await preview.resolvePreviewBranch(projectId, { ticketId })) });
  await say(mac, { type: "job.accepted", jobId: first.id });

  const second = await preview.startLocalPreview({ projectId, userId: "alice", refresh: false });
  expect((await jobRow(first.id)).status).toBe("cancelled");
  expect(mac.sent.some(m => m.type === "job.cancel" && m.jobId === first.id)).toBe(true);
  const offer = offers(mac).at(-1)!.job;
  if (offer.type !== "preview") throw new Error("not a preview");
  expect(offer.id).toBe(second.id);
  expect(offer.payload.branch).toBe(`feature/rec-${n}`); // a plain restart keeps the branch
  expect(offer.payload.refresh).toBe(false);

  await say(mac, { type: "job.accepted", jobId: second.id });
  await preview.stopLocalPreview("alice", projectId);
  expect((await jobRow(second.id)).status).toBe("cancelled");
  expect((await preview.localPreviewState("alice", projectId)).previewStatus).toBe("stopped");
});

test("a failure on the computer shows as a plain error, and a waiter hears about it", async () => {
  const { projectId } = await newProject();
  const mac = fakeConn("mac3", "alice");
  await hub.runnerOpened(mac);
  await say(mac, { type: "hello", activeJobIds: [], protocol: 3 });
  const job = await preview.startLocalPreview({ projectId, userId: "alice", branch: null, refresh: true });
  const waited = preview.waitForLocalPreview(job.id, 5000);
  await say(mac, { type: "job.accepted", jobId: job.id });
  const why = "This app needs Postgres, and this computer has neither Postgres running nor Docker.";
  await say(mac, { type: "job.preview", jobId: job.id, update: { status: "error", error: why } });
  await say(mac, { type: "job.finished", jobId: job.id, ok: false, error: why });
  expect(await waited).toEqual({ error: why });
  const state = await preview.localPreviewState("alice", projectId);
  expect(state.previewStatus).toBe("error");
  expect(state.error).toBe(why);
  expect((await jobRow(job.id)).status).toBe("failed");
});

test("a declined preview says so", async () => {
  const { projectId } = await newProject();
  const mac = fakeConn("mac4", "alice");
  await hub.runnerOpened(mac);
  await say(mac, { type: "hello", activeJobIds: [], protocol: 3 });
  const job = await preview.startLocalPreview({ projectId, userId: "alice", branch: null, refresh: true });
  await say(mac, { type: "job.rejected", jobId: job.id, reason: "Declined on this computer" });
  const state = await preview.localPreviewState("alice", projectId);
  expect(state.previewStatus).toBe("error");
  expect(state.error).toContain("Declined on this computer");
});

test("an epic's branch and the default branch resolve; a bad branch name is refused", async () => {
  const { projectId } = await newProject();
  expect(await preview.resolvePreviewBranch(projectId, { branch: "(default)" })).toEqual({ branch: null, label: "Default branch" });
  expect((await preview.resolvePreviewBranch(projectId, { branch: "epic/rec-e1" })).branch).toBe("epic/rec-e1");
  await expect(preview.resolvePreviewBranch(projectId, { branch: "--upload-pack=x" })).rejects.toThrow();
});

// ── Data operations (test logins, test data) on the preview on the computer ──

async function runningOnMac(protocol: number) {
  const { projectId, publicId } = await newProject();
  const mac = fakeConn(`mac-data-${n}`, "alice", "Alice's Mac");
  await hub.runnerOpened(mac);
  await say(mac, { type: "hello", activeJobIds: [], protocol });
  const job = await preview.startLocalPreview({ projectId, userId: "alice", branch: "epic/sdr", refresh: false });
  await say(mac, { type: "job.accepted", jobId: job.id });
  await say(mac, { type: "job.preview", jobId: job.id, update: { status: "running", urls: [{ name: "web", url: "http://localhost:3000", port: 3000, primary: true }] } });
  return { projectId, publicId, mac };
}

test("a data operation goes to the preview on the computer as data only, and its result comes back", async () => {
  const { projectId, publicId, mac } = await runningOnMac(4);
  expect(await preview.runningLocalPreview("alice", projectId)).toMatchObject({ url: "http://localhost:3000", branch: "epic/sdr", publicProjectId: publicId });

  const input = { kind: "database", connectionKey: "DATABASE_URL", sql: "select count(*) from \"user\"", params: [] };
  const pending = preview.runLocalPreviewData("alice", projectId, input, "Checking app data");
  await Bun.sleep(20);
  const offer = offers(mac).find(o => o.job.type === "preview_data")!.job;
  if (offer.type !== "preview_data") throw new Error("no data offer");
  // Only the input travels; no program or shell command.
  expect(offer.payload).toEqual({ protocol: 4, projectId: publicId, projectName: expect.any(String), activity: "Checking app data", input });
  expect(JSON.stringify(offer.payload)).not.toContain("node -e");

  await say(mac, { type: "job.accepted", jobId: offer.id });
  await say(mac, { type: "job.finished", jobId: offer.id, ok: true, summary: JSON.stringify({ exitCode: 0, output: '{"rows":[{"count":"1"}]}' }) });
  expect(await pending).toEqual({ exitCode: 0, output: '{"rows":[{"count":"1"}]}' });
  // The finished data job leaves the preview itself alone.
  expect((await preview.localPreviewState("alice", projectId)).previewStatus).toBe("running");
});

test("a computer that declines, or an LFG Desktop too old for data operations, is reported plainly", async () => {
  const { projectId, mac } = await runningOnMac(4);
  const pending = preview.runLocalPreviewData("alice", projectId, { kind: "databaseInfo", connectionKeys: [] }, "Check");
  await Bun.sleep(20);
  const offer = offers(mac).find(o => o.job.type === "preview_data")!.job;
  await say(mac, { type: "job.rejected", jobId: offer.id, reason: "Declined on this computer" });
  await expect(pending).rejects.toThrow("Declined on this computer");

  const old = await runningOnMac(3);
  await expect(preview.runLocalPreviewData("alice", old.projectId, { kind: "databaseInfo", connectionKeys: [] }, "Check")).rejects.toThrow("Update LFG Desktop");
  expect(offers(old.mac).some(o => o.job.type === "preview_data")).toBe(false);
});

test("no data operation when the preview on the computer isn't running", async () => {
  const { projectId } = await newProject();
  expect(await preview.runningLocalPreview("alice", projectId)).toBeNull();
  await expect(preview.runLocalPreviewData("alice", projectId, { kind: "databaseInfo", connectionKeys: [] }, "Check")).rejects.toThrow("isn't running");
});

test("a preview survives its computer dropping off: it shows as away, then running again when LFG Desktop reports back", async () => {
  const { projectId, mac } = await runningOnMac(4);
  const job = (await db.select().from(runnerJobs).where(eq(runnerJobs.projectId, projectId))).find(j => j.type === "preview")!;
  hub.runnerClosed(mac);
  await Bun.sleep(20);
  let state = await preview.localPreviewState("alice", projectId);
  expect(state.waiting).toBe(true);
  expect(state.waitingMessage).toContain("Lost contact");
  expect(await preview.runningLocalPreview("alice", projectId)).toBeNull(); // the agent won't act on it meanwhile
  expect((await jobRow(job.id)).status).toBe("running"); // not failed

  const back = fakeConn(mac.deviceId, "alice", "Alice's Mac");
  await hub.runnerOpened(back);
  await say(back, { type: "hello", activeJobIds: [job.id], protocol: 4 });
  await say(back, { type: "job.preview", jobId: job.id, update: { status: "running", error: "", urls: [{ name: "web", url: "http://localhost:3000", port: 3000, primary: true }] } });
  state = await preview.localPreviewState("alice", projectId);
  expect(state.previewStatus).toBe("running");
  expect(state.waiting).toBe(false);
  expect(state.previewUrl).toBe("http://localhost:3000");
});

test("a preview an older server gave up on ('Lost contact') is taken back when the computer says it still runs it", async () => {
  const { projectId, mac } = await runningOnMac(4);
  const job = (await db.select().from(runnerJobs).where(eq(runnerJobs.projectId, projectId))).find(j => j.type === "preview")!;
  await db.update(runnerJobs).set({ status: "failed", error: "Lost contact with Alice's Mac.", finishedAt: new Date() }).where(eq(runnerJobs.id, job.id));
  await say(mac, { type: "hello", activeJobIds: [job.id], protocol: 4 });
  expect((await jobRow(job.id)).status).toBe("running");
  await say(mac, { type: "job.preview", jobId: job.id, update: { status: "running", error: "", urls: [{ name: "web", url: "http://localhost:3000", port: 3000, primary: true }] } });
  const state = await preview.localPreviewState("alice", projectId);
  expect(state.previewStatus).toBe("running");
  expect(state.error).toBeNull();
});
