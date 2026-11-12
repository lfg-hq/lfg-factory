import { test, expect, beforeAll, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

// In-place document editing: the by-id autosave endpoint, and the client helpers that
// tidy the editor's markdown and build the "Add to chat" excerpt.

const root = mkdtempSync(join(tmpdir(), "lfg-inline-doc-"));
process.env.DATABASE_URL = join(root, "test.db");
process.env.DATABASE_DRIVER = "sqlite";
process.env.BETTER_AUTH_SECRET = "inline-doc-test-secret-only";
process.env.BETTER_AUTH_URL = "http://localhost:8000";
const generation = Bun.spawnSync(["bun", "node_modules/drizzle-kit/bin.cjs", "generate", "--dialect", "sqlite", "--schema", "./src/db/schema/sqlite/index.ts", "--out", join(root, "schema")]);
if (generation.exitCode) throw new Error(generation.stderr.toString());
const sqlite = new Database(process.env.DATABASE_URL);
for (const f of readdirSync(join(root, "schema")).filter(f => f.endsWith(".sql"))) sqlite.exec(readFileSync(join(root, "schema", f), "utf8"));
sqlite.close();
const testAuth = async (c: any, next: any) => { const id = c.req.header("x-test-user") || "owner"; c.set("user", { id, name: id, email: `${id}@example.com` }); return next(); };
mock.module("../src/auth/middleware.ts", () => ({ requireAuth: testAuth, optionalAuth: testAuth }));
const { db } = await import("../src/config/db.ts");
const { users, profiles } = await import("../src/db/schema/users.ts");
const { organizations, orgMemberships } = await import("../src/db/schema/organizations.ts");
const { projects, projectMembers } = await import("../src/db/schema/projects.ts");
const { projectFiles, projectFileVersions } = await import("../src/db/schema/documents.ts");
const { default: projectsRouter } = await import("../src/routes/projects.ts");

beforeAll(async () => {
  for (const id of ["owner", "viewer"]) await db.insert(users).values({ id, name: id, email: `${id}@example.com` });
  await db.insert(organizations).values({ id: "team", name: "Team", slug: "team", ownerId: "owner" });
  await db.insert(orgMemberships).values({ id: "m-viewer", userId: "viewer", organizationId: "team", role: "viewer" });
  for (const userId of ["owner", "viewer"]) await db.insert(profiles).values({ userId, currentOrganizationId: "team" });
  await db.insert(projects).values({ id: "project", projectId: "public-project", name: "Project", ownerId: "owner", organizationId: "team" });
  await db.insert(projects).values({ id: "other", projectId: "other-project", name: "Other", ownerId: "owner", organizationId: "team" });
  await db.insert(projectMembers).values({ id: "pm-viewer", projectId: "project", userId: "viewer", role: "viewer" });
  await db.insert(projectFiles).values({ id: "doc", projectId: "project", name: "Reliability PRD", fileType: "prd", content: "# Old\n", updatedAt: new Date("2026-11-01T00:00:00Z") });
  await db.insert(projectFiles).values({ id: "foreign", projectId: "other", name: "Elsewhere", fileType: "prd", content: "x" });
});

const url = (fileId: string) => `http://localhost/projects/public-project/api/files/${fileId}/content`;
const put = (fileId: string, body: unknown, user = "owner") =>
  projectsRouter.request(url(fileId), { method: "PUT", headers: { "Content-Type": "application/json", "x-test-user": user }, body: JSON.stringify(body) });
const versions = async () => db.select().from(projectFileVersions).where(eq(projectFileVersions.fileId, "doc"));

test("content GET returns updatedAt for the editor's conflict check", async () => {
  const res = await projectsRouter.request(url("doc"), { headers: { "x-test-user": "owner" } });
  const data = await res.json() as any;
  expect(data.content).toBe("# Old\n");
  expect(new Date(data.updatedAt).toISOString()).toBe("2026-11-01T00:00:00.000Z");
});

test("autosave writes by id and snapshots one version per editing session", async () => {
  let res = await put("doc", { content: "# New\n", baseUpdatedAt: "2026-11-01T00:00:00.000Z" });
  expect(res.status).toBe(200);
  const first = await res.json() as any;
  expect(first.success).toBe(true);
  expect((await versions()).map(v => v.content)).toEqual(["# Old\n"]);

  res = await put("doc", { content: "# Newer\n", baseUpdatedAt: first.updatedAt });
  expect(res.status).toBe(200);
  // Still one snapshot: the second save is the same editing session.
  expect((await versions()).length).toBe(1);
  const [file] = await db.select().from(projectFiles).where(eq(projectFiles.id, "doc"));
  expect(file!.content).toBe("# Newer\n");
});

test("a save based on a stale copy is refused instead of overwriting", async () => {
  const res = await put("doc", { content: "# Mine\n", baseUpdatedAt: "2026-10-01T00:00:00.000Z" });
  expect(res.status).toBe(409);
  const data = await res.json() as any;
  expect(data.content).toBe("# Newer\n");
});

test("viewers can't save, and files from other projects aren't reachable", async () => {
  expect((await put("doc", { content: "nope" }, "viewer")).status).toBe(403);
  expect((await put("foreign", { content: "nope" })).status).toBe(404);
  expect((await put("doc", { nothing: true })).status).toBe(400);
});

// ── Client helpers (public/js/doc-editor.js) ─────────────────────────
(globalThis as any).window = {};
(globalThis as any).document = { addEventListener() {} };
await import("../public/js/doc-editor.js");
const DocEditor = (globalThis as any).window.DocEditor;

test("markdown tidy undoes defensive escaping outside code", () => {
  const t = DocEditor._tidyMarkdown;
  expect(t("R&amp;D &amp;copy; a &lt; b &lt;div&gt; c &gt; d")).toBe("R&D &amp;copy; a < b &lt;div> c > d\n");
  expect(t("&gt; not a quote\n- &gt; nor this")).toBe("&gt; not a quote\n- &gt; nor this\n");
  expect(t("snake\\_case but \\_emphasis\\_")).toBe("snake_case but \\_emphasis\\_\n");
  expect(t("`a &amp; b` and a &amp; b")).toBe("`a &amp; b` and a & b\n");
  expect(t("```\nx &amp; y\n\n\n```\n\n\n\nafter")).toBe("```\nx &amp; y\n\n\n```\n\nafter\n");
});

test("Add to chat quotes the passage and references the document like @-mentions do", () => {
  const msg = DocEditor._excerptMessage("Reliability [PRD]", "doc", "Line one\nLine two");
  expect(msg).toBe("> Line one\n> Line two\n\n— from [@Reliability PRD](file:doc)\n\n");
});
