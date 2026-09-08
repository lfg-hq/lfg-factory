import { TeamSettingsContent } from "../templates/pages/team-settings.ts";
import { Hono } from "hono";
import { html } from "hono/html";
import { and, eq, inArray } from "drizzle-orm";
import { requireAuth } from "../auth/middleware.ts";
import type { auth } from "../auth/index.ts";
import { db } from "../config/db.ts";
import { organizations, orgMemberships, orgInvitations } from "../db/schema/organizations.ts";
import { profiles, users } from "../db/schema/users.ts";
import { teamAccess, requireTeamAdmin, workspaceContext } from "../services/team-access.ts";
import { SettingsPage } from "../templates/pages/settings.tsx";

type AuthEnv = { Variables: { user: typeof auth.$Infer.Session.user; session: typeof auth.$Infer.Session.session } };
const router = new Hono<AuthEnv>();
router.use("*", requireAuth);
const roles = ["admin", "member", "viewer"];
router.get("/settings/team", async c => {
  const user = c.get("user");
  const access = await teamAccess(user.id);
  const { team, isAdmin } = access;
  const memberships = await db.select().from(orgMemberships).where(eq(orgMemberships.userId, user.id));
  const ownedTeams = await db.select().from(organizations).where(eq(organizations.ownerId, user.id));
  const ids = [...new Set([...ownedTeams.map(t => t.id), ...memberships.filter(m => m.status === "active").map(m => m.organizationId)])];
  const allTeams = ids.length ? await db.select().from(organizations).where(and(eq(organizations.isActive, true), inArray(organizations.id, ids))) : [];
  const [owner] = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, team.ownerId)).limit(1);
  const availableTeams = allTeams.filter(t => t.ownerId === user.id || memberships.some(m => m.organizationId === t.id && m.status === "active"));
  const members = await db.select({ id: orgMemberships.id, role: orgMemberships.role, name: users.name, email: users.email }).from(orgMemberships).innerJoin(users, eq(users.id, orgMemberships.userId)).where(and(eq(orgMemberships.organizationId, team.id), eq(orgMemberships.status, "active")));
  const invitations = isAdmin ? await db.select().from(orgInvitations).where(and(eq(orgInvitations.organizationId, team.id), eq(orgInvitations.status, "pending"))) : [];
  return c.html(SettingsPage({ user, workspaceContext: await workspaceContext(user.id, user.email), teamAccess: access, activeSection: "team", apiKeys: { openai: false, anthropic: false, google: false, xai: false, kimi: false, deepseek: false, glm: false, usePersonalKeys: false }, teamContent: TeamSettingsContent({ team, role: access.role, isAdmin, availableTeams, owner, members, invitations, baseUrl: c.req.url }) }));
});
router.post("/settings/team/switch", async c => {
  const body = await c.req.parseBody();
  if (typeof body.teamId !== "string") return c.text("Team required", 400);
  const { team } = await teamAccess(c.get("user").id, body.teamId);
  await db.insert(profiles).values({ userId: c.get("user").id, currentOrganizationId: team.id }).onConflictDoUpdate({ target: profiles.userId, set: { currentOrganizationId: team.id } });
  return c.redirect(["/projects", "/settings", "/settings/integrations"].includes(String(body.returnTo)) ? String(body.returnTo) : "/settings/team");
});
router.post("/settings/team/policy", async c => {
  const { team } = await requireTeamAdmin(c.get("user").id);
  const b = await c.req.parseBody();
  const name = typeof b.name === "string" ? b.name.trim().slice(0, 100) : "";
  if (!name) return c.text("Team name is required", 400);
  await db.update(organizations).set({ name, tokensEnabled: b.tokensEnabled === "on", subscriptionsEnabled: b.subscriptionsEnabled === "on", updatedAt: new Date() }).where(eq(organizations.id, team.id));
  return c.redirect("/settings/team");
});
router.post("/settings/team/invite", async c => {
  const { team, role } = await requireTeamAdmin(c.get("user").id);
  const b = await c.req.parseBody();
  if (typeof b.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email.trim()) || typeof b.role !== "string" || !roles.includes(b.role)) return c.text("Valid email and role required", 400);
  if (b.role === "admin" && role !== "owner") return c.text("Only the owner can appoint admins", 403);
  const [existingUser] = await db.select().from(users).where(eq(users.email, b.email.trim().toLowerCase())).limit(1);
  if (existingUser) {
    const [existingMember] = await db.select().from(orgMemberships).where(and(eq(orgMemberships.organizationId, team.id), eq(orgMemberships.userId, existingUser.id))).limit(1);
    if (existingUser.id === team.ownerId || existingMember?.status === "active") return c.text("This person is already on the team; change their role in the member list", 409);
  }
  const values = { organizationId: team.id, inviterId: c.get("user").id, email: b.email.trim().toLowerCase(), role: b.role, token: crypto.randomUUID(), expiresAt: new Date(Date.now() + 7 * 86400000), status: "pending", respondedAt: null };
  await db.insert(orgInvitations).values(values).onConflictDoUpdate({ target: [orgInvitations.organizationId, orgInvitations.email], set: values });
  return c.redirect("/settings/team");
});
router.get("/settings/team/accept/:token", async c => {
  const user = c.get("user");
  const [invite] = await db.select().from(orgInvitations).where(and(eq(orgInvitations.token, c.req.param("token")), eq(orgInvitations.status, "pending"))).limit(1);
  if (!invite || invite.email.toLowerCase() !== user.email.toLowerCase() || invite.expiresAt < new Date()) return c.text("Invitation unavailable for this account", 404);
  return c.html(html`<!doctype html><title>Join team</title><h1>Join team as ${invite.role === "member" ? "Collaborator" : invite.role}</h1><form method="post"><button>Accept invitation</button></form>`);
});
router.post("/settings/team/accept/:token", async c => {
  const user = c.get("user");
  const [invite] = await db.select().from(orgInvitations).where(and(eq(orgInvitations.token, c.req.param("token")), eq(orgInvitations.status, "pending"))).limit(1);
  if (!invite || invite.email.toLowerCase() !== user.email.toLowerCase() || invite.expiresAt < new Date()) return c.text("Invitation unavailable for this account", 404);
  const inviter = await teamAccess(invite.inviterId, invite.organizationId);
  if (!inviter.isAdmin || (invite.role === "admin" && inviter.role !== "owner")) return c.text("Invitation is no longer authorized", 403);
  await db.insert(orgMemberships).values({ userId: user.id, organizationId: invite.organizationId, role: invite.role }).onConflictDoUpdate({ target: [orgMemberships.userId, orgMemberships.organizationId], set: { role: invite.role, status: "active", updatedAt: new Date() } });
  await db.update(orgInvitations).set({ status: "accepted", respondedAt: new Date() }).where(eq(orgInvitations.id, invite.id));
  await db.insert(profiles).values({ userId: user.id, currentOrganizationId: invite.organizationId }).onConflictDoUpdate({ target: profiles.userId, set: { currentOrganizationId: invite.organizationId } });
  return c.redirect("/settings/team");
});
router.post("/settings/team/member", async c => {
  const { team, role } = await requireTeamAdmin(c.get("user").id);
  const b = await c.req.parseBody();
  const [m] = await db.select().from(orgMemberships).where(and(eq(orgMemberships.id, String(b.id)), eq(orgMemberships.organizationId, team.id))).limit(1);
  if (!m) return c.text("Member not found", 404);
  if (m.userId === team.ownerId || ((m.role === "admin" || b.role === "admin") && role !== "owner")) return c.text("Only the owner can change admins; the owner cannot be removed", 403);
  if (typeof b.role !== "string" || !roles.includes(b.role)) return c.text("Invalid role", 400);
  await db.update(orgMemberships).set({ role: b.role, status: b.action === "remove" ? "inactive" : "active", updatedAt: new Date() }).where(eq(orgMemberships.id, m.id));
  const [targetUser] = await db.select({ email: users.email }).from(users).where(eq(users.id, m.userId)).limit(1);
  if (targetUser) await db.update(orgInvitations).set({ status: "revoked" }).where(and(eq(orgInvitations.organizationId, team.id), eq(orgInvitations.email, targetUser.email.toLowerCase()), eq(orgInvitations.status, "pending")));
  return c.redirect("/settings/team");
});
router.post("/settings/team/revoke", async c => {
  const { team } = await requireTeamAdmin(c.get("user").id);
  const b = await c.req.parseBody();
  await db.update(orgInvitations).set({ status: "revoked" }).where(and(eq(orgInvitations.id, String(b.id)), eq(orgInvitations.organizationId, team.id)));
  return c.redirect("/settings/team");
});
export default router;
