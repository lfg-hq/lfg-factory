import { llmApiKeys } from "../db/schema/users.ts";
import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { db } from "../config/db.ts";
import { projectMembers, projects } from "../db/schema/projects.ts";
import { projectTeam, teamAccess } from "./team-access.ts";

export interface LlmGrants {
  ownerId: string;
  keyUserId: string;
  isOwner: boolean;
  canUseKey: boolean;
  canUseSub: boolean;
  canUsePersonalSubscription: boolean;
}

export async function resolveLlmGrants(project: { id: string; ownerId: string }, actingUserId: string | null | undefined): Promise<LlmGrants> {
  const actor = actingUserId || project.ownerId;
  const [stored] = await db.select().from(projects).where(eq(projects.id, project.id)).limit(1);
  if (!stored) throw new HTTPException(404, { message: "Project not found" });
  const team = await projectTeam(stored);
  const { role: teamRole } = await teamAccess(actor, team.id);
  const isOwner = actor === project.ownerId;
  const [member] = await db.select().from(projectMembers).where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, actor), eq(projectMembers.status, "active"))).limit(1);
  if (!isOwner && !member) throw new HTTPException(403, { message: "Project access denied" });
  const canRun = isOwner || (!!member?.canChat && member.role !== "viewer");
  return {
    ownerId: project.ownerId, keyUserId: team.ownerId, isOwner,
    canUseKey: canRun && teamRole !== "viewer" && team.tokensEnabled && (isOwner || !!member?.canUseOwnerLlmKey),
    // Subscriptions are personal. Legacy grants never lend another person's login.
    canUseSub: canRun && teamRole !== "viewer" && team.subscriptionsEnabled && isOwner,
    canUsePersonalSubscription: canRun && teamRole !== "viewer" && team.subscriptionsEnabled && (isOwner || !!member?.canUsePersonalSubscription),
  };
}

export function llmKeyUserId(grants: LlmGrants, _actingUserId: string): string {
  if (!grants.canUseKey) throw new HTTPException(403, { message: NO_LLM_ACCESS_MESSAGE });
  return grants.keyUserId;
}

export async function userLlmAccess(userId: string, publicProjectId?: string | null) {
  if (publicProjectId) {
    const [project] = await db.select().from(projects).where(eq(projects.projectId, publicProjectId)).limit(1);
    if (!project) throw new HTTPException(404, { message: "Project not found" });
    const g = await resolveLlmGrants(project, userId);
    return { canUseKey: g.canUseKey, canUseSubscription: g.canUsePersonalSubscription, keyUserId: g.keyUserId };
  }
  const { team, role } = await teamAccess(userId);
  return { canUseKey: team.tokensEnabled && role !== "viewer", canUseSubscription: team.subscriptionsEnabled && role !== "viewer", keyUserId: team.ownerId };
}

export const NO_LLM_ACCESS_MESSAGE = "LLM access is disabled. Ask an admin to allow team tokens or your personal ChatGPT subscription in Project Settings → Team.";

export async function teamApiKeys(userId: string, internalProjectId?: string) {
  let keyUserId: string;
  if (internalProjectId) {
    const [project] = await db.select().from(projects).where(eq(projects.id, internalProjectId)).limit(1);
    if (!project) throw new HTTPException(404, { message: "Project not found" });
    keyUserId = llmKeyUserId(await resolveLlmGrants(project, userId), userId);
  } else {
    const access = await userLlmAccess(userId);
    if (!access.canUseKey) throw new HTTPException(403, { message: NO_LLM_ACCESS_MESSAGE });
    keyUserId = access.keyUserId;
  }
  return (await db.select().from(llmApiKeys).where(eq(llmApiKeys.userId, keyUserId)).limit(1))[0];
}
