import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { conversations } from "./chat.ts";

export const publicInstantChats = sqliteTable(
  "public_instant_chat",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    channel: text("channel").notNull(), // "telegram" | "whatsapp" | "web"
    externalId: text("external_id").notNull(), // Telegram chatId, WhatsApp phone, etc.
    conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    displayName: text("display_name"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    uniqueIndex("public_instant_channel_ext_idx").on(t.channel, t.externalId),
    index("public_instant_conversation_idx").on(t.conversationId),
  ]
);
