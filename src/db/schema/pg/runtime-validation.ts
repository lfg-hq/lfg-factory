import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { projects } from "./projects.ts";
export const runtimeValidations = pgTable("runtime_validation", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  ticketId: text("ticket_id"), epicId: text("epic_id"), branch: text("branch").notNull(),
  revision: text("revision").notNull(), baseline: text("baseline").notNull().default(""),
  kind: text("kind").notNull(), status: text("status").notNull(),
  evidence: text("evidence").notNull(), steps: text("steps").notNull().default("[]"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
  completedAt: timestamp("completed_at", { mode: "date" }),
}, t => [index("validation_revision_idx").on(t.projectId, t.branch, t.revision), index("validation_ticket_idx").on(t.ticketId)]);
