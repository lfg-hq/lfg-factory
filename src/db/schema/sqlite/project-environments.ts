import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { projects } from "./projects.ts";

// ── Project environments ─────────────────────────────────────────────
// ONE persistent, S3-backed Mags sandbox per project — hosts the app, its DBs
// (co-located, localhost), and git worktrees per branch. Data lives on the
// synced workspace (/root) so it survives stop → respawn.
export const projectEnvironments = sqliteTable(
  "project_environment",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull(),
    memGb: integer("mem_gb").notNull().default(4),
    diskGb: integer("disk_gb").notNull().default(20),
    status: text("status").notNull().default("stopped"), // stopped | running | error
    appUrl: text("app_url"),
    appPort: integer("app_port"),
    lastAwakeAt: integer("last_awake_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [uniqueIndex("penv_project_unique").on(t.projectId)]
);
