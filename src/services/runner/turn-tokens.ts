/**
 * Per-turn credentials for the LFG MCP endpoint (src/routes/mcp-server.ts).
 *
 * When a chat turn runs on someone's computer, their agent gets a URL for that turn and
 * a random bearer token. The token is bound to one person, project and conversation,
 * expires on its own, and is revoked when the turn ends. Only a SHA-256 of it is stored
 * (in Better Auth's verification table, like the desktop sign-in codes).
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { auth } from "../../auth/index.ts";

export interface TurnGrant {
  userId: string;
  conversationId: string;
  /** Internal project id (projects.id), or null for a chat without a project. */
  projectId: string | null;
  /** The user message this turn answers (lets createTickets tie tickets to it). */
  messageId?: string;
}

const PREFIX = "lfg-turn:";
const sha256 = (v: string) => createHash("sha256").update(v).digest();

export async function mintTurnToken(grant: TurnGrant, ttlMs = 2 * 60 * 60_000): Promise<{ turnId: string; token: string }> {
  const turnId = randomBytes(12).toString("base64url");
  const token = randomBytes(32).toString("base64url");
  const ctx = await auth.$context;
  await ctx.internalAdapter.createVerificationValue({
    identifier: PREFIX + turnId,
    value: JSON.stringify({ hash: sha256(token).toString("base64url"), ...grant }),
    expiresAt: new Date(Date.now() + ttlMs),
  });
  return { turnId, token };
}

/** The grant for this turn if the token is right and still valid; otherwise null. */
export async function verifyTurnToken(turnId: string, token: string | null | undefined): Promise<TurnGrant | null> {
  if (!token || !/^[A-Za-z0-9_-]{8,64}$/.test(turnId)) return null;
  const ctx = await auth.$context;
  const row = await ctx.internalAdapter.findVerificationValue(PREFIX + turnId);
  if (!row || row.expiresAt < new Date()) return null;
  const { hash, ...grant } = JSON.parse(row.value) as TurnGrant & { hash: string };
  const expected = Buffer.from(hash, "base64url");
  const actual = sha256(token);
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? grant : null;
}

export async function revokeTurnToken(turnId: string): Promise<void> {
  const ctx = await auth.$context;
  const row = await ctx.internalAdapter.findVerificationValue(PREFIX + turnId);
  if (row) await ctx.internalAdapter.deleteVerificationValue(row.id);
}
