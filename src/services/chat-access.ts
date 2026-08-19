import { db } from "../config/db.ts";
import { conversations } from "../db/schema/chat.ts";
import { projects } from "../db/schema/projects.ts";
import { eq } from "drizzle-orm";
import { getProjectAccess } from "../auth/project-access.ts";

/**
 * Who may read / write someone else's project conversation.
 *
 * The author always can. Everyone else depends on the project's `shareChatHistory`
 * opt-in, and then splits by role:
 *
 *   - READ  — any active member. Enough to see what the client asked for.
 *   - WRITE — owner or admin only. Lets a lead pick up a collaborator's thread and
 *             keep going, without every member being able to type into anyone's chat.
 *
 * Before this existed the write path checked NOTHING — `handleStream` only verified
 * the conversation row existed, so any caller holding a conversation id could post
 * into it, across projects. This is that hole turned into an actual permission.
 */
export type ChatAccess = {
  canRead: boolean;
  canWrite: boolean;
  isAuthor: boolean;
  /** Set when a non-author is writing, so the message can be attributed. */
  actingAsGuest: boolean;
};

const DENY: ChatAccess = { canRead: false, canWrite: false, isAuthor: false, actingAsGuest: false };

export async function getChatAccess(conversationId: string, userId: string): Promise<ChatAccess> {
  const [conv] = await db
    .select({ userId: conversations.userId, projectId: conversations.projectId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!conv) return DENY;

  if (conv.userId === userId) {
    return { canRead: true, canWrite: true, isAuthor: true, actingAsGuest: false };
  }

  // A conversation with no project has no sharing story — it's personal.
  if (!conv.projectId) return DENY;

  const [proj] = await db
    .select({ shareChatHistory: projects.shareChatHistory })
    .from(projects)
    .where(eq(projects.projectId, conv.projectId))
    .limit(1);
  if (!proj?.shareChatHistory) return DENY;

  const access = await getProjectAccess(conv.projectId, userId);
  if (!access) return DENY;

  const isAdmin = access.role === "owner" || access.role === "admin";
  return { canRead: true, canWrite: isAdmin, isAuthor: false, actingAsGuest: true };
}
