/**
 * Meeting bots (LFG admins only): the seats the meeting bot joins calls from, and signing
 * each one in to the bot's Google account.
 *
 * The seat's browser screen is relayed through LFG: the noVNC page and files come from
 * GET /admin/meeting-bots/:id/screen/*, its websocket from /ws/meeting-bot-screen (in
 * index.ts). Both need an admin's LFG session and an open sign-in that admin started; the
 * Mags URL behind them holds the browser's secret and never leaves this server.
 */
import { Hono, type Context } from "hono";
import { requireAuth } from "../auth/middleware.ts";
import { env } from "../config/env.ts";
import type { auth } from "../auth/index.ts";
import { addSeat, listSeats, removeSeat, seatBusy, seatById, setSeatState, type Seat } from "../services/meetings/bot-seats.ts";
import { SignInError, cancelSignIn, finishSignIn, signInFor, signInScreen, startSignIn } from "../services/meetings/meet-bot.ts";
import { deleteWorkspace } from "../services/sandbox/mags-backend.ts";

type AuthEnv = { Variables: { user: typeof auth.$Infer.Session.user; session: typeof auth.$Infer.Session.session } };
const router = new Hono<AuthEnv>();

export function isLfgAdmin(user: { email: string; emailVerified: boolean } | null | undefined): boolean {
  if (!user?.emailVerified) return false;
  const admins = `${env.ADMIN_EMAILS},${env.VENTURE_ADMIN_EMAILS}`.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return admins.includes(user.email.toLowerCase());
}

// Writes must come from LFG's own pages.
const sameOrigin = (request: Request) =>
  request.headers.get("origin") === new URL(env.BETTER_AUTH_URL).origin && request.headers.get("sec-fetch-site") !== "cross-site";

const admin = (c: Context<AuthEnv>) => isLfgAdmin(c.get("user"));
const notFound = (c: Context<AuthEnv>) => c.json({ error: "Not found" }, 404);

const view = (seat: Seat, me: string) => {
  const signIn = signInFor(seat.id);
  const heldForSignIn = seatBusy(seat) && !!seat.holder?.startsWith("sign-in:");
  return {
    id: seat.id, account: seat.account, state: seat.state, lastError: seat.lastError,
    lastUsedAt: seat.lastUsedAt, createdAt: seat.createdAt,
    inCall: seatBusy(seat) && !heldForSignIn,
    // A sign-in open on another LFG server shows as someone else's.
    signingIn: signIn ? { byMe: signIn.userId === me } : heldForSignIn ? { byMe: false } : null,
  };
};

router.use("/admin/meeting-bots", requireAuth);
router.use("/admin/meeting-bots/*", requireAuth);
router.use("/api/admin/meeting-bots", requireAuth);
router.use("/api/admin/meeting-bots/*", requireAuth);

router.get("/admin/meeting-bots", async (c) => {
  if (!admin(c)) return c.notFound();
  const { MeetingBotsPage } = await import("../templates/pages/meeting-bots.tsx");
  return c.html(MeetingBotsPage({ user: { name: c.get("user").name, email: c.get("user").email }, defaultAccount: env.MEETING_BOT_ACCOUNT }));
});

router.get("/api/admin/meeting-bots", async (c) => {
  if (!admin(c)) return notFound(c);
  const me = c.get("user").id;
  return c.json({ seats: (await listSeats()).map((seat) => view(seat, me)) });
});

router.post("/api/admin/meeting-bots", async (c) => {
  if (!admin(c) || !sameOrigin(c.req.raw)) return notFound(c);
  const body = await c.req.json<{ account?: string }>().catch(() => ({} as { account?: string }));
  const account = String(body.account ?? "").trim();
  if (account && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account)) return c.json({ error: "That isn't an email address." }, 400);
  const seat = await addSeat(account.toLowerCase());
  return c.json({ seat: { id: seat.id } });
});

async function seatAction(c: Context<AuthEnv>, run: (seat: Seat) => Promise<Response>): Promise<Response> {
  if (!admin(c) || !sameOrigin(c.req.raw)) return notFound(c);
  const seat = await seatById(c.req.param("id")!);
  if (!seat) return notFound(c);
  try {
    return await run(seat);
  } catch (error) {
    if (error instanceof SignInError) return c.json({ error: error.message }, 409);
    console.error("[meeting-bots] action failed:", (error as Error).message);
    return c.json({ error: "That didn't work. Try again in a moment." }, 500);
  }
}

router.post("/api/admin/meeting-bots/:id/sign-in", (c) => seatAction(c, async (seat) => {
  await startSignIn(seat.id, c.get("user").id);
  return c.json({ ok: true });
}));

router.post("/api/admin/meeting-bots/:id/finish", (c) => seatAction(c, async (seat) => {
  const signIn = signInFor(seat.id);
  if (signIn && signIn.userId !== c.get("user").id) return c.json({ error: "Another admin is signing this seat in." }, 409);
  return c.json(await finishSignIn(seat.id));
}));

router.post("/api/admin/meeting-bots/:id/cancel", (c) => seatAction(c, async (seat) => {
  await cancelSignIn(seat.id);
  return c.json({ ok: true });
}));

router.post("/api/admin/meeting-bots/:id/state", (c) => seatAction(c, async (seat) => {
  const body = await c.req.json<{ state?: string }>().catch(() => ({} as { state?: string }));
  if (body.state !== "ready" && body.state !== "disabled") return c.json({ error: "Unknown state." }, 400);
  if (body.state === "ready" && !seat.account) return c.json({ error: "Sign this seat in first." }, 409);
  await setSeatState(seat.id, body.state);
  return c.json({ ok: true });
}));

router.delete("/api/admin/meeting-bots/:id", (c) => seatAction(c, async (seat) => {
  if (signInFor(seat.id)) await cancelSignIn(seat.id);
  const removed = await removeSeat(seat.id);
  if (!removed) return c.json({ error: "This seat is in a call. Remove it when the call ends." }, 409);
  // The workspace holds the Google sign-in; deleting it is what actually signs the seat out.
  await deleteWorkspace(removed.workspace).catch((error) => console.warn("[meeting-bots] could not delete the seat's workspace:", (error as Error).message));
  return c.json({ ok: true });
}));

// The seat's screen while it is being signed in: noVNC's page and files, fetched by LFG.
router.get("/admin/meeting-bots/:id/screen/*", async (c) => {
  if (!admin(c)) return c.notFound();
  const id = c.req.param("id");
  const screen = signInScreen(id, c.get("user").id);
  if (!screen) return c.text("This seat's browser is not open for you to sign in.", 404);
  const prefix = `/admin/meeting-bots/${id}/screen/`;
  const path = new URL(c.req.url).pathname.slice(prefix.length);
  if (path.includes("..")) return c.notFound();
  const query = new URL(c.req.url).search;
  // The page itself is opened with our websocket's path; noVNC's own query is not forwarded.
  const upstream = await fetch(screen.httpBase + path + (path === "vnc.html" ? "" : query), { signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!upstream || !upstream.ok) return c.text("The seat's screen is not available.", 502);
  const headers = new Headers({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
  const type = upstream.headers.get("content-type");
  if (type) headers.set("Content-Type", type);
  return new Response(upstream.body, { status: 200, headers });
});

export default router;
