import { pgTable, text, boolean, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";

export const telegramBots = pgTable("telegram_bot", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  botToken: text("bot_token").notNull(),
  botUsername: text("bot_username"),
  projectId: text("project_id"),
  conversationId: text("conversation_id"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
});
