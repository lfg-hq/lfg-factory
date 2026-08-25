/**
 * Board connections: a user's OAuth grant to Jira or Linear, and the client built from it.
 *
 * Linear access tokens don't expire, so there's nothing to refresh — a revoked grant
 * shows up as a 401. Jira's expire in about an hour and come with a ROTATING refresh
 * token, so every refresh must persist the new one or the next refresh fails.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../../config/db.ts";
import { env } from "../../config/env.ts";
import { boardConnections } from "../../db/schema/boards.ts";
import type { BoardClient, BoardProvider } from "./types.ts";
import { LinearClient } from "./linear.ts";
import { JiraClient } from "./jira.ts";

export type BoardConnection = typeof boardConnections.$inferSelect;

export function providerConfigured(provider: BoardProvider): boolean {
  return provider === "linear"
    ? !!(env.LINEAR_CLIENT_ID && env.LINEAR_CLIENT_SECRET)
    : !!(env.JIRA_CLIENT_ID && env.JIRA_CLIENT_SECRET);
}

export async function getConnection(userId: string, provider: BoardProvider): Promise<BoardConnection | null> {
  const [row] = await db.select().from(boardConnections)
    .where(and(eq(boardConnections.userId, userId), eq(boardConnections.provider, provider)))
    .limit(1);
  return row ?? null;
}

export async function listConnections(userId: string): Promise<BoardConnection[]> {
  return db.select().from(boardConnections).where(eq(boardConnections.userId, userId));
}

export async function deleteConnection(userId: string, provider: BoardProvider): Promise<void> {
  await db.delete(boardConnections)
    .where(and(eq(boardConnections.userId, userId), eq(boardConnections.provider, provider)));
}

/** Refresh a Jira token that's expired or about to. Returns the usable access token. */
async function freshJiraToken(conn: BoardConnection): Promise<string> {
  const expMs = conn.tokenExpiresAt ? new Date(conn.tokenExpiresAt as unknown as string).getTime() : 0;
  if (expMs && expMs - Date.now() > 120_000) return conn.accessToken;
  if (!conn.refreshToken || !env.JIRA_CLIENT_ID || !env.JIRA_CLIENT_SECRET) return conn.accessToken;

  const r = await fetch("https://auth.atlassian.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: env.JIRA_CLIENT_ID,
      client_secret: env.JIRA_CLIENT_SECRET,
      refresh_token: conn.refreshToken,
    }),
  });
  const data = (await r.json().catch(() => ({}))) as {
    access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string;
  };
  if (!r.ok || !data.access_token) {
    throw new Error(`Jira session expired and could not be refreshed (${data.error_description ?? data.error ?? `HTTP ${r.status}`}). Reconnect Jira in Settings → Integrations.`);
  }
  await db.update(boardConnections).set({
    accessToken: data.access_token,
    // Atlassian ROTATES the refresh token: keeping the old one breaks the next refresh.
    refreshToken: data.refresh_token ?? conn.refreshToken,
    tokenExpiresAt: new Date(Date.now() + (data.expires_in ?? 3600) * 1000),
    updatedAt: new Date(),
  }).where(eq(boardConnections.id, conn.id));
  return data.access_token;
}

/** A ready-to-use client for a connection, refreshing credentials when needed. */
export async function clientFor(conn: BoardConnection): Promise<BoardClient> {
  if (conn.provider === "linear") return new LinearClient(conn.accessToken);
  if (!conn.cloudId || !conn.siteUrl) {
    throw new Error("This Jira connection is missing its site — reconnect Jira in Settings → Integrations.");
  }
  const token = await freshJiraToken(conn);
  return new JiraClient(token, conn.cloudId, conn.siteUrl);
}

/** Client for a user+provider, or null when they haven't connected it. */
export async function clientForUser(userId: string, provider: BoardProvider): Promise<BoardClient | null> {
  const conn = await getConnection(userId, provider);
  return conn ? clientFor(conn) : null;
}
