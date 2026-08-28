import { pgTable, text, boolean, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { projects } from "./projects.ts";

/**
 * Skills a project adds for itself, alongside the ones that ship with LFG.
 *
 * A skill is a workflow the agent pulls in when it recognises the job — the built-in
 * ones live in src/ai/skills/*.md and are the same everywhere. These are per-project:
 * "how we cut a release here", "our API conventions". Same shape, so the agent can't
 * tell them apart: a name it can call, a description telling it when, and a body it
 * follows.
 */
export const projectSkills = pgTable(
  "project_skill",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** The id the agent calls: lowercase, hyphenated. */
    name: text("name").notNull(),
    /** WHEN to use it — this is what the agent reads to decide. */
    description: text("description").notNull(),
    /** The instructions themselves. */
    body: text("body").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [
    uniqueIndex("psk_project_name_unique").on(t.projectId, t.name),
    index("psk_project_idx").on(t.projectId),
  ]
);
