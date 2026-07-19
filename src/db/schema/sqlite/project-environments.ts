import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { projects } from "./projects.ts";

// ── Project environments ─────────────────────────────────────────────
// ONE always-on Mags sandbox per project (Instant VM model: local /data ext4
// volume, noSync) — hosts the app + its DBs (co-located under /data, localhost).
// Data lives on the /data volume; persists as long as the VM is up.
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
    // ── Preview (localhost-style run of the client app) ──
    previewStatus: text("preview_status").notNull().default("idle"), // idle | detecting | provisioning | installing | seeding | starting | running | error | stopped
    previewError: text("preview_error"),
    previewBranch: text("preview_branch"), // git branch currently previewed
    stableAlias: text("stable_alias"), // Mags stable subdomain for a persistent URL
    setupManifest: text("setup_manifest"), // JSON: detected stack/commands/engines/env
    setupLog: text("setup_log"), // last setup run's step log (truncated)
    lastAwakeAt: integer("last_awake_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [uniqueIndex("penv_project_unique").on(t.projectId)]
);
