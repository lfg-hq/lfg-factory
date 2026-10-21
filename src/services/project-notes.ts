/**
 * Project notes: what the agent or the user wants kept across chats — test logins,
 * URLs, decisions, setup steps. A secret (password, API key) is encrypted at rest and
 * only returned by an explicit reveal; listings say only that a secret exists.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "../config/db.ts";
import { projectNotes } from "../db/schema/notes.ts";
import { decryptSecret, encryptSecret } from "../utils/crypto.ts";

export const NOTE_KINDS = ["note", "login", "decision", "link"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export type NoteView = { id: string; kind: string; title: string; body: string; hasSecret: boolean; source: string; updatedAt: Date };

const view = (n: typeof projectNotes.$inferSelect): NoteView => ({
  id: n.id, kind: n.kind, title: n.title, body: n.body, hasSecret: !!n.secretEncrypted, source: n.source, updatedAt: n.updatedAt,
});

function sealSecret(secret: string): string {
  const sealed = encryptSecret(secret);
  if (!sealed.startsWith("gcm:")) throw new Error("Encrypted storage is unavailable (ENCRYPTION_KEY is not set), so the secret was not saved.");
  return sealed;
}

export async function listNotes(projectId: string): Promise<NoteView[]> {
  const rows = await db.select().from(projectNotes).where(eq(projectNotes.projectId, projectId)).orderBy(desc(projectNotes.updatedAt));
  return rows.map(view);
}

/** Save by title: a note with the same title (any case) is updated instead of duplicated. */
export async function saveNote(o: { projectId: string; title: string; body?: string; secret?: string | null; kind?: NoteKind; source: "agent" | "user"; userId?: string }): Promise<NoteView> {
  const title = o.title.trim().slice(0, 200);
  if (!title) throw new Error("A note needs a title.");
  const kind = NOTE_KINDS.includes(o.kind as NoteKind) ? o.kind! : "note";
  const existing = (await db.select().from(projectNotes).where(eq(projectNotes.projectId, o.projectId)))
    .find((n) => n.title.toLowerCase() === title.toLowerCase());
  const secretEncrypted = o.secret ? sealSecret(o.secret) : o.secret === null ? null : undefined;
  if (existing) {
    const [row] = await db.update(projectNotes).set({
      kind, body: o.body ?? existing.body, ...(secretEncrypted !== undefined ? { secretEncrypted } : {}), updatedAt: new Date(),
    }).where(eq(projectNotes.id, existing.id)).returning();
    return view(row!);
  }
  const [row] = await db.insert(projectNotes).values({
    projectId: o.projectId, kind, title, body: o.body ?? "", secretEncrypted: secretEncrypted ?? null, source: o.source, createdBy: o.userId ?? null,
  }).returning();
  return view(row!);
}

export async function updateNote(projectId: string, id: string, patch: { title?: string; body?: string; secret?: string | null; kind?: NoteKind }): Promise<NoteView | null> {
  const set: Partial<typeof projectNotes.$inferInsert> = { updatedAt: new Date() };
  if (patch.title !== undefined) { const t = patch.title.trim().slice(0, 200); if (!t) throw new Error("A note needs a title."); set.title = t; }
  if (patch.body !== undefined) set.body = patch.body;
  if (patch.kind !== undefined && NOTE_KINDS.includes(patch.kind)) set.kind = patch.kind;
  if (patch.secret !== undefined) set.secretEncrypted = patch.secret ? sealSecret(patch.secret) : null;
  const [row] = await db.update(projectNotes).set(set).where(and(eq(projectNotes.id, id), eq(projectNotes.projectId, projectId))).returning();
  return row ? view(row) : null;
}

export async function deleteNote(projectId: string, id: string): Promise<boolean> {
  const rows = await db.delete(projectNotes).where(and(eq(projectNotes.id, id), eq(projectNotes.projectId, projectId))).returning({ id: projectNotes.id });
  return rows.length > 0;
}

export async function revealNoteSecret(projectId: string, id: string): Promise<string | null> {
  const [row] = await db.select({ s: projectNotes.secretEncrypted }).from(projectNotes).where(and(eq(projectNotes.id, id), eq(projectNotes.projectId, projectId))).limit(1);
  return row?.s ? decryptSecret(row.s) : null;
}

/** A note by exact (else partial) title, with its secret decrypted, for the agent. */
export async function readNote(projectId: string, title: string): Promise<(NoteView & { secret?: string }) | null> {
  const rows = await db.select().from(projectNotes).where(eq(projectNotes.projectId, projectId));
  const q = title.trim().toLowerCase();
  const hit = rows.find((n) => n.title.toLowerCase() === q) ?? rows.find((n) => n.title.toLowerCase().includes(q));
  if (!hit) return null;
  return { ...view(hit), ...(hit.secretEncrypted ? { secret: decryptSecret(hit.secretEncrypted) } : {}) };
}

/** One line per note for the agent's context: titles and kinds only, never secrets or bodies. */
export async function notesContext(projectId: string): Promise<string> {
  const notes = (await listNotes(projectId).catch(() => [])).slice(0, 40);
  if (!notes.length) return "";
  return "Project notes saved earlier (read one with readNote before relying on it):\n" +
    notes.map((n) => `- [${n.kind}] ${n.title}${n.hasSecret ? " (has a saved secret)" : ""}`).join("\n");
}
