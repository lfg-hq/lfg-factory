/**
 * Live whiteboards: everyone with a board open is connected to it by a WebSocket, so they see
 * each other's cursors, selections and changes as they happen.
 *
 * Saved changes still go through applyOps (over HTTP, or from the agent); this module hears
 * about every one of them and tells the other browsers at once. What a person is in the middle
 * of (dragging, resizing, drawing a stroke) is relayed as "live" elements that are never
 * stored: the stored board only changes when they let go.
 *
 * A connection is anything with send() and close(), so the same code serves the real server
 * and tests.
 */
import { cleanElement, onBoardChange, type BoardElement } from "./store.ts";

export interface BoardSocket { send(text: string): unknown; close(code?: number, reason?: string): unknown }
export interface PeerInfo { boardId: string; name: string; canEdit: boolean; guest: boolean }
export interface Peer extends PeerInfo { id: string; color: string; socket: BoardSocket }

const COLORS = ["#f43f5e", "#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16", "#f97316", "#14b8a6"];
const rooms = new Map<string, Map<string, Peer>>();
/** Close code telling a browser its access changed and it should load the page again. */
export const ACCESS_CHANGED = 4001;

const cleanName = (name: unknown) => String(name ?? "").replace(/\s+/g, " ").trim().slice(0, 40) || "Guest";
const view = (peer: Peer) => ({ id: peer.id, name: peer.name, color: peer.color, guest: peer.guest });
function send(peer: Peer, message: unknown) { try { peer.socket.send(JSON.stringify(message)); } catch { /* the socket is closing; its close handler tidies up */ } }

/** Tell everyone on a board something, optionally leaving one connection out (the one that caused it). */
export function broadcast(boardId: string, message: unknown, exceptId?: string | null, only: { membersOnly?: boolean } = {}): void {
  const room = rooms.get(boardId);
  if (!room) return;
  const text = JSON.stringify(message);
  for (const peer of room.values()) {
    if (peer.id === exceptId || (only.membersOnly && peer.guest)) continue;
    try { peer.socket.send(text); } catch { /* closing */ }
  }
}

export function joinBoard(socket: BoardSocket, info: PeerInfo): Peer {
  let room = rooms.get(info.boardId);
  if (!room) rooms.set(info.boardId, (room = new Map()));
  // The first colour nobody in the room is using, so neighbours are easy to tell apart.
  const taken = new Set([...room.values()].map((p) => p.color));
  const color = COLORS.find((c) => !taken.has(c)) ?? COLORS[room.size % COLORS.length]!;
  const peer: Peer = { ...info, name: cleanName(info.name), id: crypto.randomUUID().slice(0, 8), color, socket };
  send(peer, { t: "welcome", id: peer.id, color, peers: [...room.values()].map(view) });
  room.set(peer.id, peer);
  broadcast(peer.boardId, { t: "join", peer: view(peer) }, peer.id);
  return peer;
}

export function leaveBoard(peer: Peer): void {
  const room = rooms.get(peer.boardId);
  if (!room?.delete(peer.id)) return;
  if (!room.size) rooms.delete(peer.boardId);
  broadcast(peer.boardId, { t: "leave", id: peer.id });
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Something a browser sent. Nothing here is stored: it is checked and passed on to the others. */
export function boardMessage(peer: Peer, raw: string | Buffer): void {
  if (!rooms.get(peer.boardId)?.has(peer.id)) return;
  let message: Record<string, unknown>;
  try { message = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")); } catch { return; }
  if (!message || typeof message !== "object") return;
  switch (message.t) {
    case "ping": send(peer, { t: "pong" }); return;
    case "cursor":
      if (message.gone) broadcast(peer.boardId, { t: "cursor", id: peer.id, gone: true }, peer.id);
      else if (finite(message.x) && finite(message.y)) broadcast(peer.boardId, { t: "cursor", id: peer.id, x: Math.round(message.x), y: Math.round(message.y) }, peer.id);
      return;
    case "select": {
      const ids = (Array.isArray(message.ids) ? message.ids : []).filter((id): id is string => typeof id === "string").slice(0, 200).map((id) => id.slice(0, 64));
      broadcast(peer.boardId, { t: "select", id: peer.id, ids }, peer.id);
      return;
    }
    case "live": {
      // Work in progress: only from people who may edit, and cleaned like anything else they send.
      if (!peer.canEdit) return;
      const els = (Array.isArray(message.els) ? message.els.slice(0, 80) : []).map(cleanElement).filter((e): e is BoardElement => !!e);
      const gone = (Array.isArray(message.gone) ? message.gone : []).filter((id): id is string => typeof id === "string").slice(0, 80);
      if (els.length || gone.length) broadcast(peer.boardId, { t: "live", id: peer.id, els, gone }, peer.id);
      return;
    }
    case "name":
      // Members are shown under their account name; only a guest chooses theirs.
      if (!peer.guest) return;
      peer.name = cleanName(message.name);
      broadcast(peer.boardId, { t: "name", id: peer.id, name: peer.name }, peer.id);
      return;
  }
}

/** The board's link was turned off or changed: everyone who came in by it is sent back to load the page again. */
export function closeGuests(boardId: string): void {
  for (const peer of [...(rooms.get(boardId)?.values() ?? [])]) {
    if (!peer.guest) continue;
    try { peer.socket.close(ACCESS_CHANGED, "access changed"); } catch { /* already gone */ }
    leaveBoard(peer);
  }
}

export const peersOn = (boardId: string) => [...(rooms.get(boardId)?.values() ?? [])].map(view);

// Every saved change, whoever made it (a browser, a guest, the agent), reaches the other browsers at once.
onBoardChange((change) => {
  broadcast(change.boardId, { t: "ops", upserts: change.changed, deletes: change.deleted, version: change.version, by: change.origin ?? null }, change.origin);
});

/** Glue for Bun's WebSocket handlers: the connection's details ride on ws.data.board. */
type Carrier = BoardSocket & { data: { board?: PeerInfo & { peer?: Peer } } };
export const boardSockets = {
  open(ws: Carrier) { const info = ws.data.board!; info.peer = joinBoard(ws, info); },
  message(ws: Carrier, data: string | Buffer) { const peer = ws.data.board?.peer; if (peer) boardMessage(peer, data); },
  close(ws: Carrier) { const peer = ws.data.board?.peer; if (peer) leaveBoard(peer); },
};
