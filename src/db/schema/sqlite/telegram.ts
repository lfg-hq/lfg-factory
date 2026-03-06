import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";

// ── Telegram Bots ───────────────────────────────────────────────────
// Each user can configure their own Telegram bot to interact with LFG.
// The bot token is stored per-user, and we run a polling instance for each.

export const telegramBots = sqliteTable(
  "telegram_bot",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),
    botToken: text("bot_token").notNull(),
    botUsername: text("bot_username"), // e.g. "MyLFGBot"
    // Which project to use for conversations from this bot
    projectId: text("project_id"),
    // The ongoing conversation ID for continuity
    conversationId: text("conversation_id"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
);
