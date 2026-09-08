import { test, expect, beforeAll, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

const root = mkdtempSync(join(tmpdir(), "lfg-rbac-"));
process.env.DATABASE_URL = join(root, "test.db");
process.env.DATABASE_DRIVER = "sqlite";
process.env.BETTER_AUTH_SECRET = "rbac-test-secret-only-not-a-real-secret";
process.env.BETTER_AUTH_URL = "http://localhost:8000";
// Generate the real schema; no native better-sqlite3 module needed for Bun tests.
const generation = Bun.spawnSync(["bun", "node_modules/drizzle-kit/bin.cjs", "generate", "--dialect", "sqlite", "--schema", "./src/db/schema/sqlite/index.ts", "--out", join(root, "schema")]);
if (generation.exitCode) throw new Error(generation.stderr.toString());
const sqlite = new Database(process.env.DATABASE_URL);
for (const f of readdirSync(join(root, "schema")).filter(f => f.endsWith(".sql"))) sqlite.exec(readFileSync(join(root, "schema", f), "utf8"));
sqlite.close();
const testAuth = async (c: any, next: any) => { const id = c.req.header("x-test-user") || "member"; c.set("user", { id, name: id, email: `${id}@example.com` }); return next(); };
mock.module("../src/auth/middleware.ts", () => ({ requireAuth: testAuth, optionalAuth: testAuth }));
const { db } = await import("../src/config/db.ts");
const { users, profiles, llmApiKeys, applicationState } = await import("../src/db/schema/users.ts");
const { organizations, orgMemberships, orgInvitations } = await import("../src/db/schema/organizations.ts");
const { projects, projectMembers, projectInvitations } = await import("../src/db/schema/projects.ts");
const { resolveLlmGrants, llmKeyUserId } = await import("../src/services/llm-access.ts");
const { availableChatModels } = await import("../src/services/available-models.ts");
const { subscriptionOwner } = await import("../src/services/subscription-execution.ts");
const { requireTeamAdmin } = await import("../src/services/team-access.ts");
const { default: teamRoutes } = await import("../src/routes/team-settings.ts");
const { default: settingsRoutes } = await import("../src/routes/settings.ts");
const { default: openaiRoutes } = await import("../src/routes/api/openai-codex-auth.ts");
const { default: invitationRoutes } = await import("../src/routes/api/invitations.ts");
const { SettingsPage } = await import("../src/templates/pages/settings.tsx");

beforeAll(async () => {
  for (const id of ["owner", "admin", "member", "viewer", "outsider", "invitee"]) await db.insert(users).values({ id, name: id, email: `${id}@example.com` });
  await db.insert(organizations).values({ id: "team", name: "Example team", slug: "team", ownerId: "owner" });
  for (const role of ["admin", "member", "viewer"]) await db.insert(orgMemberships).values({ id: role, userId: role, organizationId: "team", role });
  for (const userId of ["owner", "admin", "member", "viewer"]) await db.insert(profiles).values({ userId, currentOrganizationId: "team" });
  await db.insert(projects).values({ id: "project", projectId: "public-project", name: "Project", ownerId: "owner", organizationId: "team" });
  await db.insert(projectMembers).values({ id: "project-member", projectId: "project", userId: "member", role: "member", canUseOwnerLlmKey: true, canUseOwnerLlmSubscription: true, canUsePersonalSubscription: true });
  await db.insert(llmApiKeys).values({ userId: "owner", openaiApiKey: "fake-test-token", anthropicApiKey: "fake-anthropic-token" });
});
const project = { id: "project", ownerId: "owner" };
const post = (path: string, user: string, body: Record<string, string>) => teamRoutes.request(path, { method: "POST", headers: { "x-test-user": user, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });

test("only owners and admins manage team settings", async () => {
  expect((await requireTeamAdmin("admin")).team.ownerId).toBe("owner");
  await expect(requireTeamAdmin("member")).rejects.toThrow();
  expect((await post("/settings/team/policy", "member", { name: "Hacked" })).status).toBe(403);
  expect((await post("/settings/team/switch", "outsider", { teamId: "team" })).status).toBe(403);
});
test("project token grant uses team keys and never shares owner subscription", async () => {
  const g = await resolveLlmGrants(project, "member");
  expect(llmKeyUserId(g, "member")).toBe("owner");
  expect(g.canUseSub).toBe(false);
  expect(await subscriptionOwner("member", "public-project")).toBe("member");
  await expect(resolveLlmGrants(project, "outsider")).rejects.toThrow();
});
test("subscription-only policy hides every API model, including for admins", async () => {
  await db.update(organizations).set({ tokensEnabled: false }).where(eq(organizations.id, "team"));
  const models = await availableChatModels("member", "public-project");
  expect(models.length).toBeGreaterThan(0);
  expect(models.every(m => m.key.startsWith("chatgpt/"))).toBe(true);
  expect(models.every(m => !m.available)).toBe(true);
  expect(() => llmKeyUserId({ ownerId: "owner", keyUserId: "owner", isOwner: false, canUseKey: false, canUseSub: false, canUsePersonalSubscription: true }, "member")).toThrow();
  expect((await resolveLlmGrants(project, "owner")).canUseKey).toBe(false);
  await db.update(organizations).set({ tokensEnabled: true }).where(eq(organizations.id, "team"));
});
test("project personal subscription grant and team switch both constrain access", async () => {
  await db.update(projectMembers).set({ canUsePersonalSubscription: false }).where(eq(projectMembers.id, "project-member"));
  await expect(subscriptionOwner("member", "public-project")).rejects.toThrow();
  await db.update(projectMembers).set({ canUsePersonalSubscription: true }).where(eq(projectMembers.id, "project-member"));
  await db.update(organizations).set({ subscriptionsEnabled: false }).where(eq(organizations.id, "team"));
  expect((await availableChatModels("member", "public-project")).every(m => !m.key.startsWith("chatgpt/"))).toBe(true);
  await expect(subscriptionOwner("member", "public-project")).rejects.toThrow();
  await db.update(organizations).set({ subscriptionsEnabled: true }).where(eq(organizations.id, "team"));
});
test("build credentials follow the actor and cannot fall back to owner subscriptions", async () => {
  const { encryptSecret } = await import("../src/utils/crypto.ts");
  const { resolveBuildLlm } = await import("../src/services/build-llm-access.ts");
  await db.update(profiles).set({ openaiCodexAuthenticated: true, openaiCodexCredentials: encryptSecret(JSON.stringify({ type: "oauth", access: "fake-personal-access", refresh: "fake-personal-refresh", expires: Date.now() + 3600000 })) }).where(eq(profiles.userId, "member"));
  await db.insert(applicationState).values({ userId: "member", builderAuthMode: "subscription", builderModelKey: "gpt-5.6-luna" });
  const personal = await resolveBuildLlm(project, "member");
  expect(personal.actorId).toBe("member");
  expect(personal.mode).toBe("subscription");
  await db.update(applicationState).set({ builderAuthMode: "api_key" }).where(eq(applicationState.userId, "member"));
  const token = await resolveBuildLlm(project, "member");
  expect(token.mode).toBe("api_key");
  expect(token.keyUserId).toBe("owner");
  await db.update(projectMembers).set({ canUseOwnerLlmKey: false, canUsePersonalSubscription: false }).where(eq(projectMembers.id, "project-member"));
  await expect(resolveBuildLlm(project, "member")).rejects.toThrow();
  await db.update(projectMembers).set({ canUseOwnerLlmKey: true, canUsePersonalSubscription: true }).where(eq(projectMembers.id, "project-member"));
});
test("arbitrary project roles and string boolean escalation are rejected", async () => {
  const patch = (body: object) => invitationRoutes.request("/public-project/members/project-member", { method: "PATCH", headers: { "x-test-user": "owner", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  expect((await patch({ role: "owner" })).status).toBe(400);
  expect((await patch({ canUseOwnerLlmKey: "true" })).status).toBe(400);
  expect((await patch({ role: "admin" })).status).toBe(200);
  expect((await patch({ role: "viewer" })).status).toBe(200);
  const [row] = await db.select().from(projectMembers).where(eq(projectMembers.id, "project-member"));
  expect(row!.canChat).toBe(false);
  expect(row!.canEditFiles).toBe(false);
});
test("admins cannot promote themselves or remove another admin", async () => {
  expect((await post("/settings/team/member", "admin", { id: "admin", role: "member", action: "remove" })).status).toBe(403);
  expect((await post("/settings/team/member", "admin", { id: "member", role: "admin", action: "update" })).status).toBe(403);
});
test("settings omit token forms and parse scripts for subscription-only collaborators", async () => {
  const page = String(await SettingsPage({ user: { id: "member", name: "Member", email: "member@example.com" }, activeSection: "integrations", teamAccess: { isAdmin: false, role: "member", team: { name: "Team", tokensEnabled: false, subscriptionsEnabled: true } }, apiKeys: { openai: false, anthropic: false, google: false, xai: false, kimi: false, deepseek: false, glm: false, usePersonalKeys: false } }));
  expect(page).not.toContain('action="/settings/save-key"');
  expect(page).not.toContain('> LLM Keys');
  expect(page).toContain("Connect OpenAI");
  expect(page).not.toContain("Connect Claude Code");
  for (const match of page.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)) expect(() => new Function(match[1]!)).not.toThrow();
});
test("team settings renders role controls only for admins", async () => {
  const ownerPage = await (await teamRoutes.request("/settings/team", { headers: { "x-test-user": "owner" } })).text();
  const memberPage = await (await teamRoutes.request("/settings/team", { headers: { "x-test-user": "member" } })).text();
  expect(ownerPage).toContain('action="/settings/team/invite"');
  expect(ownerPage).toContain('action="/settings/team/policy"');
  expect(memberPage).not.toContain('action="/settings/team/invite"');
  expect(memberPage).not.toContain('action="/settings/team/policy"');
  if (process.env.RBAC_PREVIEW_DIR) {
    await Bun.write(join(process.env.RBAC_PREVIEW_DIR, "team.html"), ownerPage);
    await Bun.write(join(process.env.RBAC_PREVIEW_DIR, "member.html"), await (await settingsRoutes.request("/settings/integrations", { headers: { "x-test-user": "member" } })).text());
  }
});
test("token write endpoints enforce admin role and update the team owner key row", async () => {
  const save = (user: string) => settingsRoutes.request("/settings/save-key", { method: "POST", headers: { "x-test-user": user, "Content-Type": "application/x-www-form-urlencoded" }, body: "provider=google&key=fake-google-test-key" });
  expect((await save("member")).status).toBe(403);
  expect((await save("admin")).status).toBe(302);
  const [ownerKeys] = await db.select().from(llmApiKeys).where(eq(llmApiKeys.userId, "owner"));
  expect(ownerKeys!.googleApiKey).toBe("fake-google-test-key");
  expect((await db.select().from(llmApiKeys).where(eq(llmApiKeys.userId, "admin"))).length).toBe(0);
  expect((await settingsRoutes.request("/settings", { headers: { "x-test-user": "member" } })).status).toBe(302);
});
test("ChatGPT start endpoint refuses disabled subscriptions without launching OAuth", async () => {
  await db.update(organizations).set({ subscriptionsEnabled: false }).where(eq(organizations.id, "team"));
  expect((await openaiRoutes.request("/start", { method: "POST", headers: { "x-test-user": "member" } })).status).toBe(403);
  await db.update(organizations).set({ subscriptionsEnabled: true }).where(eq(organizations.id, "team"));
});
test("project invitation grants survive acceptance and require the invited email", async () => {
  const { default: acceptance } = await import("../src/routes/invitations.ts");
  await db.insert(projectInvitations).values({ projectId: "project", inviterId: "owner", email: "invitee@example.com", role: "member", token: "test-project-invite", expiresAt: new Date(Date.now() + 3600000), canUseOwnerLlmKey: false, canUsePersonalSubscription: true });
  expect((await acceptance.request("/invitations/accept/test-project-invite", { method: "POST", headers: { "x-test-user": "outsider" } })).status).toBe(403);
  expect((await acceptance.request("/invitations/accept/test-project-invite", { method: "POST", headers: { "x-test-user": "invitee" } })).status).toBe(302);
  const grant = await resolveLlmGrants(project, "invitee");
  expect(grant.canUseKey).toBe(false);
  expect(grant.canUsePersonalSubscription).toBe(true);
});
test("removing a member invalidates pending invitations that could restore access", async () => {
  await db.insert(orgInvitations).values({ organizationId: "team", inviterId: "owner", email: "invitee@example.com", role: "admin", token: "stale-invite", expiresAt: new Date(Date.now() + 3600000) });
  const [m] = await db.select().from(orgMemberships).where(eq(orgMemberships.userId, "invitee"));
  expect((await post("/settings/team/member", "owner", { id: m!.id, role: "member", action: "remove" })).status).toBe(302);
  expect((await post("/settings/team/accept/stale-invite", "invitee", {})).status).toBe(404);
  await expect(resolveLlmGrants(project, "invitee")).rejects.toThrow();
});
test("migration groups existing projects by owner, preserves grants, and is idempotent", async () => {
  await db.insert(users).values({ id: "legacy-owner", name: "Legacy Owner", email: "legacy-owner@example.com" });
  await db.insert(projects).values({ id: "legacy-project", projectId: "legacy-public", name: "Legacy", ownerId: "legacy-owner" });
  await db.insert(projectMembers).values({ id: "legacy-member", projectId: "legacy-project", userId: "outsider", canUseOwnerLlmKey: true, canUseOwnerLlmSubscription: true });
  const run = () => Bun.spawnSync(["bun", "scripts/migrate-teams.ts"], { env: process.env });
  expect(run().exitCode).toBe(0);
  expect(run().exitCode).toBe(0);
  const [migrated] = await db.select().from(projects).where(eq(projects.id, "legacy-project"));
  expect(migrated!.organizationId).toBe("personal-legacy-owner");
  const [membership] = await db.select().from(orgMemberships).where(eq(orgMemberships.userId, "outsider"));
  expect(membership!.role).toBe("member");
  const [grant] = await db.select().from(projectMembers).where(eq(projectMembers.id, "legacy-member"));
  expect(grant!.canUseOwnerLlmKey).toBe(true);
  expect(grant!.canUsePersonalSubscription).toBe(true);
  expect(grant!.canUseOwnerLlmSubscription).toBe(false);
});
test("removing team membership revokes project LLM access immediately", async () => {
  await db.update(orgMemberships).set({ status: "inactive" }).where(eq(orgMemberships.id, "member"));
  await expect(resolveLlmGrants(project, "member")).rejects.toThrow();
});

test('existing accounts discover invites and keep independent workspaces after joining', async () => {
  const { workspaceContext, teamAccess } = await import('../src/services/team-access.ts');
  await db.insert(users).values({id:'multi',name:'Multi',email:'multi@example.com'});
  const before = await workspaceContext('multi','multi@example.com');
  expect(before.teams.map(t=>t.id)).toContain('personal-multi');
  await db.insert(organizations).values({id:'second',name:'Second team',slug:'second',ownerId:'owner'});
  await db.insert(orgInvitations).values({organizationId:'second',inviterId:'owner',email:'multi@example.com',role:'member',token:'multi-join',expiresAt:new Date(Date.now()+3600000)});
  expect((await workspaceContext('multi','multi@example.com')).invitations.length).toBe(1);
  expect((await workspaceContext('outsider','outsider@example.com')).invitations.some(i=>i.token==='multi-join')).toBe(false);
  expect((await post('/settings/team/accept/multi-join','outsider',{})).status).toBe(404);
  expect((await post('/settings/team/accept/multi-join','multi',{})).status).toBe(302);
  const after = await workspaceContext('multi','multi@example.com');
  expect(after.currentId).toBe('second');
  expect(after.teams.map(t=>t.id).sort()).toEqual(['personal-multi','second']);
  expect(after.invitations.length).toBe(0);
  expect((await teamAccess('multi','second')).isAdmin).toBe(false);
  expect((await post('/settings/team/switch','multi',{teamId:'personal-multi',returnTo:'/projects'})).headers.get('location')).toBe('/projects');
  expect((await post('/settings/team/switch','multi',{teamId:'second',returnTo:'https://example.com'})).headers.get('location')).toBe('/settings/team');
  expect((await post('/settings/team/switch','outsider',{teamId:'second'})).status).toBe(403);
});
