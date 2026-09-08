import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { db } from "../config/db.ts";
import { organizations, orgMemberships } from "../db/schema/organizations.ts";
import { profiles, users } from "../db/schema/users.ts";

export async function personalTeam(userId: string) {
  const id = `personal-${userId}`;
  const [existing] = await db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
  if (existing) return existing;
  const [user] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
  await db.insert(organizations).values({ id, ownerId: userId, name: `${user?.name || "Personal"}’s team`, slug: id }).onConflictDoNothing();
  return (await db.select().from(organizations).where(eq(organizations.id, id)).limit(1))[0]!;
}

export async function teamAccess(userId: string, teamId?: string | null): Promise<{ team: typeof organizations.$inferSelect; role: string; isAdmin: boolean }> {
  const explicitTeam = !!teamId;
  if (!teamId) {
    const [profile] = await db.select({ teamId: profiles.currentOrganizationId }).from(profiles).where(eq(profiles.userId, userId)).limit(1);
    teamId = profile?.teamId;
  }
  const team = teamId
    ? (await db.select().from(organizations).where(eq(organizations.id, teamId)).limit(1))[0]
    : await personalTeam(userId);
  if (!team?.isActive) throw new HTTPException(403, { message: "Team access is unavailable" });
  const [member] = await db.select().from(orgMemberships).where(and(eq(orgMemberships.organizationId, team.id), eq(orgMemberships.userId, userId), eq(orgMemberships.status, "active"))).limit(1);
  const role = team.ownerId === userId ? "owner" : member?.role;
  if (!role && !explicitTeam) {
    const [other] = await db.select().from(orgMemberships).where(and(eq(orgMemberships.userId, userId), eq(orgMemberships.status, "active"))).limit(1);
    const fallbackId = other?.organizationId ?? (await personalTeam(userId)).id;
    return teamAccess(userId, fallbackId);
  }
  if (!role) throw new HTTPException(403, { message: "You are not a member of this team" });
  return { team, role, isAdmin: role === "owner" || role === "admin" };
}

export async function projectTeam(project: { ownerId: string; organizationId?: string | null }) {
  if (!project.organizationId) return personalTeam(project.ownerId);
  const [team] = await db.select().from(organizations).where(eq(organizations.id, project.organizationId)).limit(1);
  if (!team?.isActive) throw new HTTPException(403, { message: "Project team is unavailable" });
  return team;
}

export async function requireTeamAdmin(userId: string) {
  const access = await teamAccess(userId);
  if (!access.isAdmin) throw new HTTPException(403, { message: "Only team admins can manage tokens and people" });
  return access;
}

/** Memberships are independent; joining a team preserves the user's own workspace. */
export async function workspaceContext(userId: string, email: string) {
  const { orgInvitations } = await import('../db/schema/organizations.ts');
  const { gt, sql } = await import('drizzle-orm');
  await personalTeam(userId);
  const access = await teamAccess(userId);
  const owned = await db.select().from(organizations).where(and(eq(organizations.ownerId, userId), eq(organizations.isActive, true)));
  const joined = await db.select({ team: organizations, role: orgMemberships.role }).from(orgMemberships).innerJoin(organizations, eq(organizations.id, orgMemberships.organizationId)).where(and(eq(orgMemberships.userId, userId), eq(orgMemberships.status, 'active'), eq(organizations.isActive, true)));
  const teams = [...owned.map(t => ({ id: t.id, name: t.name, role: 'owner' })), ...joined.filter(m => !owned.some(t => t.id === m.team.id)).map(m => ({ id: m.team.id, name: m.team.name, role: m.role }))];
  const invitations = await db.select({ token: orgInvitations.token, name: organizations.name, role: orgInvitations.role }).from(orgInvitations).innerJoin(organizations, eq(organizations.id, orgInvitations.organizationId)).where(and(sql`lower(${orgInvitations.email}) = ${email.toLowerCase()}`, eq(orgInvitations.status, 'pending'), gt(orgInvitations.expiresAt, new Date()), eq(organizations.isActive, true)));
  return { currentId: access.team.id, teams, invitations };
}
