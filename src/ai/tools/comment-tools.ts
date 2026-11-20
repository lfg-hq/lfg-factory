/**
 * The agent answers comments people leave on project documents: after it revises a
 * document because of a comment, it replies in that comment's thread (shown as the AI
 * agent) and, when the change settles it, resolves the thread. Bound to the chat's
 * project and user, so it can only touch comments on that project's documents.
 */
import { tool, zodSchema } from "ai";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../../config/db.ts";
import { documentComments } from "../../db/schema/comments.ts";
import { projectFiles } from "../../db/schema/documents.ts";

type Store = typeof db;

/** Reply to a comment thread on one of the project's documents, optionally resolving it. */
export async function replyToComment(store: Store, context: { projectId: string; userId: string }, a: { commentId: string; reply: string; resolve?: boolean }) {
  const reply = a.reply.trim();
  if (!reply) return { replied: false, error: "The reply is empty." };
  const [found] = await store.select({ comment: documentComments, fileProject: projectFiles.projectId })
    .from(documentComments).innerJoin(projectFiles, eq(projectFiles.id, documentComments.fileId))
    .where(eq(documentComments.id, a.commentId)).limit(1);
  if (!found || found.fileProject !== context.projectId) return { replied: false, error: `No comment ${a.commentId} on this project's documents. Use getDocumentComments for the ids.` };
  // A reply to a reply goes into the same thread.
  const thread = found.comment.parentId
    ? (await store.select().from(documentComments).where(eq(documentComments.id, found.comment.parentId)).limit(1))[0] ?? found.comment
    : found.comment;
  const [row] = await store.insert(documentComments).values({
    fileId: thread.fileId, userId: context.userId, byAgent: true,
    selectedText: thread.selectedText, rangeStart: thread.rangeStart, rangeEnd: thread.rangeEnd,
    content: reply, parentId: thread.id,
  }).returning({ id: documentComments.id });
  if (a.resolve && !thread.isResolved) {
    await store.update(documentComments).set({ isResolved: true, resolvedById: context.userId, resolvedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(documentComments.id, thread.id), eq(documentComments.isResolved, false)));
  }
  return { replied: true, replyId: row?.id ?? null, threadId: thread.id, resolved: !!a.resolve || thread.isResolved };
}

export function commentTools(context: { projectId: string; userId: string }) {
  return {
    replyToDocumentComment: tool({
      description:
        "Reply in a comment thread on a project document, as the AI agent. Whenever you change a document because of " +
        "a comment, reply in that thread saying in a sentence or two what you changed (or why you didn't), and pass " +
        "resolve: true when the change fully addresses it. Leave it open when you need the person's answer, and ask " +
        "your question in the reply. Get comment ids from getDocumentComments.",
      inputSchema: zodSchema(z.object({
        commentId: z.string().describe("The comment's id from getDocumentComments"),
        reply: z.string().min(1).max(4000).describe("What you changed, plainly; no headings"),
        resolve: z.boolean().optional().describe("Mark the thread resolved (default false)"),
      })),
      execute: async (a: { commentId: string; reply: string; resolve?: boolean }) => {
        try { return await replyToComment(db, context, a); }
        catch (e) { return { replied: false, error: (e as Error).message }; }
      },
    }),
  };
}
