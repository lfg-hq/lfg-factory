import { projectTeam, teamAccess } from "../services/team-access.ts";
import { db } from "../config/db.ts";
import { projects, projectMembers } from "../db/schema/projects.ts";
import { eq, and } from "drizzle-orm";

export type ProjectRole = "owner" | "admin" | "member" | "viewer" | "guest";

export interface ProjectPermissions {
  canEditFiles: boolean;
  canManageTickets: boolean;
  canChat: boolean;
  canInviteMembers: boolean;
}

export interface ProjectAccess {
  project: typeof projects.$inferSelect;
  role: ProjectRole;
  permissions: ProjectPermissions;
}

const OWNER_PERMISSIONS: ProjectPermissions = {
  canEditFiles: true,
  canManageTickets: true,
  canChat: true,
  canInviteMembers: true,
};

/**
 * Central authorization: resolves a project by its public projectId and determines
 * the user's role and permissions. Checks ownership first, then projectMembers.
 */
export async function getProjectAccess(
  publicProjectId: string,
  userId: string
): Promise<ProjectAccess | null> {
  // Fetch the project
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.projectId, publicProjectId));

  if (!project) return null;

  let teamRole: string;
  try { teamRole = (await teamAccess(userId, (await projectTeam(project)).id)).role; } catch { return null; }

  // Check if owner
  if (project.ownerId === userId) {
    return { project, role: teamRole === "viewer" ? "viewer" : "owner", permissions: teamRole === "viewer" ? { canEditFiles: false, canManageTickets: false, canChat: false, canInviteMembers: false } : OWNER_PERMISSIONS };
  }

  // Check project membership
  const [member] = await db
    .select()
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, project.id),
        eq(projectMembers.userId, userId),
        eq(projectMembers.status, "active")
      )
    );

  if (!member) return null;

  return {
    project,
    role: member.role as ProjectRole,
    permissions: {
      canEditFiles: teamRole !== "viewer" && member.canEditFiles,
      canManageTickets: teamRole !== "viewer" && member.canManageTickets,
      canChat: teamRole !== "viewer" && member.canChat,
      canInviteMembers: teamRole !== "viewer" && member.canInviteMembers,
    },
  };
}

/**
 * Throws a permission error if the access object lacks the required permission.
 * Returns true on success for use as a guard.
 */
export function requirePermission(
  access: ProjectAccess,
  permissionKey: keyof ProjectPermissions
): boolean {
  if (access.role === "owner") return true;
  if (!access.permissions[permissionKey]) {
    throw new PermissionError(`Missing permission: ${permissionKey}`);
  }
  return true;
}

export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionError";
  }
}
