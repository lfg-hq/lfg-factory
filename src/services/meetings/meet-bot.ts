/**
 * Runs the meeting bot: a Chromium in the sandbox backend (Mags, or Docker when self-hosted)
 * driven by scripts/meeting-bot-worker.mjs, one worker process per call. This file is the
 * only place that knows how the bot gets into a call; the meeting agent sees events and
 * three verbs (say in chat, look at the screen, leave).
 *
 * The worker lives in this server process's memory, so a server restart ends the bot's
 * part in any call that was running.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { startBrowserSession, stopWorkspace } from "../mags.ts";

export type MeetingStatus = "joining" | "waiting_room" | "in_call" | "ended" | "failed";

export interface BotHandlers {
  onSaid(event: { kind: "speech" | "chat"; speaker: string; text: string }): void;
  onStatus(status: MeetingStatus, detail: string | null): void;
}

interface Bot { child: ChildProcessWithoutNullStreams; sessionId: string; shots: Map<string, (shot: Screenshot | null) => void> }
export interface Screenshot { jpeg: Buffer; presenting: boolean }

const bots = new Map<string, Bot>();
const STATUSES = new Set(["joining", "waiting_room", "in_call", "ended", "failed"]);

export const botRunning = (botId: string) => bots.has(botId);

export async function startBot(opts: { meetingUrl: string; botName: string; greeting: string }, handlers: BotHandlers): Promise<{ id: string }> {
  const session = await startBrowserSession({ timeout: 120_000 });
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn("node", [`${process.cwd()}/scripts/meeting-bot-worker.mjs`], { stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    await stopWorkspace(session.requestId).catch(() => {});
    throw error;
  }
  const bot: Bot = { child, sessionId: session.requestId, shots: new Map() };
  bots.set(session.requestId, bot);

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
      } else if (message.type === "screenshot") {
        bot.shots.get(message.id)?.(message.jpegBase64 ? { jpeg: Buffer.from(message.jpegBase64, "base64"), presenting: !!message.presenting } : null);
        bot.shots.delete(message.id);
      } else if (message.type === "log") {
        console.log(`[meeting-bot ${session.requestId}] ${message.message}`);
      }
    }
  });
  child.stderr.on("data", (data: Buffer) => console.warn(`[meeting-bot ${session.requestId}] ${data.toString().trim().slice(0, 400)}`));
  child.stdin.on("error", () => {});
  child.on("error", (error) => console.error("[meeting-bot] worker could not start:", error.message));
  child.on("exit", () => {
    bots.delete(session.requestId);
    for (const resolve of bot.shots.values()) resolve(null);
    if (!finished) handlers.onStatus("ended", "The bot stopped unexpectedly.");
    void stopWorkspace(session.requestId).catch(() => {});
  });

  child.stdin.write(JSON.stringify({ wsEndpoint: session.wsEndpoint, ...opts }) + "\n");
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
