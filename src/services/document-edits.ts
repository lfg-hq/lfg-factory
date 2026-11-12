import { db } from "../config/db.ts";
import { documentEdits, projectFiles, projectFileVersions } from "../db/schema/documents.ts";
import { users } from "../db/schema/users.ts";
import { and, desc, eq } from "drizzle-orm";
import { getContent } from "./s3.ts";

// Who changed a document, how (Docs editor vs agent), and what changed.
// Each row points at the saved version holding the text from before the
// change, so the change can always be rebuilt as a diff.

export type EditSource = "editor" | "agent" | "raw";

const SESSION_GAP_MS = 10 * 60 * 1000;
const MAX_DIFF_CELLS = 4_000_000; // lines(a) * lines(b) before we stop diffing line by line

export interface LineDiff { added: number; removed: number; text: string; truncated: boolean }

/** Unified-style line diff (LCS). Context lines around changes; long output is cut. */
export function lineDiff(before: string, after: string, context = 2, maxChars = 6000): LineDiff {
  const a = before.split("\n"), b = after.split("\n");
  if (a.length * b.length > MAX_DIFF_CELLS) {
    return { added: b.length, removed: a.length, text: "(document too large to diff line by line)", truncated: true };
  }
  const n = a.length, m = b.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  const ops: Array<{ t: " " | "-" | "+"; s: string }> = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: " ", s: a[i]! }); i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) ops.push({ t: "-", s: a[i++]! });
    else ops.push({ t: "+", s: b[j++]! });
  }
  while (i < n) ops.push({ t: "-", s: a[i++]! });
  while (j < m) ops.push({ t: "+", s: b[j++]! });

  const added = ops.filter((o) => o.t === "+").length;
  const removed = ops.filter((o) => o.t === "-").length;
  const keep = new Set<number>();
  ops.forEach((o, k) => { if (o.t !== " ") for (let d = -context; d <= context; d++) keep.add(k + d); });
  let text = "", prev = -2, truncated = false;
  for (let k = 0; k < ops.length; k++) {
    if (!keep.has(k)) continue;
    if (k !== prev + 1) text += "@@\n";
    text += ops[k]!.t + " " + ops[k]!.s + "\n";
    prev = k;
    if (text.length > maxChars) { truncated = true; text = text.slice(0, maxChars) + "\n… (diff truncated)"; break; }
  }
  return { added, removed, text: text.trimEnd(), truncated };
}

async function versionContent(fileId: string, version: number | null): Promise<string | null> {
  if (version == null) return null;
  const [row] = await db.select({ content: projectFileVersions.content }).from(projectFileVersions)
    .where(and(eq(projectFileVersions.fileId, fileId), eq(projectFileVersions.versionNumber, version))).limit(1);
  return row?.content ?? null;
}

/**
 * Log a change. Editor saves from the same person within a few minutes are one
 * session: the row keeps its original base version and its counts are refreshed.
 */
export async function recordDocumentEdit(opts: {
  fileId: string; userId: string | null; source: EditSource;
  baseVersion: number | null; before: string; after: string;
}): Promise<void> {
  try {
    if (opts.source !== "agent") {
      const [latest] = await db.select().from(documentEdits)
        .where(eq(documentEdits.fileId, opts.fileId)).orderBy(desc(documentEdits.updatedAt)).limit(1);
      const updated = latest?.updatedAt instanceof Date ? latest.updatedAt.getTime() : 0;
      if (latest && latest.userId === opts.userId && latest.source === opts.source && Date.now() - updated < SESSION_GAP_MS) {
        const base = (await versionContent(opts.fileId, latest.baseVersion)) ?? opts.before;
        const d = lineDiff(base, opts.after);
        await db.update(documentEdits).set({ addedLines: d.added, removedLines: d.removed, updatedAt: new Date() })
          .where(eq(documentEdits.id, latest.id));
        return;
      }
    }
    const d = lineDiff(opts.before, opts.after);
    await db.insert(documentEdits).values({
      fileId: opts.fileId, userId: opts.userId, source: opts.source, baseVersion: opts.baseVersion,
      addedLines: d.added, removedLines: d.removed,
    });
  } catch (err) {
    // The edit itself is already saved; a missing log row must never fail it.
    console.error("[document-edits] could not record edit:", err);
  }
}

/** Recent changes to a document, newest first, each with who/how/when and a diff. */
export async function listDocumentEdits(fileId: string, limit = 5) {
  const rows = await db.select({
    id: documentEdits.id, source: documentEdits.source, baseVersion: documentEdits.baseVersion,
    addedLines: documentEdits.addedLines, removedLines: documentEdits.removedLines,
    createdAt: documentEdits.createdAt, updatedAt: documentEdits.updatedAt, userName: users.name,
  }).from(documentEdits).leftJoin(users, eq(users.id, documentEdits.userId))
    .where(eq(documentEdits.fileId, fileId)).orderBy(desc(documentEdits.updatedAt)).limit(Math.min(Math.max(limit, 1), 20));

  const [file] = await db.select({ s3Key: projectFiles.s3Key, content: projectFiles.content })
    .from(projectFiles).where(eq(projectFiles.id, fileId)).limit(1);
  const current = file ? await getContent(file.s3Key, file.content) : "";

  // Newest first: each change ends where the next-newer change began (or at the current text).
  let afterText: string | null = current;
  const out = [];
  for (const r of rows) {
    const before = await versionContent(fileId, r.baseVersion);
    const diff = before != null && afterText != null ? lineDiff(before, afterText) : null;
    out.push({
      by: r.userName ?? "Unknown user",
      how: r.source === "agent" ? "the agent (on their behalf)" : r.source === "raw" ? "raw markdown editor" : "Docs editor",
      startedAt: r.createdAt, lastSavedAt: r.updatedAt,
      linesAdded: r.addedLines, linesRemoved: r.removedLines,
      diff: diff ? diff.text : "(earlier text not available)",
    });
    afterText = before;
  }
  return out;
}

/** One-line summary of the most recent change, for getFileContent. */
export async function lastEditSummary(fileId: string) {
  const [r] = await db.select({ source: documentEdits.source, updatedAt: documentEdits.updatedAt, userName: users.name })
    .from(documentEdits).leftJoin(users, eq(users.id, documentEdits.userId))
    .where(eq(documentEdits.fileId, fileId)).orderBy(desc(documentEdits.updatedAt)).limit(1);
  if (!r) return null;
  return { by: r.userName ?? "Unknown user", via: r.source, at: r.updatedAt };
}
