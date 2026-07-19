import { pgTable, text, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { projects } from "./projects.ts";

// ── Project environments ─────────────────────────────────────────────
// ONE persistent, S3-backed Mags sandbox per project — hosts the app, its DBs
// (co-located, reached over localhost), and git worktrees per branch. Used for
// testing the app, QA, and building individual tickets. Kept alive; data lives
// on the synced workspace (/root) so it survives stop → respawn.
export const projectEnvironments = pgTable(
  "project_environment",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull(), // Mags workspace (respawn key)
    memGb: integer("mem_gb").notNull().default(4),
    diskGb: integer("disk_gb").notNull().default(20),
    status: text("status").notNull().default("stopped"), // stopped | running | error
    appUrl: text("app_url"), // Mags public URL for the running app (preview)
    appPort: integer("app_port"), // port the app runs on inside the sandbox
    lastAwakeAt: timestamp("last_awake_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [uniqueIndex("penv_project_unique").on(t.projectId)]
);
