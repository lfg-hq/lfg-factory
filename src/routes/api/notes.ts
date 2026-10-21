/** Project notes for the side panel: list, add, edit, delete, reveal a secret. */
import { Hono } from "hono";
import { requireAuth } from "../../auth/middleware.ts";
import { getProjectAccess } from "../../auth/project-access.ts";
import { deleteNote, listNotes, revealNoteSecret, saveNote, updateNote, type NoteKind } from "../../services/project-notes.ts";
import type { auth } from "../../auth/index.ts";

type AuthEnv = { Variables: { user: typeof auth.$Infer.Session.user; session: typeof auth.$Infer.Session.session } };
const notesApi = new Hono<AuthEnv>();
notesApi.use("*", requireAuth);

const access = async (c: { get: (k: "user") => { id: string }; req: { param: (k: string) => string | undefined } }) =>
  getProjectAccess(c.req.param("projectId")!, c.get("user").id);
const canEdit = (a: NonNullable<Awaited<ReturnType<typeof getProjectAccess>>>) => a.role === "owner" || a.permissions.canEditFiles;

notesApi.get("/:projectId/notes", async (c) => {
  const a = await access(c); if (!a) return c.json({ error: "Project not found" }, 404);
  return c.json({ notes: await listNotes(a.project.id), canEdit: canEdit(a) });
});

notesApi.post("/:projectId/notes", async (c) => {
  const a = await access(c); if (!a) return c.json({ error: "Project not found" }, 404);
  if (!canEdit(a)) return c.json({ error: "You can't edit notes in this project." }, 403);
  const b = await c.req.json<{ title?: string; body?: string; secret?: string; kind?: NoteKind }>().catch(() => ({}) as Record<string, never>);
  try { return c.json({ note: await saveNote({ projectId: a.project.id, title: String(b.title ?? ""), body: b.body, secret: b.secret || undefined, kind: b.kind, source: "user", userId: c.get("user").id }) }); }
  catch (e) { return c.json({ error: (e as Error).message }, 400); }
});

notesApi.patch("/:projectId/notes/:noteId", async (c) => {
  const a = await access(c); if (!a) return c.json({ error: "Project not found" }, 404);
  if (!canEdit(a)) return c.json({ error: "You can't edit notes in this project." }, 403);
  const b = await c.req.json<{ title?: string; body?: string; secret?: string | null; kind?: NoteKind }>().catch(() => ({}) as Record<string, never>);
  try {
    const note = await updateNote(a.project.id, c.req.param("noteId")!, b);
    return note ? c.json({ note }) : c.json({ error: "Note not found" }, 404);
  } catch (e) { return c.json({ error: (e as Error).message }, 400); }
});

notesApi.delete("/:projectId/notes/:noteId", async (c) => {
  const a = await access(c); if (!a) return c.json({ error: "Project not found" }, 404);
  if (!canEdit(a)) return c.json({ error: "You can't edit notes in this project." }, 403);
  return (await deleteNote(a.project.id, c.req.param("noteId")!)) ? c.json({ ok: true }) : c.json({ error: "Note not found" }, 404);
});

notesApi.get("/:projectId/notes/:noteId/secret", async (c) => {
  const a = await access(c); if (!a) return c.json({ error: "Project not found" }, 404);
  const secret = await revealNoteSecret(a.project.id, c.req.param("noteId")!);
  return secret === null ? c.json({ error: "No secret saved" }, 404) : c.json({ secret }, 200, { "Cache-Control": "no-store" });
});

export default notesApi;
