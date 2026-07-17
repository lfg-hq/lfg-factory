import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";

// ── Notifications ────────────────────────────────────────────────────
// Powers the dashboard "inbox" — assigned tickets, @mentions, comments.

export const notifications = sqliteTable(
  "notification",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id") // recipient
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }), // who triggered it
    projectId: text("project_id"), // public projectId, for linking + scoping
    type: text("type").notNull(), // assigned | mentioned | comment | comment_reply | comment_resolved
    targetType: text("target_type").notNull(), // ticket | document
    targetId: text("target_id").notNull(),
    message: text("message").notNull(),
    link: text("link"), // where to navigate on click
    readAt: integer("read_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    index("notif_user_idx").on(t.userId),
    index("notif_read_idx").on(t.readAt),
  ]
);
