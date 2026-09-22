/**
 * GitLab token helper.
 *
 * GitLab OAuth access tokens are short-lived (~2h) and come with a rotating
 * refresh token. This returns a currently-valid access token for a user,
 * transparently refreshing (and persisting the rotated refresh token) when the
 * stored one is expired or about to expire. Returns null if there's no token or
 * the refresh fails (caller should prompt the user to reconnect GitLab).
 */
import { eq } from "drizzle-orm";
import { db } from "../config/db.ts";
import { gitlabTokens } from "../db/schema/users.ts";
import { env } from "../config/env.ts";

const GITLAB_BASE = (env.GITLAB_BASE_URL || "https://gitlab.com").replace(/\/$/, "");

const refreshes = new Map<string, Promise<string | null>>();
export async function getValidGitlabToken(userId: string, rejectedToken?: string): Promise<string | null> {
  const active=refreshes.get(userId);if(active)return active;
  const pending=resolveToken(userId,rejectedToken);refreshes.set(userId,pending);
  try{return await pending;}finally{if(refreshes.get(userId)===pending)refreshes.delete(userId);}
}
async function resolveToken(userId: string, rejectedToken?: string): Promise<string | null> {
  const [row] = await db.select().from(gitlabTokens).where(eq(gitlabTokens.userId, userId));
  if (!row?.accessToken) return null;

  const expMs = row.tokenExpiresAt ? new Date(row.tokenExpiresAt as unknown as string).getTime() : 0;

  // No expiry recorded (older/long-lived token) → use as-is.
  if (!expMs && !rejectedToken) return row.accessToken;
  // Still valid for >60s → use as-is.
  if (expMs - Date.now() > 60_000 && row.accessToken !== rejectedToken) return row.accessToken;

  // Expired / about to expire → refresh.
  if (!row.refreshToken || !env.GITLAB_CLIENT_ID || !env.GITLAB_CLIENT_SECRET) {
    return null; // Never knowingly reuse an expired or rejected credential.
  }

  try {
    const resp = await fetch(`${GITLAB_BASE}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        client_id: env.GITLAB_CLIENT_ID,
        client_secret: env.GITLAB_CLIENT_SECRET,
        refresh_token: row.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!resp.ok) {
      console.error(`[gitlab-token] refresh failed: HTTP ${resp.status}`);
      return null; // refresh token likely revoked → user must reconnect
    }
    const data = (await resp.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!data.access_token) return null;

    await db
      .update(gitlabTokens)
      .set({
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? row.refreshToken,
        tokenExpiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
        updatedAt: new Date(),
      })
      .where(eq(gitlabTokens.userId, userId));

    return data.access_token;
  } catch (err) {
    console.error("[gitlab-token] refresh error:", err);
    return null;
  }
}
