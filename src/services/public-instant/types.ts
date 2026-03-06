// ── Public Instant App Builder — Shared Types ─────────────────────────
// Channel-agnostic interfaces for the public instant app engine.

export interface TransportCallbacks {
  /** Send a text message to the external user */
  sendMessage: (externalId: string, text: string) => Promise<void>;
  /** Show a typing indicator to the external user */
  sendTyping: (externalId: string) => Promise<void>;
}

export interface ChatSession {
  id: string;
  channel: string; // "telegram" | "whatsapp" | "web" | ...
  externalId: string; // chatId for Telegram, phone for WhatsApp, sessionId for web
  conversationId: string | null;
  displayName: string | null;
  createdAt: Date;
  updatedAt: Date;
}
