import { test, expect, beforeAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

const root = mkdtempSync(join(tmpdir(), "lfg-runner-"));
process.env.DATABASE_URL = join(root, "test.db");
process.env.DATABASE_DRIVER = "sqlite";
process.env.BETTER_AUTH_SECRET = "runner-test-secret-only-not-a-real-secret";
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
const { startTicketOnRunner, RunnerJobError } = await import("../src/services/runner/ticket-job.ts");
type Msg = import("../src/services/runner/protocol.ts").ServerToRunner;

function fakeConn(deviceId: string, userId: string, deviceName = deviceId) {
  const sent: Msg[] = [];
  const conn = { deviceId, userId, deviceName, closed: false, sent, send: (m: Msg) => { sent.push(m); }, close() { conn.closed = true; } };
  return conn;
}
const offers = (c: { sent: Msg[] }) => c.sent.filter(m => m.type === "job.offer") as Extract<Msg, { type: "job.offer" }>[];
const say = (c: ReturnType<typeof fakeConn>, m: object) => hub.runnerMessage(c, JSON.stringify(m));
const jobRow = async (id: string) => (await db.select().from(runnerJobs).where(eq(runnerJobs.id, id)))[0]!;
const ticketRow = async (id: string) => (await db.select().from(projectTickets).where(eq(projectTickets.id, id)))[0]!;

let n = 0;
async function newTicket(opts: { repo?: boolean } = {}) {
  n++;
  await db.insert(projects).values({ id: `p${n}`, projectId: `pub-p${n}`, name: `Project ${n}`, ownerId: "alice", repoUrl: opts.repo === false ? null : "https://github.com/acme/app" });
  await db.insert(projectTickets).values({ id: `t${n}`, projectId: `p${n}`, ticketKey: `APP-${n}`, name: "Add login", description: "Users can log in.", acceptanceCriteria: ["Login form works"] });
  return { projectId: `p${n}`, ticketId: `t${n}` };
}

beforeAll(async () => {
  for (const id of ["alice", "bob"]) await db.insert(users).values({ id, name: id, email: `${id}@example.com` });
});
beforeEach(() => hub._resetRunnerHubForTests());

test("device tokens authenticate until revoked, and only a hash is stored", async () => {
  const { id, token } = await hub.createRunnerDevice("alice", "Alice's Mac");
  expect((await hub.authenticateRunnerToken(token))?.id).toBe(id);
  expect(JSON.stringify(await db.select().from((await import("../src/db/schema/runners.ts")).runnerDevices))).not.toContain(token);
  expect(await hub.revokeRunnerDevice("bob", id)).toBe(false); // not Bob's to revoke
  expect(await hub.revokeRunnerDevice("alice", id)).toBe(true);
  expect(await hub.authenticateRunnerToken(token)).toBeNull();
  expect(await hub.authenticateRunnerToken("lfgr_made-up")).toBeNull();
});

test("a job is offered only to the requester's own computer", async () => {
  const bobsMac = fakeConn("bob-mac", "bob");
  await hub.runnerOpened(bobsMac);
  const { projectId, ticketId } = await newTicket();
  const job = await startTicketOnRunner({ projectId, ticketId, actorId: "alice" });
  expect(job.status).toBe("queued");
  expect(offers(bobsMac)).toHaveLength(0);
  expect((await ticketRow(ticketId)).queueStatus).toBe("executing"); // never "queued": the cloud worker must not take it

  const alicesMac = fakeConn("alice-mac", "alice");
  await hub.runnerOpened(alicesMac);
  await say(alicesMac, { type: "hello", activeJobIds: [] });
  expect(offers(alicesMac).map(o => o.job.id)).toEqual([job.id]);
  expect(offers(bobsMac)).toHaveLength(0);
  const payload = offers(alicesMac)[0]!.job.payload;
  expect(payload.branch).toBe("feature/app-" + n + "-add-login");
  expect(payload.repoUrl).toBe("https://github.com/acme/app");
  expect(payload.prompt).toContain("Login form works");

  // Bob's computer can't act on Alice's job.
  await say(bobsMac, { type: "job.accepted", jobId: job.id });
  expect((await jobRow(job.id)).status).toBe("offered");
  expect(bobsMac.sent.at(-1)?.type).toBe("error");
});

test("accept, stream, finish: the ticket moves to review with the pushed commit", async () => {
  const mac = fakeConn("alice-mac", "alice", "Alice's Mac");
  await hub.runnerOpened(mac);
  const { projectId, ticketId } = await newTicket();
  const job = await startTicketOnRunner({ projectId, ticketId, actorId: "alice" });
  await say(mac, { type: "job.accepted", jobId: job.id });
  expect((await jobRow(job.id)).status).toBe("running");
  await say(mac, { type: "job.agent_event", jobId: job.id, event: { type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "npm test" } }] } } });
  await say(mac, { type: "job.agent_event", jobId: job.id, event: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "12 passing" }] } } });
  await say(mac, { type: "job.finished", jobId: job.id, ok: true, branch: payload(job).branch, commitSha: "abc1234def", summary: "Added login" });

  expect((await jobRow(job.id)).status).toBe("succeeded");
  const t = await ticketRow(ticketId);
  expect([t.status, t.queueStatus, t.githubCommitSha]).toEqual(["review", "none", "abc1234def"]);
  const logs = await db.select().from(ticketLogs).where(eq(ticketLogs.ticketId, ticketId));
  const cmd = logs.find(l => l.command?.includes("npm test"));
  expect(cmd?.output).toBe("12 passing");
  expect(logs.some(l => l.command?.includes("Running on Alice's Mac"))).toBe(true);

  // A finished job can't be finished again.
  await say(mac, { type: "job.finished", jobId: job.id, ok: false, error: "late" });
  expect((await jobRow(job.id)).status).toBe("succeeded");
});

test("an offered job returns to the queue when its computer disconnects", async () => {
  const laptop = fakeConn("alice-laptop", "alice");
  await hub.runnerOpened(laptop);
  const { projectId, ticketId } = await newTicket();
  const job = await startTicketOnRunner({ projectId, ticketId, actorId: "alice" });
  expect(offers(laptop)).toHaveLength(1);
  hub.runnerClosed(laptop);
  await Bun.sleep(50);
  expect((await jobRow(job.id)).status).toBe("queued");
  const desktop = fakeConn("alice-desktop", "alice");
  await hub.runnerOpened(desktop);
  await say(desktop, { type: "hello", activeJobIds: [] });
  expect(offers(desktop).map(o => o.job.id)).toEqual([job.id]);
});

test("a running job the computer no longer knows about fails on reconnect", async () => {
  const mac = fakeConn("alice-mac", "alice");
  await hub.runnerOpened(mac);
  const { projectId, ticketId } = await newTicket();
  const job = await startTicketOnRunner({ projectId, ticketId, actorId: "alice" });
  await say(mac, { type: "job.accepted", jobId: job.id });
  hub.runnerClosed(mac);
  const again = fakeConn("alice-mac", "alice");
  await hub.runnerOpened(again);
  await say(again, { type: "hello", activeJobIds: [] });
  expect((await jobRow(job.id)).status).toBe("failed");
  expect((await ticketRow(ticketId)).status).toBe("failed");
});

test("declining and cancelling", async () => {
  const mac = fakeConn("alice-mac", "alice");
  await hub.runnerOpened(mac);
  const a = await newTicket();
  const declined = await startTicketOnRunner({ ...a, actorId: "alice" });
  await say(mac, { type: "job.rejected", jobId: declined.id, reason: "Not now" });
  expect((await jobRow(declined.id)).status).toBe("rejected");
  expect((await ticketRow(a.ticketId)).queueStatus).toBe("none");

  const b = await newTicket();
  const running = await startTicketOnRunner({ ...b, actorId: "alice" });
  await say(mac, { type: "job.accepted", jobId: running.id });
  expect(await hub.cancelTicketJobs(b.ticketId)).toBe(1);
  expect(mac.sent.at(-1)).toEqual({ type: "job.cancel", jobId: running.id });
  await say(mac, { type: "job.finished", jobId: running.id, ok: true, commitSha: "fff" });
  expect((await jobRow(running.id)).status).toBe("cancelled");
});

test("a project needs a Git repository, and a busy ticket is refused", async () => {
  const noRepo = await newTicket({ repo: false });
  await expect(startTicketOnRunner({ ...noRepo, actorId: "alice" })).rejects.toBeInstanceOf(RunnerJobError);
  const busy = await newTicket();
  await startTicketOnRunner({ ...busy, actorId: "alice" });
  await expect(startTicketOnRunner({ ...busy, actorId: "alice" })).rejects.toThrow("active operation");
});

function payload(job: { payload: string }) { return JSON.parse(job.payload) as { branch: string }; }

test("runners are pinged, and one that stops answering is dropped so its job goes to another computer", async () => {
  const quiet = fakeConn("quiet-mac", "alice");
  const awake = fakeConn("awake-mac", "alice");
  await hub.runnerOpened(quiet);
  await say(quiet, { type: "hello", activeJobIds: [] });
  const { projectId, ticketId } = await newTicket();
  const job = await startTicketOnRunner({ projectId, ticketId, actorId: "alice" });
  expect(offers(quiet).map(o => o.job.id)).toContain(job.id); // offered into what is, in fact, a dead connection

  const t0 = Date.now();
  hub.runnerHeartbeat(t0 + 1000);
  expect(quiet.sent.some(m => m.type === "ping")).toBe(true);
  expect(quiet.closed).toBe(false);

  await hub.runnerOpened(awake);
  await say(awake, { type: "pong" });
  hub._setRunnerLastHeardForTests(awake, t0 + hub.RUNNER_SILENCE_MS); // it kept answering
  hub.runnerHeartbeat(t0 + hub.RUNNER_SILENCE_MS + 1000);
  expect(quiet.closed).toBe(true);
  expect(awake.closed).toBe(false); // it answered recently enough
  expect(hub.isDeviceConnected("quiet-mac")).toBe(false);
  for (let i = 0; i < 50 && !offers(awake).some(o => o.job.id === job.id); i++) await Bun.sleep(10);
  expect(offers(awake).map(o => o.job.id)).toContain(job.id);
});

test("a build given up on while the computer slept is taken back when it returns still running it", async () => {
  const mac = fakeConn("sleepy-mac", "alice", "Alice's Mac");
  await hub.runnerOpened(mac);
  await say(mac, { type: "hello", activeJobIds: [] });
  const { projectId, ticketId } = await newTicket();
  const job = await startTicketOnRunner({ projectId, ticketId, actorId: "alice" });
  await say(mac, { type: "job.accepted", jobId: job.id });
  expect((await jobRow(job.id)).status).toBe("running");

  // The Mac slept past the grace period: the server gave the build up.
  await db.update(runnerJobs).set({ status: "failed", error: "Lost contact with Alice's Mac.", finishedAt: new Date() }).where(eq(runnerJobs.id, job.id));
  await db.update(projectTickets).set({ status: "failed", queueStatus: "none" }).where(eq(projectTickets.id, ticketId));

  // It wakes, still building.
  const again = fakeConn("sleepy-mac", "alice", "Alice's Mac");
  await hub.runnerOpened(again);
  await say(again, { type: "hello", activeJobIds: [job.id] });
  const back = await jobRow(job.id);
  expect(back.status).toBe("running");
  expect(back.error).toBeNull();
  const ticket = await ticketRow(ticketId);
  expect(ticket.status).toBe("in_progress");
  expect(ticket.queueStatus).toBe("executing");

  await say(again, { type: "job.finished", jobId: job.id, ok: true, branch: "lfg/app-1", commitSha: "abc1234" });
  expect((await jobRow(job.id)).status).toBe("succeeded");
  expect((await ticketRow(ticketId)).status).toBe("review");
});

test("a job that failed for another reason is not taken back", async () => {
  const mac = fakeConn("other-mac", "alice");
  await hub.runnerOpened(mac);
  await say(mac, { type: "hello", activeJobIds: [] });
  const { projectId, ticketId } = await newTicket();
  const job = await startTicketOnRunner({ projectId, ticketId, actorId: "alice" });
  await say(mac, { type: "job.accepted", jobId: job.id });
  await say(mac, { type: "job.finished", jobId: job.id, ok: false, error: "Tests failed" });
  expect(await hub.resumeLostJobs(mac, [job.id])).toBe(0);
  expect((await jobRow(job.id)).status).toBe("failed");
});
