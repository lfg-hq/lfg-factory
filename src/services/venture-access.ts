import { and, eq } from "drizzle-orm";
import { auth } from "../auth/index.ts";
import { db } from "../config/db.ts";
import { env } from "../config/env.ts";
import { accounts } from "../db/schema/users.ts";
import { ventureConversations } from "../db/schema/venture.ts";

export const googleConfigured = () => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

// Always resolve the canonical session; never trust an email suffix or browser flag.
export async function getVentureAccess(headers: Headers) {
  const session = await auth.api.getSession({ headers, query: { disableCookieCache: true } });
  if (!session) return { session: null, eligible: false };
  const [google] = await db.select({ accountId: accounts.accountId }).from(accounts).where(and(
    eq(accounts.userId, session.user.id), eq(accounts.providerId, "google"),
  )).limit(1);
  return { session, eligible: Boolean(google?.accountId.trim()) };
}

export async function ownedVentureConversation(id: string, userId: string) {
  const [conversation] = await db.select().from(ventureConversations).where(and(
    eq(ventureConversations.id, id), eq(ventureConversations.userId, userId),
  )).limit(1);
  return conversation ?? null;
}

// Origin is mandatory for writes. The deployment's canonical public origin is
// authoritative, not a client-supplied Host or forwarded header.
export function isVentureSameOrigin(request: Request) {
  return request.headers.get("origin") === new URL(env.BETTER_AUTH_URL).origin
    && request.headers.get("sec-fetch-site") !== "cross-site";
}
