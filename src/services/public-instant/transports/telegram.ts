// ── Public Telegram Bot Transport ──────────────────────────────────────
// Telegram-specific: long-polling loop, Bot API calls, /start /new /status.
// Implements TransportCallbacks and feeds messages to the engine.

import { env } from "../../../config/env.ts";
import { handleIncomingMessage, resetSession, getSession } from "../engine.ts";
import type { TransportCallbacks } from "../types.ts";

const API_BASE = "https://api.telegram.org/bot";
const CHANNEL = "telegram";

let running = false;
let abortCtrl: AbortController | null = null;
let lastUpdateId = 0;

// ── Telegram API helpers ─────────────────────────────────────────────

async function tgApi(method: string, body?: object): Promise<any> {
  const token = env.TELEGRAM_PUBLIC_BOT_TOKEN;
  const res = await fetch(`${API_BASE}${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data: any = await res.json();
  if (!data.ok) {
    console.error(`[public-telegram] API error on ${method}:`, data.description);
  }
  return data;
}

async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  const MAX_LEN = 4000;
  let remaining = text;
  while (remaining.length > 0) {
    const chunk = remaining.slice(0, MAX_LEN);
    remaining = remaining.slice(MAX_LEN);
    await tgApi("sendMessage", { chat_id: chatId, text: chunk, parse_mode: "Markdown" });
  }
}

async function sendTypingAction(chatId: string): Promise<void> {
  await tgApi("sendChatAction", { chat_id: chatId, action: "typing" });
}

// ── Transport callbacks ──────────────────────────────────────────────

const callbacks: TransportCallbacks = {
  sendMessage: sendTelegramMessage,
  sendTyping: sendTypingAction,
};

// ── Command handlers ─────────────────────────────────────────────────

async function handleStartCommand(chatId: string): Promise<void> {
  await sendTelegramMessage(
    chatId,
    "Welcome to LFG Instant App Builder!\n\n" +
      "Tell me what app you'd like to build and I'll create it for you.\n\n" +
      "Examples:\n" +
      '- "Build me a todo app with categories"\n' +
      '- "Create a habit tracker with streaks"\n' +
      '- "Make a recipe collection app"\n\n' +
      "Commands:\n" +
      "/new — Start a fresh conversation\n" +
      "/status — Check your current app build status"
  );
}

async function handleNewCommand(chatId: string): Promise<void> {
  await resetSession(CHANNEL, chatId);
  await sendTelegramMessage(chatId, "Conversation reset. Tell me what you'd like to build!");
}

async function handleStatusCommand(chatId: string): Promise<void> {
  const session = await getSession(CHANNEL, chatId);
  if (!session || !session.conversationId) {
    await sendTelegramMessage(chatId, "No active build. Send me a message describing what app you want to build!");
    return;
  }
  await sendTelegramMessage(
    chatId,
    "You have an active conversation. Send a message to continue, or use /new to start fresh."
  );
}

// ── Process a single update ──────────────────────────────────────────

async function processUpdate(update: any): Promise<void> {
  const msg = update.message;
  if (!msg?.text) return;

  const chatId = String(msg.chat.id);
  const text = msg.text.trim();
  const displayName =
    msg.from?.first_name ??
    msg.from?.username ??
    undefined;

  // Handle commands
  if (text.startsWith("/")) {
    const command = text.split(/\s+/)[0]!.replace(/@\w+$/, "").toLowerCase();

    switch (command) {
      case "/start":
        await handleStartCommand(chatId);
        return;
      case "/new":
        await handleNewCommand(chatId);
        return;
      case "/status":
        await handleStatusCommand(chatId);
        return;
      default:
        break; // Unknown command — treat as regular message
    }
  }

  // Feed message to the channel-agnostic engine
  await handleIncomingMessage(CHANNEL, chatId, text, displayName, callbacks);
}

// ── Long-polling loop ────────────────────────────────────────────────

async function pollLoop(): Promise<void> {
  while (running && abortCtrl && !abortCtrl.signal.aborted) {
    try {
      const data = await tgApi("getUpdates", {
        offset: lastUpdateId + 1,
        timeout: 30,
        allowed_updates: ["message"],
      });

      if (!running || abortCtrl?.signal.aborted) break;

      if (data.ok && data.result?.length > 0) {
        for (const update of data.result) {
          lastUpdateId = update.update_id;
          processUpdate(update).catch((err) => {
            console.error(`[public-telegram] Error processing update:`, err);
          });
        }
      }
    } catch (err) {
      if (!running || abortCtrl?.signal.aborted) break;
      console.error(`[public-telegram] Polling error:`, err);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  console.log("[public-telegram] Polling stopped");
}

// ── Public API ───────────────────────────────────────────────────────

export async function startPublicTelegramBot(): Promise<void> {
  const token = env.TELEGRAM_PUBLIC_BOT_TOKEN;
  const ownerId = env.TELEGRAM_PUBLIC_BOT_OWNER_ID;

  if (!token || !ownerId) {
    console.log("[public-telegram] TELEGRAM_PUBLIC_BOT_TOKEN or TELEGRAM_PUBLIC_BOT_OWNER_ID not set — skipping");
    return;
  }

  // Clear any existing webhook so polling works
  await tgApi("deleteWebhook");

  const me = await tgApi("getMe");
  const username = me.ok ? me.result.username : "unknown";
  console.log(`[public-telegram] Started public bot @${username} (owner: ${ownerId})`);

  running = true;
  abortCtrl = new AbortController();
  lastUpdateId = 0;

  pollLoop(); // fire and forget
}

export function stopPublicTelegramBot(): void {
  running = false;
  abortCtrl?.abort();
  abortCtrl = null;
}
