/**
 * Runs the meeting bot: Mags's meeting browser driven by scripts/meeting-bot-worker.mjs, one
 * worker process per call. This file is the only place that knows how the bot gets into a
 * call; the meeting agent sees events and a few verbs (say in chat, speak, look at the
 * screen, leave).
 *
 * Each call runs in a seat from the pool (bot-seats.ts): a browser signed in to the bot's
 * Google account, so LFG can be in as many calls at once as there are ready seats. Admins
 * sign seats in from the Meeting bots page; the browser's screen reaches them only through
 * LFG (see signInScreen), never as a Mags URL, because that URL controls the account.
 *
 * Workers live in this server process's memory, so a server restart ends the bot's part in
 * any call that was running; the seat frees itself when its lease runs out.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
// Straight to Mags, whatever SANDBOX_BACKEND is: the meeting browser (full Chrome, audio
// devices, a kept sign-in) is something only Mags provides, even when sandboxes run on Docker.
import { execOnWorkspace, startBrowserSession, stopWorkspace } from "../sandbox/mags-backend.ts";
import {
  claimReadySeat, claimSeat, ensureFirstSeat, holdSeat, markSignedIn, markSignedOut, noSeatMessage, seatById, type Seat,
} from "./bot-seats.ts";

export type MeetingStatus = "joining" | "waiting_room" | "in_call" | "ended" | "failed";

export interface BotHandlers {
  onSaid(event: { kind: "speech" | "chat"; speaker: string; text: string }): void;
  onStatus(status: MeetingStatus, detail: string | null): void;
}

interface Bot { child: ChildProcessWithoutNullStreams; sessionId: string; seatId: string; shots: Map<string, (shot: Screenshot | null) => void> }
export interface Screenshot { jpeg: Buffer; presenting: boolean }

const bots = new Map<string, Bot>();

/** No seat was free. The message says why, for the person who asked the bot to join. */
export class BotBusyError extends Error {}
const STATUSES = new Set(["joining", "waiting_room", "in_call", "ended", "failed"]);

export const botRunning = (botId: string) => bots.has(botId);

/** Mags serves the browser only under its session secret ("/t/<secret>"), not at the bare URL. */
const locked = (session: { cdpHttpUrl: string }) => /\/t\/[A-Za-z0-9_-]{32,}$/.test(session.cdpHttpUrl);

/** `holder` names the claim on the seat (the meeting's id). */
export async function startBot(opts: { meetingUrl: string; botName: string; greeting: string; holder?: string }, handlers: BotHandlers): Promise<{ id: string }> {
  const holder = opts.holder || `call:${crypto.randomUUID()}`;
  await ensureFirstSeat();
  const seat = await claimReadySeat(holder);
  if (!seat) throw new BotBusyError(await noSeatMessage());
  const release = holdSeat(seat.id, holder);

  let session: Awaited<ReturnType<typeof startBrowserSession>>;
  let child: ChildProcessWithoutNullStreams;
  try {
    session = await startBrowserSession({ timeout: 180_000, meet: true, name: seat.workspace });
  } catch (error) {
    await release();
    throw error;
  }
  if (seat.account && !locked(session)) {
    // A browser signed in to the bot's Google account must not be reachable by its URL alone.
    await stopWorkspace(session.requestId).catch(() => {});
    await release();
    console.error(`[meeting-bot ${seat.workspace}] refused: Mags served this signed-in browser without a session secret`);
    throw new Error("The meeting browser is not locked to a session secret");
  }
  try {
    child = spawn("node", [`${process.cwd()}/scripts/meeting-bot-worker.mjs`], { stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    await stopWorkspace(session.requestId).catch(() => {});
    await release();
    throw error;
  }
  const bot: Bot = { child, sessionId: session.requestId, seatId: seat.id, shots: new Map() };
  bots.set(session.requestId, bot);
  const tag = `[meeting-bot ${seat.workspace}]`;

  let finished = false;
  let buffer = "";
  child.stdout.on("data", (data: Buffer) => {
    buffer += data.toString();
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message: any;
      try { message = JSON.parse(line); } catch { continue; }
      if ((message.type === "speech" || message.type === "chat") && message.text) {
        handlers.onSaid({ kind: message.type, speaker: String(message.speaker || "Someone").slice(0, 80), text: String(message.text) });
      } else if (message.type === "status" && STATUSES.has(message.status)) {
        if (message.status === "ended" || message.status === "failed") finished = true;
        handlers.onStatus(message.status, message.detail ?? null);
      } else if (message.type === "account" && message.signedIn === false && seat.account) {
        // Google dropped the sign-in. This call goes on as a guest; later ones use other seats.
        console.warn(`${tag} Google signed ${seat.account} out of this seat; it needs signing in again`);
        void markSignedOut(seat.id, `Google signed ${seat.account} out of this browser; it joined a call as a guest. Sign it in again.`).catch(() => {});
      } else if (message.type === "screenshot") {
        bot.shots.get(message.id)?.(message.jpegBase64 ? { jpeg: Buffer.from(message.jpegBase64, "base64"), presenting: !!message.presenting } : null);
        bot.shots.delete(message.id);
      } else if (message.type === "log") {
        console.log(`${tag} ${message.message}`);
      }
    }
  });
  child.stderr.on("data", (data: Buffer) => console.warn(`${tag} ${data.toString().trim().slice(0, 400)}`));
  child.stdin.on("error", () => {});
  child.on("error", (error) => console.error("[meeting-bot] worker could not start:", error.message));
  child.on("exit", () => {
    bots.delete(session.requestId);
    for (const resolve of bot.shots.values()) resolve(null);
    if (!finished) handlers.onStatus("ended", "The bot stopped unexpectedly.");
    void stopWorkspace(session.requestId).catch(() => {}).finally(() => release());
  });

  child.stdin.write(JSON.stringify({ wsEndpoint: session.wsEndpoint, expectSignedIn: !!seat.account, ...opts }) + "\n");
  return { id: session.requestId };
}

const tell = (botId: string, command: object): boolean => {
  const bot = bots.get(botId);
  if (!bot) return false;
  bot.child.stdin.write(JSON.stringify(command) + "\n");
  return true;
};

export async function sendChat(botId: string, text: string): Promise<void> {
  if (!tell(botId, { cmd: "chat", text })) throw new Error("The bot is no longer in the call.");
}

/** Say a clip (mp3) aloud in the call. The bot unmutes for as long as the clip lasts. */
export async function speak(botId: string, mp3: ArrayBuffer): Promise<void> {
  if (!tell(botId, { cmd: "speak", mp3Base64: Buffer.from(mp3).toString("base64") })) throw new Error("The bot is no longer in the call.");
}

/** What the bot sees right now, and whether someone is presenting. Null when it can't be captured. */
export function screenshot(botId: string): Promise<Screenshot | null> {
  const bot = bots.get(botId);
  if (!bot) return Promise.resolve(null);
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { bot.shots.delete(id); resolve(null); }, 15_000);
    bot.shots.set(id, (shot) => { clearTimeout(timer); resolve(shot); });
    tell(botId, { cmd: "screenshot", id });
  });
}

/** Leave the call. The worker reports "ended" on its way out; if it hangs it is killed. */
export async function stopBot(botId: string): Promise<void> {
  const bot = bots.get(botId);
  if (!bot) return;
  tell(botId, { cmd: "leave" });
  const force = setTimeout(() => bot.child.kill("SIGKILL"), 15_000);
  bot.child.once("exit", () => clearTimeout(force));
}

// ── Signing a seat in ────────────────────────────────────────────────
// An admin opens a seat's browser, signs in to Google in it by hand (through LFG's relay of
// the browser's screen), then finishes: LFG reads which account is signed in, saves the
// profile to the seat's disk and stops the browser. A sign-in nobody finishes is cancelled.

interface SignIn { seatId: string; userId: string; requestId: string; cdpHttpUrl: string; wsEndpoint: string; release: () => Promise<void>; expiry: ReturnType<typeof setTimeout> }
const signIns = new Map<string, SignIn>();
const SIGN_IN_MAX_MS = 20 * 60_000;

export class SignInError extends Error {}

function runAccountScript(wsEndpoint: string, action: "open" | "whoami"): Promise<{ ok: boolean; email?: string | null; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [`${process.cwd()}/scripts/meeting-bot-account.mjs`], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => console.warn(`[meeting-seat] ${d.toString().trim().slice(0, 300)}`));
    child.on("error", (error) => { clearTimeout(timer); resolve({ ok: false, error: error.message }); });
    child.on("exit", () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out.trim().split("\n").pop() || "")); } catch { resolve({ ok: false, error: "the browser helper gave no answer" }); }
    });
    child.stdin.end(JSON.stringify({ wsEndpoint, action }));
  });
}

export const signInFor = (seatId: string): SignIn | null => signIns.get(seatId) ?? null;

/** Open a seat's browser on Google's sign-in page. The seat is out of the pool until finished or cancelled. */
export async function startSignIn(seatId: string, userId: string): Promise<void> {
  if (signIns.has(seatId)) return;
  const seat = await seatById(seatId);
  if (!seat) throw new SignInError("That seat no longer exists.");
  const holder = `sign-in:${userId}`;
  if (!(await claimSeat(seat.id, holder))) throw new SignInError("This seat is in a call right now. Sign it in when the call ends.");
  const release = holdSeat(seat.id, holder);
  try {
    const session = await startBrowserSession({ timeout: 180_000, meet: true, name: seat.workspace });
    if (!locked(session)) {
      // An unlocked Mags meeting browser is open to anyone holding its URL: refuse to put a
      // Google sign-in into one.
      await stopWorkspace(session.requestId).catch(() => {});
      throw new SignInError("This server's Mags meeting browser is not locked to a session secret, so it is not safe to sign a Google account in to it. Update Mags first.");
    }
    const opened = await runAccountScript(session.wsEndpoint, "open");
    if (!opened.ok) console.warn(`[meeting-seat] could not open the sign-in page: ${opened.error}`);
    const expiry = setTimeout(() => { void cancelSignIn(seatId).catch(() => {}); }, SIGN_IN_MAX_MS);
    (expiry as { unref?: () => void }).unref?.();
    signIns.set(seatId, { seatId, userId, requestId: session.requestId, cdpHttpUrl: session.cdpHttpUrl, wsEndpoint: session.wsEndpoint, release, expiry });
  } catch (error) {
    await release();
    throw error;
  }
}

/** Close a sign-in: save the Chrome profile to the seat's disk, stop the browser, free the seat. */
async function closeSignIn(s: SignIn): Promise<void> {
  signIns.delete(s.seatId);
  clearTimeout(s.expiry);
  // meet-session stop closes Chrome cleanly and syncs, so the new cookies are on disk.
  await execOnWorkspace(s.requestId, "meet-session stop", { timeout: 30_000, attempts: 1 }).catch((error) =>
    console.warn("[meeting-seat] could not save the profile cleanly:", (error as Error).message));
  await stopWorkspace(s.requestId).catch(() => {});
  await s.release();
}

/** Read which account the seat is signed in to and put it back in the pool. */
export async function finishSignIn(seatId: string): Promise<{ account: string }> {
  const s = signIns.get(seatId);
  if (!s) throw new SignInError("This seat's browser is not open. Start signing in again.");
  const who = await runAccountScript(s.wsEndpoint, "whoami");
  if (!who.ok) throw new SignInError(`Could not check the sign-in: ${who.error}`);
  if (!who.email) throw new SignInError("The browser is not signed in to Google yet. Finish signing in, then try again.");
  await markSignedIn(seatId, who.email);
  await closeSignIn(s);
  return { account: who.email };
}

export async function cancelSignIn(seatId: string): Promise<void> {
  const s = signIns.get(seatId);
  if (s) await closeSignIn(s);
}

/**
 * Where LFG fetches the seat's screen from while it is being signed in: the noVNC page and
 * its websocket, under the session's secret path. For LFG's relay only; never sent to a browser.
 */
export function signInScreen(seatId: string, userId: string): { httpBase: string; wsUrl: string } | null {
  const s = signIns.get(seatId);
  if (!s || s.userId !== userId) return null;
  return { httpBase: `${s.cdpHttpUrl}/vnc/`, wsUrl: `${s.cdpHttpUrl.replace(/^http/, "ws")}/vnc/websockify` };
}

export type { Seat };
