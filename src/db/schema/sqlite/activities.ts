import {
  sqliteTable,
  text,
  integer,
  index,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { projects } from "./projects.ts";

// ── Project Activities (Event Timeline) ─────────────────────────────

export const projectActivities = sqliteTable(
  "project_activity",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    ticketId: text("ticket_id"),
    actorType: text("actor_type").notNull().default("system"), // system | user | ai
    activityType: text("activity_type").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [
    index("pa_project_created_idx").on(t.projectId, t.createdAt),
    index("pa_ticket_idx").on(t.ticketId),
    index("pa_activity_type_idx").on(t.activityType),
  ]
);

export type ProjectActivity = typeof projectActivities.$inferSelect;
export type NewProjectActivity = typeof projectActivities.$inferInsert;

// Activity type constants
export const ACTIVITY_TYPES = {
  TICKET_QUEUED: "ticket_queued",
  TICKET_STARTED: "ticket_started",
  TICKET_COMPLETED: "ticket_completed",
  TICKET_FAILED: "ticket_failed",
  TICKET_STUCK: "ticket_stuck",
  GIT_PUSHED: "git_pushed",
  GIT_MERGED: "git_merged",
  ORCHESTRATOR_QUEUED_NEXT: "orchestrator_queued_next",
  USER_ACTION_REQUIRED: "user_action_required",
  BATCH_COMPLETE: "batch_complete",
  CREDENTIALS_INJECTED: "credentials_injected",
  CREDENTIALS_SAVED: "credentials_saved",
} as const;
