import { pgTable, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { conversations } from "./chat.ts";

export const publicInstantChats = pgTable(
  "public_instant_chat",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    channel: text("channel").notNull(),
    externalId: text("external_id").notNull(),
    conversationId: text("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    displayName: text("display_name"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [
    uniqueIndex("public_instant_channel_ext_idx").on(t.channel, t.externalId),
    index("public_instant_conversation_idx").on(t.conversationId),
  ]
);
