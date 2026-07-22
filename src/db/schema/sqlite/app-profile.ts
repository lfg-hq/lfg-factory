import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { projects } from "./projects.ts";

// ── App Profile ──────────────────────────────────────────────────────────
// Persisted, self-healing "how to run THIS app" knowledge from the PROBE agent.
// See the pg version for the full rationale. One row per (project, branch).
export const appProfiles = sqliteTable(
  "app_profile",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    branch: text("branch").notNull().default("default"),
    version: integer("version").notNull().default(1),
    profile: text("profile").notNull(), // JSON: the full AppProfile
    probedAt: integer("probed_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [uniqueIndex("app_profile_project_branch_unique").on(t.projectId, t.branch)]
);
