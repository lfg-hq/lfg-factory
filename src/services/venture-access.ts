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
  if (!session) return { session: null, eligible: false, isAdmin: false };
  const [google] = await db.select({ accountId: accounts.accountId }).from(accounts).where(and(
    eq(accounts.userId, session.user.id), eq(accounts.providerId, "google"),
  )).limit(1);
  return { session, eligible: Boolean(google?.accountId.trim()), isAdmin: isVentureAdmin(session.user) };
}

export function isVentureAdmin(user: { email: string; emailVerified: boolean }) {
  const admins = env.VENTURE_ADMIN_EMAILS.split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
  return user.emailVerified && admins.includes(user.email.toLowerCase());
}

// Owners read and write; LFG admins read any venture to review it.
export async function viewableVentureConversation(id: string, userId: string, isAdmin: boolean) {
  if (!isAdmin) return ownedVentureConversation(id, userId);
  const [conversation] = await db.select().from(ventureConversations).where(eq(ventureConversations.id, id)).limit(1);
  return conversation ?? null;
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
