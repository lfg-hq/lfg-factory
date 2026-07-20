import { pgTable, text, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { projects } from "./projects.ts";

// ── Project environments ─────────────────────────────────────────────
// ONE always-on Mags sandbox per project (Instant VM model: local /data ext4
// volume, noSync) — hosts the app, its DBs
// (co-located under /data, reached over localhost). Used for testing the app,
// QA, and building tickets. Kept alive; data lives on the /data volume so it
// survives as long as the VM is up.
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
    // ── Preview (localhost-style run of the client app) ──
    previewStatus: text("preview_status").notNull().default("idle"), // idle | detecting | provisioning | installing | seeding | starting | running | error | stopped
    previewError: text("preview_error"),
    previewBranch: text("preview_branch"), // git branch currently previewed
    stableAlias: text("stable_alias"), // Mags stable subdomain for a persistent URL
    setupManifest: text("setup_manifest"), // JSON: detected stack/commands/engines/env
    setupLog: text("setup_log"), // last setup run's step log (truncated)
    // ── Checkpointed runbook ──
    setupSteps: text("setup_steps"), // JSON: ordered command list + per-step status (resume point)
    setupComplete: integer("setup_complete").notNull().default(0), // 1 = install/build/schema all done → re-preview just runs the app
    runCommand: text("run_command"), // the exact command that starts the app (for direct re-run)
    lastAwakeAt: timestamp("last_awake_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [uniqueIndex("penv_project_unique").on(t.projectId)]
);
