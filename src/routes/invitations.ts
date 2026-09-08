import { getProjectAccess } from "../auth/project-access.ts";
import { projectTeam } from "../services/team-access.ts";
import { orgMemberships } from "../db/schema/organizations.ts";
import { Hono } from "hono";
import { requireAuth, optionalAuth } from "../auth/middleware.ts";
import { db } from "../config/db.ts";
import { projects, projectMembers, projectInvitations } from "../db/schema/projects.ts";
import { users, profiles } from "../db/schema/users.ts";
import { eq, and } from "drizzle-orm";
import { InvitationAcceptPage } from "../templates/pages/invitation-accept.tsx";
import type { auth } from "../auth/index.ts";

type AuthEnv = {
  Variables: {
    user: typeof auth.$Infer.Session.user | null;
    session: typeof auth.$Infer.Session.session | null;
  };
};

const invitationRoutes = new Hono<AuthEnv>();

// ── GET /invitations/accept/:token — show invitation page ────────────
invitationRoutes.get("/invitations/accept/:token", optionalAuth, async (c) => {
  const { token } = c.req.param();
  const user = c.get("user");

  const [invitation] = await db
    .select()
    .from(projectInvitations)
    .where(eq(projectInvitations.token, token!));

  if (!invitation || invitation.status !== "pending") {
    return c.text("Invitation not found or already used", 404);
  }

  // Check expiry
  if (invitation.expiresAt && new Date(invitation.expiresAt) < new Date()) {
    return c.text("This invitation has expired", 410);
  }

  // Get project and inviter info
  const [project] = await db
    .select({ name: projects.name, icon: projects.icon })
    .from(projects)
    .where(eq(projects.id, invitation.projectId));

  const [inviter] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, invitation.inviterId));

  if (!user) {
    // Not logged in — redirect to login with return URL
    return c.redirect(`/auth/login?redirect=/invitations/accept/${token}`);
  }

  return c.html(
    InvitationAcceptPage({
      user: { id: user.id, name: user.name, email: user.email },
      invitation: {
        id: invitation.id,
        token: invitation.token,
        email: invitation.email,
        role: invitation.role,
      },
      project: {
        name: project?.name ?? "Unknown Project",
        icon: project?.icon ?? "📋",
      },
      inviterName: inviter?.name ?? "Someone",
    })
  );
});

// ── POST /invitations/accept/:token — accept invitation ──────────────
invitationRoutes.post("/invitations/accept/:token", requireAuth as any, async (c) => {
  const user = c.get("user")!;
  const { token } = c.req.param();

  const [invitation] = await db
    .select()
    .from(projectInvitations)
    .where(
      and(
        eq(projectInvitations.token, token!),
        eq(projectInvitations.status, "pending")
      )
    );

  if (!invitation) return c.text("Invitation not found or already used", 404);
  if (invitation.email.toLowerCase() !== user.email.toLowerCase()) return c.text("Sign in with the invited email address", 403);

  if (invitation.expiresAt && new Date(invitation.expiresAt) < new Date()) {
    return c.text("This invitation has expired", 410);
  }

  // Set permissions based on role
  const isGuest = invitation.role === "guest" || invitation.role === "viewer";

  const [teamProject] = await db.select().from(projects).where(eq(projects.id, invitation.projectId)).limit(1);
  if (!teamProject) return c.text("Project unavailable", 404);
  const inviterAccess = await getProjectAccess(teamProject.projectId, invitation.inviterId);
  if (!inviterAccess || !["owner", "admin"].includes(inviterAccess.role) || (invitation.role === "admin" && inviterAccess.role !== "owner")) return c.text("Invitation is no longer authorized", 403);
  const team = await projectTeam(teamProject);
  const [existingTeamMember] = await db.select().from(orgMemberships).where(and(eq(orgMemberships.userId, user.id), eq(orgMemberships.organizationId, team.id))).limit(1);
  if (existingTeamMember && existingTeamMember.status !== "active") return c.text("Ask a team admin to restore your team access", 403);
  await db.insert(orgMemberships).values({ userId: user.id, organizationId: team.id, role: "member" }).onConflictDoNothing();
  await db.insert(profiles).values({ userId: user.id, currentOrganizationId: team.id }).onConflictDoNothing();

  // Create member row
  const memberValues = {
    projectId: invitation.projectId,
    userId: user.id,
    role: invitation.role,
    canEditFiles: !isGuest,
    canManageTickets: !isGuest,
    canChat: invitation.role !== "viewer",
    canInviteMembers: invitation.role === "admin",
    // Grants come from the invitation; new invitations default both options off.
    canUseOwnerLlmKey: invitation.canUseOwnerLlmKey,
    canUsePersonalSubscription: invitation.canUsePersonalSubscription,
    canUseOwnerLlmSubscription: false,
    invitedById: invitation.inviterId,
  };
  await db.insert(projectMembers).values(memberValues).onConflictDoUpdate({ target: [projectMembers.projectId, projectMembers.userId], set: { ...memberValues, status: "active", updatedAt: new Date() } });

  // Update invitation status
  await db
    .update(projectInvitations)
    .set({ status: "accepted", respondedAt: new Date() })
    .where(eq(projectInvitations.id, invitation.id));

  // Get project for redirect
  const [project] = await db
    .select({ projectId: projects.projectId })
    .from(projects)
    .where(eq(projects.id, invitation.projectId));

  return c.redirect(`/projects/${project?.projectId ?? ""}`);
});

export default invitationRoutes;
