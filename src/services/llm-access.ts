/**
 * Fine-grained LLM credential sharing (per collaborator).
 *
 * An owner can let specific teammates use the owner's connected LLM for project work:
 *   - `canUseOwnerLlmKey`          → the owner's API keys (analyst chat, codebase reads,
 *                                     and builds when the owner builds via an API key).
 *   - `canUseOwnerLlmSubscription` → the owner's Claude/ChatGPT subscription for builds.
 *
 * The owner always has both. A collaborator's grants come from their projectMembers row
 * (default true for pre-existing members = grandfathered; new invitees are inserted OFF).
 */
import { and, eq } from "drizzle-orm";
import { db } from "../config/db.ts";
import { projectMembers } from "../db/schema/projects.ts";

export interface LlmGrants {
  ownerId: string;
  isOwner: boolean;
  canUseKey: boolean; // may use the owner's API keys
  canUseSub: boolean; // may use the owner's subscription (builds)
}

/**
 * Resolve what LLM access the acting user has on a project. Loads the member row
 * for a collaborator; the owner is granted everything without a lookup.
 */
export async function resolveLlmGrants(
  project: { id: string; ownerId: string },
  actingUserId: string | null | undefined,
): Promise<LlmGrants> {
  const ownerId = project.ownerId;
  const actor = actingUserId || ownerId;
  if (actor === ownerId) return { ownerId, isOwner: true, canUseKey: true, canUseSub: true };
  const [m] = await db
    .select({ k: projectMembers.canUseOwnerLlmKey, s: projectMembers.canUseOwnerLlmSubscription })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, actor), eq(projectMembers.status, "active")))
    .limit(1);
  return { ownerId, isOwner: false, canUseKey: !!m?.k, canUseSub: !!m?.s };
}

/**
 * Whose API keys the acting user should run with (analyst chat, codebase reads, preview
 * driver). The owner's when they're the owner or have been granted the key; else their own.
 */
export function llmKeyUserId(grants: LlmGrants, actingUserId: string): string {
  return grants.canUseKey ? grants.ownerId : actingUserId;
}

/** Shown when a collaborator isn't permitted to build with the owner's LLM. */
export const NO_LLM_ACCESS_MESSAGE =
  "You're not permitted to use the project owner's LLM for builds. Ask the owner to enable “Use my LLM” for you in the project's Settings → Team, or have the owner run this build.";
