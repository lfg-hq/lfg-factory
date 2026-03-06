// ── Telegram Bot Service ────────────────────────────────────────────
// Per-user Telegram bot management. Each user configures their own bot
// token. We run a long-polling loop for each active bot and route
// messages through the product analyst chat agent.

import { db } from "../config/db.ts";
import { telegramBots } from "../db/schema/telegram.ts";
import { conversations } from "../db/schema/chat.ts";
import { projects } from "../db/schema/projects.ts";
import { users } from "../db/schema/users.ts";
import { eq, desc } from "drizzle-orm";
import { handleStream } from "../ai/stream-handler.ts";
import type { ServerWebSocket } from "bun";
import type { WsData } from "../ws/types.ts";

const API_BASE = "https://api.telegram.org/bot";

// Track active polling loops per userId
const activeBots = new Map<string, { abort: AbortController; lastUpdateId: number }>();

// ── Telegram API helpers ────────────────────────────────────────────

async function tgApi(token: string, method: string, body?: object): Promise<any> {
  const res = await fetch(`${API_BASE}${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data: any = await res.json();
  if (!data.ok) {
    console.error(`[telegram] API error on ${method}:`, data.description);
  }
  return data;
}

async function sendMessage(token: string, chatId: string, text: string): Promise<void> {
  const MAX_LEN = 4000;
  let remaining = text;
  while (remaining.length > 0) {
    const chunk = remaining.slice(0, MAX_LEN);
    remaining = remaining.slice(MAX_LEN);
    await tgApi(token, "sendMessage", { chat_id: chatId, text: chunk, parse_mode: "Markdown" });
  }
}

async function sendChatAction(token: string, chatId: string): Promise<void> {
  await tgApi(token, "sendChatAction", { chat_id: chatId, action: "typing" });
}

// ── Mock WebSocket adapter ──────────────────────────────────────────
// handleStream sends chunks via ws.send(). We collect them and build
// the full response to send back to Telegram once streaming completes.

function createMockWs(onFinal: (fullText: string, convId?: string) => void) {
  let fullText = "";
  let convId: string | undefined;

  const mock = {
    send(raw: string) {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === "ai_chunk" && !msg.is_notification) {
          if (msg.chunk) fullText += msg.chunk;
          if (msg.is_final) {
            convId = msg.conversation_id;
            onFinal(fullText, convId);
          }
        }
        if (msg.type === "conversation_created") {
          convId = msg.conversationId;
        }
      } catch {
        // ignore parse errors
      }
    },
    data: {} as WsData,
    readyState: 1,
  };

  return mock as unknown as ServerWebSocket<WsData>;
}

// ── Handle /project command ─────────────────────────────────────────

async function handleProjectCommand(token: string, chatId: string, userId: string, projectName: string): Promise<void> {
  if (!projectName) {
    const userProjects = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(eq(projects.ownerId, userId))
      .orderBy(desc(projects.createdAt));

    if (userProjects.length === 0) {
      await sendMessage(token, chatId, "You have no projects yet. Create one in the LFG app first.");
      return;
    }

    const list = userProjects.map((p, i) => `${i + 1}. *${p.name}*`).join("\n");
    await sendMessage(token, chatId, `Your projects:\n${list}\n\nSend /project ProjectName to select one.`);
    return;
  }

  const userProjects = await db
    .select()
    .from(projects)
    .where(eq(projects.ownerId, userId));

  const match = userProjects.find(
    (p) => p.name.toLowerCase().includes(projectName.toLowerCase())
  );

  if (!match) {
    await sendMessage(token, chatId, `No project found matching "${projectName}". Use /project to list your projects.`);
    return;
  }

  await db
    .update(telegramBots)
    .set({ projectId: match.id, conversationId: null, updatedAt: new Date() })
    .where(eq(telegramBots.userId, userId));

  await sendMessage(token, chatId, `Switched to project *${match.name}*. Conversation context has been reset.`);
}

// ── Handle regular chat message ─────────────────────────────────────

async function handleChatMessage(token: string, chatId: string, userId: string, text: string): Promise<void> {
  const [botRow] = await db.select().from(telegramBots).where(eq(telegramBots.userId, userId));
  if (!botRow) return;

  await sendChatAction(token, chatId);

  const typingInterval = setInterval(() => {
    sendChatAction(token, chatId).catch(() => {});
  }, 4000);

  try {
    const response = await new Promise<{ text: string; conversationId?: string }>(
      (resolve, reject) => {
        const abortController = new AbortController();
        const timeout = setTimeout(() => {
          abortController.abort();
          reject(new Error("Response timed out"));
        }, 120_000);

        const mockWs = createMockWs((fullText, convId) => {
          clearTimeout(timeout);
          resolve({ text: fullText, conversationId: convId });
        });

        handleStream({
          ws: mockWs,
          userId,
          userMessage: text,
          conversationId: botRow.conversationId ?? undefined,
          projectId: botRow.projectId ?? undefined,
          abortController,
        }).catch((err) => {
          clearTimeout(timeout);
          reject(err);
        });
      }
    );

    if (response.conversationId && response.conversationId !== botRow.conversationId) {
      await db
        .update(telegramBots)
        .set({ conversationId: response.conversationId, updatedAt: new Date() })
        .where(eq(telegramBots.userId, userId));
    }

    if (response.text.trim()) {
      await sendMessage(token, chatId, response.text);
    } else {
      await sendMessage(token, chatId, "_No response generated._");
    }
  } catch (err: any) {
    console.error("[telegram] Chat error:", err);
    await sendMessage(token, chatId, `Error: ${err.message ?? "Something went wrong"}`);
  } finally {
    clearInterval(typingInterval);
  }
}

// ── Process a single Telegram update ────────────────────────────────

async function processUpdate(token: string, userId: string, update: any): Promise<void> {
  const msg = update.message;
  if (!msg?.text) return;

  const chatId = String(msg.chat.id);
  const text = msg.text.trim();

  if (text.startsWith("/")) {
    const [cmd, ...args] = text.split(/\s+/);
    const command = cmd!.replace(/@\w+$/, "").toLowerCase();

    switch (command) {
      case "/start":
        await sendMessage(
          token, chatId,
          "Welcome to LFG! I'm your product analyst agent.\n\n" +
            "Commands:\n" +
            "/project — List or switch projects\n" +
            "/newchat — Start a fresh conversation\n" +
            "/status — Check connection status",
        );
        return;

      case "/project":
        await handleProjectCommand(token, chatId, userId, args.join(" "));
        return;

      case "/newchat":
        await db
          .update(telegramBots)
          .set({ conversationId: null, updatedAt: new Date() })
          .where(eq(telegramBots.userId, userId));
        await sendMessage(token, chatId, "Started a new conversation. Send your next message to begin.");
        return;

      case "/status": {
        const [user] = await db.select().from(users).where(eq(users.id, userId));
        const [bot] = await db.select().from(telegramBots).where(eq(telegramBots.userId, userId));
        let status = `Connected as *${user?.name ?? "Unknown"}*`;
        if (bot?.projectId) {
          const [proj] = await db.select().from(projects).where(eq(projects.id, bot.projectId));
          status += `\nActive project: *${proj?.name ?? "Unknown"}*`;
        } else {
          status += "\nNo project selected. Use /project to pick one.";
        }
        await sendMessage(token, chatId, status);
        return;
      }

      default:
        break;
    }
  }

  await handleChatMessage(token, chatId, userId, text);
}

// ── Long-polling loop for a single user's bot ───────────────────────

async function pollBot(userId: string, token: string): Promise<void> {
  const state = activeBots.get(userId);
  if (!state) return;

  while (!state.abort.signal.aborted) {
    try {
      const data = await tgApi(token, "getUpdates", {
        offset: state.lastUpdateId + 1,
        timeout: 30,
        allowed_updates: ["message"],
      });

      if (state.abort.signal.aborted) break;

      if (data.ok && data.result?.length > 0) {
        for (const update of data.result) {
          state.lastUpdateId = update.update_id;
          processUpdate(token, userId, update).catch((err) => {
            console.error(`[telegram] Error processing update for user ${userId}:`, err);
          });
        }
      }
    } catch (err) {
      if (state.abort.signal.aborted) break;
      console.error(`[telegram] Polling error for user ${userId}:`, err);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  console.log(`[telegram] Polling stopped for user ${userId}`);
}

// ── Public API ──────────────────────────────────────────────────────

/** Validate a bot token and return bot info. */
export async function validateBotToken(token: string): Promise<{ ok: boolean; username?: string; error?: string }> {
  try {
    const data = await tgApi(token, "getMe");
    if (data.ok) {
      return { ok: true, username: data.result.username };
    }
    return { ok: false, error: data.description ?? "Invalid token" };
  } catch (err: any) {
    return { ok: false, error: err.message ?? "Connection failed" };
  }
}

/** Start polling for a specific user's bot. */
export async function startBotForUser(userId: string, token: string): Promise<void> {
  // Stop existing instance if any
  stopBotForUser(userId);

  // Clear any existing webhook so polling works
  await tgApi(token, "deleteWebhook");

  const state = { abort: new AbortController(), lastUpdateId: 0 };
  activeBots.set(userId, state);

  const me = await tgApi(token, "getMe");
  const username = me.ok ? me.result.username : "unknown";
  console.log(`[telegram] Started bot @${username} for user ${userId}`);

  pollBot(userId, token); // fire and forget
}

/** Stop polling for a specific user's bot. */
export function stopBotForUser(userId: string): void {
  const state = activeBots.get(userId);
  if (state) {
    state.abort.abort();
    activeBots.delete(userId);
  }
}

/** Check if a user's bot is currently polling. */
export function isBotActive(userId: string): boolean {
  return activeBots.has(userId);
}
