import { pgTable, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { projects } from "./projects.ts";

// ── Project pins ─────────────────────────────────────────────────────
// Owner-curated "Start here" resources shown on the project Home for every
// member. targetType: document | ticket | link.
export const projectPins = pgTable(
  "project_pin",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    targetType: text("target_type").notNull(), // document | ticket | link
    targetId: text("target_id"), // fileId / ticketId for document|ticket
    url: text("url"), // for link
    label: text("label").notNull(),
    order: integer("order").notNull().default(0),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [index("pin_project_idx").on(t.projectId)]
);
