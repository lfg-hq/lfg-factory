/**
 * The meeting bot's seats: the browsers it joins calls from (see the meeting_bot_seat table).
 *
 * A seat is one Mags workspace with one Chrome profile, signed in once, by an admin, to one
 * Google account. A seat is in one call at a time, so the number of ready seats is how many
 * calls LFG can be in at once; one account can sit behind many seats. Claiming a seat is a
 * single conditional UPDATE, so any number of LFG server processes can share the pool, and
 * a claim is a lease the holder renews while it works: a seat whose holder died is free
 * again once its lease runs out.
 */
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../../config/db.ts";
import { meetingBotSeats } from "../../db/schema/meetings.ts";

export type Seat = typeof meetingBotSeats.$inferSelect;
export type SeatState = "ready" | "needs_sign_in" | "disabled";

/** How long a claim lasts without being renewed. Holders renew every third of this. */
export const SEAT_LEASE_MS = Number(process.env.MEETING_SEAT_LEASE_MS ?? 3 * 60_000);

const free = (now: Date) => or(isNull(meetingBotSeats.holder), lt(meetingBotSeats.leaseUntil, now));
const leaseEnd = () => new Date(Date.now() + SEAT_LEASE_MS);

/** True when a seat is held by someone whose lease has not run out. */
export const seatBusy = (seat: Seat, now = new Date()) => !!seat.holder && !!seat.leaseUntil && seat.leaseUntil > now;

/**
 * The first time the pool is used on a server that ran the bot before seats existed, its
 * one browser becomes the first seat, so calls keep working until an admin sets up more.
 */
export async function ensureFirstSeat(): Promise<void> {
  const [{ count } = { count: 0 }] = await db.select({ count: sql<number>`count(*)` }).from(meetingBotSeats);
  if (Number(count) > 0) return;
  await db.insert(meetingBotSeats)
    .values({ workspace: process.env.MEETING_BOT_WORKSPACE || "lfg-meeting-bot", state: "ready" })
    .onConflictDoNothing();
}

/** Claim the ready seat that has rested longest, or null when every ready seat is in a call. */
export async function claimReadySeat(holder: string): Promise<Seat | null> {
  for (let round = 0; round < 3; round++) {
    const now = new Date();
    const candidates = await db.select().from(meetingBotSeats)
      .where(and(eq(meetingBotSeats.state, "ready"), free(now)))
      .orderBy(asc(meetingBotSeats.lastUsedAt), asc(meetingBotSeats.createdAt)).limit(8);
    if (!candidates.length) return null;
    for (const candidate of candidates) {
      // Another server may claim the same seat between the read and this write; the
      // condition is checked again by the write itself, so only one of them gets it.
      const [taken] = await db.update(meetingBotSeats)
        .set({ holder, leaseUntil: leaseEnd(), lastUsedAt: now })
        .where(and(eq(meetingBotSeats.id, candidate.id), eq(meetingBotSeats.state, "ready"), free(now)))
        .returning();
      if (taken) return taken;
    }
  }
  return null;
}

/** Claim one particular seat whatever its state (to sign it in), or null when it is in use. */
export async function claimSeat(seatId: string, holder: string): Promise<Seat | null> {
  const now = new Date();
  const [taken] = await db.update(meetingBotSeats)
    .set({ holder, leaseUntil: leaseEnd() })
    .where(and(eq(meetingBotSeats.id, seatId), free(now)))
    .returning();
  return taken ?? null;
}

/** Extend a claim. False when the claim was lost (it ran out and someone else took the seat). */
export async function renewSeat(seatId: string, holder: string): Promise<boolean> {
  const rows = await db.update(meetingBotSeats).set({ leaseUntil: leaseEnd() })
    .where(and(eq(meetingBotSeats.id, seatId), eq(meetingBotSeats.holder, holder))).returning({ id: meetingBotSeats.id });
  return rows.length > 0;
}

export async function releaseSeat(seatId: string, holder: string): Promise<void> {
  await db.update(meetingBotSeats).set({ holder: null, leaseUntil: null })
    .where(and(eq(meetingBotSeats.id, seatId), eq(meetingBotSeats.holder, holder)));
}

/** Keep a claim alive until the returned function is called, which also releases it. */
export function holdSeat(seatId: string, holder: string): () => Promise<void> {
  const timer = setInterval(() => {
    void renewSeat(seatId, holder).then((kept) => {
      if (!kept) console.warn(`[meeting-seat] lost the claim on seat ${seatId}`);
    }).catch((error) => console.warn("[meeting-seat] renew failed:", (error as Error).message));
  }, Math.max(1000, Math.floor(SEAT_LEASE_MS / 3)));
  (timer as { unref?: () => void }).unref?.();
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    await releaseSeat(seatId, holder).catch((error) => console.warn("[meeting-seat] release failed:", (error as Error).message));
  };
}

/** Google signed this seat's browser out: keep it out of calls until an admin signs it in again. */
export async function markSignedOut(seatId: string, detail: string): Promise<void> {
  await db.update(meetingBotSeats).set({ state: "needs_sign_in", lastError: detail.slice(0, 300) }).where(eq(meetingBotSeats.id, seatId));
}

export async function markSignedIn(seatId: string, account: string): Promise<void> {
  await db.update(meetingBotSeats).set({ state: "ready", account: account.slice(0, 200), lastError: null }).where(eq(meetingBotSeats.id, seatId));
}

export async function setSeatState(seatId: string, state: SeatState): Promise<Seat | null> {
  const [row] = await db.update(meetingBotSeats).set({ state }).where(eq(meetingBotSeats.id, seatId)).returning();
  return row ?? null;
}

export async function addSeat(account: string): Promise<Seat> {
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const [row] = await db.insert(meetingBotSeats).values({ workspace: `lfg-meet-${suffix}`, account: account.trim().slice(0, 200) }).returning();
  return row!;
}

/** Remove a seat from the pool. Its Mags workspace (and the Google sign-in in it) is the caller's to delete. */
export async function removeSeat(seatId: string): Promise<Seat | null> {
  const [row] = await db.delete(meetingBotSeats).where(and(eq(meetingBotSeats.id, seatId), free(new Date()))).returning();
  return row ?? null;
}

export const seatById = async (seatId: string): Promise<Seat | null> =>
  (await db.select().from(meetingBotSeats).where(eq(meetingBotSeats.id, seatId)).limit(1))[0] ?? null;

export const listSeats = (): Promise<Seat[]> =>
  db.select().from(meetingBotSeats).orderBy(asc(meetingBotSeats.account), asc(meetingBotSeats.createdAt));

/** Why no seat could be claimed, in words for the person who asked LFG to join. */
export async function noSeatMessage(): Promise<string> {
  const seats = await listSeats();
  const ready = seats.filter((s) => s.state === "ready");
  if (!ready.length) return "LFG's meeting bot has no signed-in browser right now. An LFG admin needs to sign it in under Meeting bots.";
  return ready.length === 1
    ? "LFG's meeting bot is in another call right now. Try again when that call ends."
    : `All ${ready.length} of LFG's meeting bots are in calls right now. Try again in a few minutes.`;
}
