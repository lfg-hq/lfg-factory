/**
 * Project notes for the chat agent: keep what matters across chats (test logins, URLs,
 * decisions, setup steps) and read it back later. Secrets are stored encrypted.
 */
import { tool, zodSchema } from "ai";
import { z } from "zod";
import { NOTE_KINDS, listNotes, readNote, saveNote } from "../../services/project-notes.ts";

export function noteTools(context: { projectId: string; userId: string; onSaved?: (title: string) => void }) {
  return {
    saveNote: tool({
      description: "Save something worth keeping for this project in Notes, the user's persistent notebook: a test login, a URL, a decision, setup steps, an important generated value. Save on your own initiative whenever you generate or discover something the user will need again, then say \"Saved to Notes\". A note with the same title is updated, not duplicated. Put passwords, API keys and tokens in `secret` (stored encrypted, masked in the UI), never in `body`.",
      inputSchema: zodSchema(z.object({
        title: z.string().min(1).max(200).describe("Short and specific, e.g. \"Preview login: recruiter\""),
        body: z.string().max(20000).default("").describe("Markdown: what it is, where it applies (branch, URL), how to use it. No secrets here."),
        secret: z.string().max(5000).optional().describe("Password, API key or token; encrypted at rest."),
        kind: z.enum(NOTE_KINDS).default("note"),
      })),
      execute: async (a: { title: string; body: string; secret?: string; kind: (typeof NOTE_KINDS)[number] }) => {
        try {
          const note = await saveNote({ projectId: context.projectId, title: a.title, body: a.body, secret: a.secret, kind: a.kind, source: "agent", userId: context.userId });
          context.onSaved?.(note.title);
          return { saved: true, id: note.id, title: note.title, hasSecret: note.hasSecret };
        } catch (e) { return { saved: false, error: (e as Error).message }; }
      },
    }),
    readNote: tool({
      description: "Read saved project notes. With no title, lists every note (titles, kinds, bodies). With a title, returns that note including its secret, so you can give the user a saved login when they ask.",
      inputSchema: zodSchema(z.object({ title: z.string().optional().describe("Exact or partial title of the note to open") })),
      execute: async ({ title }: { title?: string }) => {
        if (!title) return { notes: (await listNotes(context.projectId)).map(({ id, kind, title, body, hasSecret, updatedAt }) => ({ id, kind, title, body: body.slice(0, 600), hasSecret, updatedAt })) };
        const note = await readNote(context.projectId, title);
        return note ?? { error: `No note matches "${title}". Call readNote without a title to list them.` };
      },
    }),
  };
}
