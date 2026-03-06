import { pgTable, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";

export const mcpServers = pgTable("mcp_server", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  transportType: text("transport_type").notNull(),
  url: text("url").notNull(),
  headers: text("headers"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
});
