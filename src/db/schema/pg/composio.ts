import { pgTable, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";

/**
 * Tracks which Composio toolkits each user has enabled for AI conversations.
 * Actual connected account state is managed by Composio's API.
 */
export const composioToolkits = pgTable("composio_toolkit", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  toolkit: text("toolkit").notNull(), // e.g. "GITHUB", "GMAIL", "SLACK"
  enabled: boolean("enabled").notNull().default(true),
  connectedAccountId: text("connected_account_id"), // Composio connected account ID
  createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
});
