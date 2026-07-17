import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";

// ── Notifications ────────────────────────────────────────────────────
// Powers the dashboard "inbox" — assigned tickets, @mentions, comments.

export const notifications = pgTable(
  "notification",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id") // recipient
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    projectId: text("project_id"),
    type: text("type").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    message: text("message").notNull(),
    link: text("link"),
    readAt: timestamp("read_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [
    index("notif_user_idx").on(t.userId),
    index("notif_read_idx").on(t.readAt),
  ]
);
