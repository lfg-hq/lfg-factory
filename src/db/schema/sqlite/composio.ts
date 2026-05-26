import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";

/**
 * Tracks which Composio toolkits each user has enabled for AI conversations.
 * Actual connected account state is managed by Composio's API.
 */
export const composioToolkits = sqliteTable("composio_toolkit", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  toolkit: text("toolkit").notNull(), // e.g. "GITHUB", "GMAIL", "SLACK"
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  connectedAccountId: text("connected_account_id"), // Composio connected account ID
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});
