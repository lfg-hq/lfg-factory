import { Hono } from "hono";
import { requireAuth } from "../../auth/middleware.ts";
import { db } from "../../config/db.ts";
import { projects, projectMembers, projectInvitations } from "../../db/schema/projects.ts";
import { users } from "../../db/schema/users.ts";
import { eq, and, desc } from "drizzle-orm";
import { getProjectAccess } from "../../auth/project-access.ts";
import { sendEmail } from "../../utils/email.ts";
import { env } from "../../config/env.ts";
import type { auth } from "../../auth/index.ts";

type AuthEnv = {
  Variables: {
    user: typeof auth.$Infer.Session.user;
    session: typeof auth.$Infer.Session.session;
  };
};

const invitationsApi = new Hono<AuthEnv>();
invitationsApi.use("*", requireAuth);

// ── POST /api/projects/:projectId/invitations — invite by email ──────
invitationsApi.post("/:projectId/invitations", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();

  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  // Inviting is strictly owner/admin only — collaborators/viewers cannot add users.
  if (access.role !== "owner" && access.role !== "admin") {
    return c.json({ error: "Only the project owner can invite people." }, 403);
  }

  const body = await c.req.json<{ email: string; role?: string }>();
  const email = body.email?.trim().toLowerCase();
  if (!email) return c.json({ error: "Email is required" }, 400);

  const role = body.role ?? "viewer";
  if (!["member", "viewer", "guest"].includes(role)) {
    return c.json({ error: "Invalid role" }, 400);
  }

  // Check if already invited
  const [existing] = await db
    .select()
    .from(projectInvitations)
    .where(
      and(
        eq(projectInvitations.projectId, access.project.id),
        eq(projectInvitations.email, email),
        eq(projectInvitations.status, "pending")
      )
    );

  if (existing) return c.json({ error: "Invitation already pending for this email" }, 409);

  // Check if already a member
  const [existingUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email));

  if (existingUser) {
    const [existingMember] = await db
      .select()
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, access.project.id),
          eq(projectMembers.userId, existingUser.id)
        )
      );
    if (existingMember) return c.json({ error: "User is already a member" }, 409);
  }

  const token = crypto.randomUUID() + "-" + crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  // Upsert: the unique constraint is on (projectId, email) regardless of status,
  // so a previously revoked/expired invite for this email still occupies the row.
  // Re-issue it (new token, role, expiry, back to pending) instead of crashing on
  // a duplicate-key insert.
  const [invitation] = await db
    .insert(projectInvitations)
    .values({
      projectId: access.project.id,
      inviterId: user.id,
      email,
      role,
      token,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: [projectInvitations.projectId, projectInvitations.email],
      set: {
        inviterId: user.id,
        role,
        token,
        expiresAt,
        status: "pending",
        respondedAt: null,
      },
    })
    .returning();

  // Send invitation email. Use the PUBLIC base URL so the accept link is
  // reachable by an external guest — BETTER_AUTH_URL is localhost in dev.
  const publicBase = (env.APP_URL || env.BETTER_AUTH_URL).replace(/\/$/, "");
  const acceptUrl = `${publicBase}/invitations/accept/${token}`;
  const projectName = access.project.name;
  const inviterName = user.name || user.email || "A team member";
  const roleLabel = ({ member: "Collaborator", viewer: "Viewer", guest: "Guest" } as Record<string, string>)[role] ?? (role.charAt(0).toUpperCase() + role.slice(1));

  const emailSent = await sendEmail({
    to: email,
    subject: `You're invited to join "${projectName}" on LFG`,
    text: `${inviterName} has invited you to join "${projectName}" as a ${roleLabel}.\n\nAccept the invitation: ${acceptUrl}\n\nThis invitation expires in 7 days.`,
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;padding:2rem;">
        <div style="text-align:center;margin-bottom:2rem;">
          <h1 style="font-size:1.5rem;color:#1a1a2e;margin:0;">LFG</h1>
        </div>
        <div style="background:#f8f9fa;border:1px solid #e9ecef;border-radius:12px;padding:2rem;text-align:center;">
          <p style="font-size:1rem;color:#495057;margin:0 0 0.5rem;">
            <strong>${inviterName}</strong> has invited you to join
          </p>
          <h2 style="font-size:1.25rem;color:#1a1a2e;margin:0.5rem 0 1rem;">
            ${access.project.icon} ${projectName}
          </h2>
          <p style="font-size:0.875rem;color:#868e96;margin:0 0 1.5rem;">
            Role: <strong>${roleLabel}</strong>
          </p>
          <a href="${acceptUrl}"
            style="display:inline-block;background:#7c3aed;color:white;text-decoration:none;padding:0.75rem 2rem;border-radius:8px;font-weight:600;font-size:0.9375rem;">
            Accept Invitation
          </a>
          <p style="font-size:0.75rem;color:#adb5bd;margin:1.5rem 0 0;">
            This invitation expires in 7 days.
          </p>
        </div>
        <p style="font-size:0.75rem;color:#adb5bd;text-align:center;margin-top:1.5rem;">
          If you didn't expect this invitation, you can safely ignore this email.
        </p>
      </div>
    `,
  });
  if (!emailSent) console.error(`[invitations] Failed to send invite email to ${email} (check [Email] SendGrid error above)`);
  else console.log(`[invitations] Sent invite email to ${email} for project "${projectName}"`);

  // Return the accept link + whether the email actually sent, so the UI can be
  // honest and the owner can share the link directly if delivery failed.
  return c.json({ invitation, acceptUrl, emailSent }, 201);
});

// ── GET /api/projects/:projectId/invitations — list pending ──────────
invitationsApi.get("/:projectId/invitations", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();

  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);

  const rows = await db
    .select()
    .from(projectInvitations)
    .where(
      and(
        eq(projectInvitations.projectId, access.project.id),
        eq(projectInvitations.status, "pending")
      )
    )
    .orderBy(desc(projectInvitations.createdAt));

  return c.json({ invitations: rows });
});

// ── DELETE /api/projects/:projectId/invitations/:id — revoke ─────────
invitationsApi.delete("/:projectId/invitations/:id", async (c) => {
  const user = c.get("user");
  const { projectId, id } = c.req.param();

  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  if (access.role !== "owner" && access.role !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }

  await db
    .update(projectInvitations)
    .set({ status: "revoked", respondedAt: new Date() })
    .where(
      and(
        eq(projectInvitations.id, id!),
        eq(projectInvitations.projectId, access.project.id)
      )
    );

  return c.json({ success: true });
});

// ── GET /api/projects/:projectId/members — list members ──────────────
invitationsApi.get("/:projectId/members", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();

  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);

  const members = await db
    .select({
      id: projectMembers.id,
      userId: projectMembers.userId,
      role: projectMembers.role,
      status: projectMembers.status,
      canEditFiles: projectMembers.canEditFiles,
      canManageTickets: projectMembers.canManageTickets,
      canChat: projectMembers.canChat,
      canInviteMembers: projectMembers.canInviteMembers,
      joinedAt: projectMembers.joinedAt,
      userName: users.name,
      userEmail: users.email,
    })
    .from(projectMembers)
    .innerJoin(users, eq(projectMembers.userId, users.id))
    .where(
      and(
        eq(projectMembers.projectId, access.project.id),
        eq(projectMembers.status, "active")
      )
    );

  // Include owner
  const [owner] = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, access.project.ownerId));

  return c.json({
    owner: owner ? { id: owner.id, name: owner.name, email: owner.email, role: "owner" } : null,
    members,
  });
});

// ── DELETE /api/projects/:projectId/members/:id — remove member ──────
invitationsApi.delete("/:projectId/members/:id", async (c) => {
  const user = c.get("user");
  const { projectId, id } = c.req.param();

  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  if (access.role !== "owner" && access.role !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }

  await db
    .update(projectMembers)
    .set({ status: "removed", updatedAt: new Date() })
    .where(
      and(
        eq(projectMembers.id, id!),
        eq(projectMembers.projectId, access.project.id)
      )
    );

  return c.json({ success: true });
});

// ── PATCH /api/projects/:projectId/members/:id — update role/perms ───
invitationsApi.patch("/:projectId/members/:id", async (c) => {
  const user = c.get("user");
  const { projectId, id } = c.req.param();

  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  if (access.role !== "owner" && access.role !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const body = await c.req.json<Partial<{
    role: string;
    canEditFiles: boolean;
    canManageTickets: boolean;
    canChat: boolean;
    canInviteMembers: boolean;
  }>>();

  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (body.role !== undefined) updateData.role = body.role;
  if (body.canEditFiles !== undefined) updateData.canEditFiles = body.canEditFiles;
  if (body.canManageTickets !== undefined) updateData.canManageTickets = body.canManageTickets;
  if (body.canChat !== undefined) updateData.canChat = body.canChat;
  if (body.canInviteMembers !== undefined) updateData.canInviteMembers = body.canInviteMembers;

  const [updated] = await db
    .update(projectMembers)
    .set(updateData)
    .where(
      and(
        eq(projectMembers.id, id!),
        eq(projectMembers.projectId, access.project.id)
      )
    )
    .returning();

  return c.json({ member: updated });
});

export default invitationsApi;
