// A new feature waits for the person between docs, tickets and build: work made in the
// current turn (after their latest message) is not carried to the next step in that turn.
import { test, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "lfg-review-gates-"));
process.env.DATABASE_URL = join(root, "test.db");
process.env.DATABASE_DRIVER = "sqlite";
process.env.BETTER_AUTH_SECRET = "review-gates-test-secret-only-not-a-real-secret";
process.env.BETTER_AUTH_URL = "http://localhost:8000";
const generation = Bun.spawnSync(["bun", "node_modules/drizzle-kit/bin.cjs", "generate", "--dialect", "sqlite", "--schema", "./src/db/schema/sqlite/index.ts", "--out", join(root, "schema")]);
if (generation.exitCode) throw new Error(generation.stderr.toString());
const sqlite = new Database(process.env.DATABASE_URL);
for (const f of readdirSync(join(root, "schema")).filter(f => f.endsWith(".sql"))) sqlite.exec(readFileSync(join(root, "schema", f), "utf8"));
sqlite.close();

const { db } = await import("../src/config/db.ts");
const { users } = await import("../src/db/schema/users.ts");
const { projects } = await import("../src/db/schema/projects.ts");
const { conversations, messages } = await import("../src/db/schema/chat.ts");
const { projectFiles } = await import("../src/db/schema/documents.ts");
const { projectTickets } = await import("../src/db/schema/tickets.ts");
const { ticketsBeforeDocReview, buildBeforeTicketReview, lastPersonMessageAt } = await import("../src/services/review-gates.ts");

const t0 = new Date("2026-11-18T10:00:00Z");
const at = (s: number) => new Date(t0.getTime() + s * 1000);

beforeAll(async () => {
  await db.insert(users).values({ id: "ana", name: "Ana", email: "ana@example.com" });
  await db.insert(projects).values({ id: "p", projectId: "pub-p", name: "Recruiting", ownerId: "ana" });
  await db.insert(conversations).values({ id: "c", userId: "ana", projectId: "p", title: "SDR demo" });
  await db.insert(messages).values({ id: "m1", conversationId: "c", role: "user", content: "Build an SDR demo", createdAt: at(0) });
  // An automated build event later on is not the person replying.
  await db.insert(messages).values({ id: "m2", conversationId: "c", role: "user", userRole: "build_event", content: "[Automated build event]", createdAt: at(500) });
  await db.insert(projectFiles).values({ id: "d1", projectId: "p", name: "SDR Demo — Requirements", fileType: "prd", content: "x", createdAt: at(10) });
  await db.insert(projectFiles).values({ id: "d0", projectId: "p", name: "Old overview", fileType: "overview", content: "x", createdAt: at(11) });
  for (const [id, key] of [["t1", "REC-20"], ["t2", "REC-21"]]) {
    await db.insert(projectTickets).values({ id, projectId: "p", ticketKey: key, name: key, description: "d", epicId: "e1", createdAt: at(20) });
  }
  await db.insert(projectTickets).values({ id: "fix", projectId: "p", ticketKey: "REC-30", name: "Fix", description: "d", epicId: "e2", createdAt: at(30) });
});

test("the person's latest message ignores automated rows", async () => {
  expect((await lastPersonMessageAt("c"))?.toISOString()).toBe(at(0).toISOString());
});

test("tickets wait for the docs written this turn to be reviewed", async () => {
  const refusal = await ticketsBeforeDocReview("p", "c");
  expect(refusal).toContain("SDR Demo — Requirements");
  expect(refusal).not.toContain("Old overview");
});

test("a feature's new tickets are not built in the turn they were created", async () => {
  expect(await buildBeforeTicketReview(["t1", "t2"], "c")).toContain("REC-20, REC-21");
  expect(await buildBeforeTicketReview(["t1"], "c", { allowSingleFix: true })).toContain("REC-20");
});

test("a single fix may be filed and queued in one turn", async () => {
  expect(await buildBeforeTicketReview(["fix"], "c", { allowSingleFix: true })).toBeNull();
});

test("once the person replies, the next step is open", async () => {
  await db.insert(messages).values({ id: "m3", conversationId: "c", role: "user", content: "Looks good, go ahead", createdAt: at(600) });
  expect(await ticketsBeforeDocReview("p", "c")).toBeNull();
  expect(await buildBeforeTicketReview(["t1", "t2"], "c")).toBeNull();
});
