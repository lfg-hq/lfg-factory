// ── Public Instant App Engine ──────────────────────────────────────────
// Channel-agnostic session manager. Any transport (Telegram, WhatsApp,
// web form) calls `handleIncomingMessage()` and provides callbacks.

import { db } from "../../config/db.ts";
import { env } from "../../config/env.ts";
import { publicInstantChats } from "../../db/schema/public-instant.ts";
import { eq, and } from "drizzle-orm";
import { handleStream } from "../../ai/stream-handler.ts";
import { addBroadcastListener, removeBroadcastListener } from "../../ws/connection-manager.ts";
import type { ServerWebSocket } from "bun";
import type { WsData } from "../../ws/types.ts";
import type { TransportCallbacks } from "./types.ts";

// ── Owner user ID (whose credentials power all public builds) ────────
function getOwnerId(): string {
  const id = env.TELEGRAM_PUBLIC_BOT_OWNER_ID;
  if (!id) throw new Error("TELEGRAM_PUBLIC_BOT_OWNER_ID not configured");
  return id;
}

// ── Session CRUD ─────────────────────────────────────────────────────

async function upsertSession(channel: string, externalId: string, displayName?: string) {
  const [existing] = await db
    .select()
    .from(publicInstantChats)
    .where(and(eq(publicInstantChats.channel, channel), eq(publicInstantChats.externalId, externalId)))
    .limit(1);

  if (existing) {
    if (displayName && displayName !== existing.displayName) {
      await db
        .update(publicInstantChats)
        .set({ displayName, updatedAt: new Date() })
        .where(eq(publicInstantChats.id, existing.id));
    }
    return existing;
  }

  const [created] = await db
    .insert(publicInstantChats)
    .values({ channel, externalId, displayName: displayName ?? null })
    .returning();

  return created!;
}

export async function resetSession(channel: string, externalId: string): Promise<void> {
  await db
    .update(publicInstantChats)
    .set({ conversationId: null, updatedAt: new Date() })
    .where(and(eq(publicInstantChats.channel, channel), eq(publicInstantChats.externalId, externalId)));
}

export async function getSession(channel: string, externalId: string) {
  const [row] = await db
    .select()
    .from(publicInstantChats)
    .where(and(eq(publicInstantChats.channel, channel), eq(publicInstantChats.externalId, externalId)))
    .limit(1);
  return row ?? null;
}

// ── Mock WebSocket for handleStream ──────────────────────────────────
// Mirrors the approach used by the per-user Telegram bot in telegram.ts

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

// ── Build notification listener ──────────────────────────────────────
// When a build is running, broadcastToUser sends status updates. We
// listen for these and forward them to the transport.

function registerBuildListener(
  conversationId: string,
  externalId: string,
  callbacks: TransportCallbacks
): () => void {
  const ownerId = getOwnerId();

  const listener = (data: object) => {
    const msg = data as Record<string, unknown>;
    if (msg.notification_type !== "instant_app_status" && msg.notification_type !== "instant_app_ready") return;
    // Filter by conversation if the broadcast includes it
    if (msg.conversation_id && msg.conversation_id !== conversationId) return;

    const text = String(msg.message || "");
    if (!text) return;

    const previewUrl = msg.preview_url ? String(msg.preview_url) : "";
    const status = String(msg.instant_app_status || "");

    let notifyText = text;
    if (status === "running" && previewUrl) {
      notifyText = `${text}\n\nPreview: ${previewUrl}`;
    }

    callbacks.sendMessage(externalId, notifyText).catch((err) =>
      console.error(`[public-instant] Failed to send build notification:`, err)
    );
  };

  addBroadcastListener(ownerId, listener);

  return () => removeBroadcastListener(ownerId, listener);
}

// ── Main entry point ─────────────────────────────────────────────────

export async function handleIncomingMessage(
  channel: string,
  externalId: string,
  text: string,
  displayName: string | undefined,
  callbacks: TransportCallbacks
): Promise<void> {
  const ownerId = getOwnerId();
  const session = await upsertSession(channel, externalId, displayName);

  await callbacks.sendTyping(externalId);

  // Keep typing indicator active while waiting for response
  const typingInterval = setInterval(() => {
    callbacks.sendTyping(externalId).catch(() => {});
  }, 4000);

  // Register broadcast listener for build notifications
  let unsubscribe: (() => void) | undefined;

  try {
    const response = await new Promise<{ text: string; conversationId?: string }>(
      (resolve, reject) => {
        const abortController = new AbortController();
        const timeout = setTimeout(() => {
          abortController.abort();
          reject(new Error("Response timed out"));
        }, 180_000); // 3 min timeout for instant mode builds

        const mockWs = createMockWs((fullText, convId) => {
          clearTimeout(timeout);
          resolve({ text: fullText, conversationId: convId });
        });

        handleStream({
          ws: mockWs,
          userId: ownerId,
          userMessage: text,
          conversationId: session.conversationId ?? undefined,
          instantMode: true,
          abortController,
        }).catch((err) => {
          clearTimeout(timeout);
          reject(err);
        });
      }
    );

    // Update session with conversation ID
    if (response.conversationId && response.conversationId !== session.conversationId) {
      await db
        .update(publicInstantChats)
        .set({ conversationId: response.conversationId, updatedAt: new Date() })
        .where(eq(publicInstantChats.id, session.id));

      // Register build notification listener now that we have a conversation ID
      unsubscribe = registerBuildListener(response.conversationId, externalId, callbacks);
    } else if (session.conversationId) {
      unsubscribe = registerBuildListener(session.conversationId, externalId, callbacks);
    }

    if (response.text.trim()) {
      await callbacks.sendMessage(externalId, response.text);
    } else {
      await callbacks.sendMessage(externalId, "I'm working on that. You'll receive updates as the build progresses.");
    }
  } catch (err: any) {
    console.error(`[public-instant] Error handling message from ${channel}/${externalId}:`, err);
    await callbacks.sendMessage(
      externalId,
      `Something went wrong: ${err.message ?? "Unknown error"}. Please try again.`
    );
  } finally {
    clearInterval(typingInterval);
    // Keep the build listener alive for a while to catch async build notifications.
    // It will be cleaned up when the session is reset or after a timeout.
    if (unsubscribe) {
      setTimeout(() => unsubscribe!(), 60 * 60 * 1000); // 1 hour
    }
  }
}
