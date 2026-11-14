/**
 * Whiteboard storage: boards, what is on them, and the conversation with the agent.
 *
 * A board's elements live in one JSON column. Browsers never send the whole board: they send
 * the elements they changed and the ids they removed, and the server merges that into the
 * stored board. Each element is stamped with `v`, the board version at which it last changed,
 * so a browser can ask "what changed since version N" and two people editing different
 * elements never overwrite each other (the same element is last-write-wins).
 */
import { desc, eq, sql } from "drizzle-orm";
import { db } from "../../config/db.ts";
import { whiteboards, whiteboardMessages } from "../../db/schema/whiteboards.ts";

export type Board = typeof whiteboards.$inferSelect;
export type BoardElement = { id: string; type: string; v?: number; [key: string]: unknown };
export type BoardOps = { upserts?: unknown[]; deletes?: unknown[] };

export const ELEMENT_TYPES = ["rect", "ellipse", "diamond", "triangle", "sticky", "text", "frame", "line", "arrow", "pen", "image", "comment"] as const;
const MAX_ELEMENTS = 5000;
const MAX_BOARD_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_CHARS = 900_000;

export class BoardError extends Error {}

const NUMBERS = ["x", "y", "w", "h", "z", "sw", "fontSize", "opacity", "radius", "x1", "y1", "x2", "y2", "bw", "bh", "ax", "ay"];
const SHORT_STRINGS = ["fill", "stroke", "color", "align", "valign", "from", "to", "attach", "by", "author"];
const FLAGS = ["dash", "hl", "resolved", "bold"];

/** Keep only the fields a board element may have, with sane types and sizes. Null when it is not an element. */
export function cleanElement(raw: unknown): BoardElement | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  const id = typeof input.id === "string" ? input.id.slice(0, 64) : "";
  const type = String(input.type ?? "");
  if (!id || !(ELEMENT_TYPES as readonly string[]).includes(type)) return null;
  const out: BoardElement = { id, type };
  for (const key of NUMBERS) {
    const value = input[key];
    if (typeof value === "number" && Number.isFinite(value)) out[key] = Math.round(value * 100) / 100;
  }
  for (const key of SHORT_STRINGS) {
    const value = input[key];
    if (typeof value === "string" && value) out[key] = value.slice(0, 64);
  }
  for (const key of FLAGS) if (input[key] === true) out[key] = true;
  if (typeof input.text === "string") out.text = input.text.slice(0, 8000);
  if (Array.isArray(input.pts)) {
    out.pts = input.pts.slice(0, 20000).map((n) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 10) / 10 : 0));
  }
  if (typeof input.src === "string" && input.src.length <= MAX_IMAGE_CHARS && /^(data:image\/(png|jpeg|webp|gif);base64,|https:\/\/)/.test(input.src)) out.src = input.src;
  if (type === "image" && !out.src) return null;
  if (Array.isArray(input.thread)) {
    out.thread = input.thread.slice(0, 200).flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const e = entry as Record<string, unknown>;
      const text = typeof e.text === "string" ? e.text.slice(0, 4000) : "";
      if (!text) return [];
      return [{ id: String(e.id ?? crypto.randomUUID()).slice(0, 64), author: String(e.author ?? "Someone").slice(0, 80), text, at: typeof e.at === "number" ? e.at : Date.now() }];
    });
  }
  return out;
}

export function readElements(board: Pick<Board, "elements">): BoardElement[] {
  try {
    const parsed = JSON.parse(board.elements);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export const listBoards = async (projectId: string) =>
  (await db.select().from(whiteboards).where(eq(whiteboards.projectId, projectId)).orderBy(desc(whiteboards.updatedAt)))
    .map((b) => ({ id: b.id, title: b.title, projectId: b.projectId, userId: b.userId, updatedAt: b.updatedAt, createdAt: b.createdAt, elementCount: readElements(b).length }));

export async function createBoard(userId: string, projectId: string, title?: string): Promise<Board> {
  const [board] = await db.insert(whiteboards).values({ userId, projectId, title: cleanTitle(title) }).returning();
  return board!;
}

export const getBoard = async (id: string): Promise<Board | null> =>
  (await db.select().from(whiteboards).where(eq(whiteboards.id, id)).limit(1))[0] ?? null;

const cleanTitle = (title: unknown) => String(title ?? "").trim().slice(0, 120) || "Untitled board";

export async function renameBoard(id: string, title: string): Promise<string> {
  const clean = cleanTitle(title);
  await db.update(whiteboards).set({ title: clean, updatedAt: new Date() }).where(eq(whiteboards.id, id));
  return clean;
}

export type ShareMode = "view" | "edit";
export const shareModeOf = (board: Pick<Board, "shareMode" | "shareToken">): ShareMode | null =>
  board.shareToken && (board.shareMode === "view" || board.shareMode === "edit") ? board.shareMode : null;

/**
 * Open the board to anyone holding its link (to view, or to edit), or close it again.
 * Closing throws the link away, so a link that was turned off never works again, even if sharing is turned back on.
 */
export async function setShare(id: string, mode: ShareMode | null): Promise<{ mode: ShareMode | null; token: string | null }> {
  const board = await getBoard(id);
  if (!board) throw new BoardError("Board not found");
  const token = mode ? board.shareToken ?? Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url") : null;
  await db.update(whiteboards).set({ shareToken: token, shareMode: mode }).where(eq(whiteboards.id, id));
  return { mode, token };
}

/** The board a link opens, or null when the link is unknown or was turned off. */
export async function boardByShareToken(token: string): Promise<Board | null> {
  if (!token || token.length < 16) return null;
  const [board] = await db.select().from(whiteboards).where(eq(whiteboards.shareToken, token)).limit(1);
  return board && shareModeOf(board) ? board : null;
}

export const deleteBoard = async (id: string) => { await db.delete(whiteboards).where(eq(whiteboards.id, id)); };

// One change at a time per board: each merge reads the stored board, so two at once would lose one.
const queues = new Map<string, Promise<unknown>>();
function inTurn<T>(boardId: string, run: () => Promise<T>): Promise<T> {
  const next = (queues.get(boardId) ?? Promise.resolve()).then(run, run);
  const settled = next.catch(() => {});
  queues.set(boardId, settled);
  void settled.then(() => { if (queues.get(boardId) === settled) queues.delete(boardId); });
  return next;
}

export interface BoardChange { boardId: string; version: number; changed: BoardElement[]; deleted: string[]; origin?: string | null }
const changeListeners = new Set<(change: BoardChange) => void>();
/** Hear about every saved change to any board (used to tell the other open browsers at once). */
export function onBoardChange(listener: (change: BoardChange) => void): void { changeListeners.add(listener); }

/** Merge changed and removed elements into the board. Returns the new version and the stored form of what changed. */
export function applyOps(boardId: string, ops: BoardOps, stamp: { by?: string; /** The live connection that made the change, so it is not told about its own work. */ origin?: string | null } = {}): Promise<{ version: number; changed: BoardElement[]; deleted: string[] }> {
  return inTurn(boardId, async () => {
    const board = await getBoard(boardId);
    if (!board) throw new BoardError("Board not found");
    const upserts = (Array.isArray(ops.upserts) ? ops.upserts : []).map(cleanElement).filter((e): e is BoardElement => !!e);
    const deletes = new Set((Array.isArray(ops.deletes) ? ops.deletes : []).filter((id): id is string => typeof id === "string"));
    if (!upserts.length && !deletes.size) return { version: board.version, changed: [], deleted: [] };

    const version = board.version + 1;
    const byId = new Map(readElements(board).map((e) => [e.id, e]));
    const deleted: string[] = [];
    for (const id of deletes) if (byId.delete(id)) deleted.push(id);
    for (const element of upserts) {
      if (deletes.has(element.id)) continue;
      const previous = byId.get(element.id);
      // Who made an element is decided by the server, never by the browser.
      const by = stamp.by ?? (previous?.by as string | undefined);
      if (by) element.by = by; else delete element.by;
      element.v = version;
      byId.set(element.id, element);
    }
    if (byId.size > MAX_ELEMENTS) throw new BoardError(`A board can hold up to ${MAX_ELEMENTS} elements.`);
    // Comments and connectors that pointed at something now gone lose the link, not the element.
    for (const element of byId.values()) {
      for (const key of ["from", "to", "attach"]) {
        if (typeof element[key] === "string" && !byId.has(element[key] as string)) { delete element[key]; element.v = version; }
      }
    }
    const json = JSON.stringify([...byId.values()]);
    if (json.length > MAX_BOARD_BYTES) throw new BoardError("This board is full. Remove some images to keep adding to it.");
    await db.update(whiteboards).set({ elements: json, version, updatedAt: new Date() }).where(eq(whiteboards.id, boardId));
    const changed = [...byId.values()].filter((e) => e.v === version);
    for (const listener of changeListeners) { try { listener({ boardId, version, changed, deleted, origin: stamp.origin }); } catch (error) { console.error("[whiteboard] change listener failed:", (error as Error).message); } }
    return { version, changed, deleted };
  });
}

/** Everything a browser at version `since` is missing: changed elements, and the ids still on the board. */
export function changesSince(board: Board, since: number) {
  const elements = readElements(board);
  if (since >= board.version) return { version: board.version, elements: [], ids: null as string[] | null };
  return { version: board.version, elements: elements.filter((e) => (e.v ?? 0) > since), ids: elements.map((e) => e.id) };
}

export const listMessages = async (boardId: string, limit = 60) =>
  (await db.select().from(whiteboardMessages).where(eq(whiteboardMessages.boardId, boardId)).orderBy(desc(whiteboardMessages.seq)).limit(limit)).reverse();

export function addMessage(boardId: string, role: "user" | "assistant", content: string, userId?: string | null) {
  return inTurn(boardId, async () => {
    const [{ next } = { next: 1 }] = await db.select({ next: sql<number>`coalesce(max(${whiteboardMessages.seq}), 0) + 1` })
      .from(whiteboardMessages).where(eq(whiteboardMessages.boardId, boardId));
    const [row] = await db.insert(whiteboardMessages).values({ boardId, seq: Number(next), role, content: content.slice(0, 20000), userId: userId ?? null }).returning();
    return row!;
  });
}

export const clearMessages = async (boardId: string) => { await db.delete(whiteboardMessages).where(eq(whiteboardMessages.boardId, boardId)); };
