import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { projects } from "./projects.ts";

// ── Project databases ────────────────────────────────────────────────
// Provisioned DB engines (one persistent Mags sandbox per project+engine),
// used to run/test the project's app in dev. Data persists via the sandbox's
// S3-synced workspace; the sandbox idle-reaps and is respawned on demand.
export const projectDatabases = sqliteTable(
  "project_database",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    engine: text("engine").notNull(), // postgres | mysql | mssql | redis
    workspaceId: text("workspace_id").notNull(),
    memGb: integer("mem_gb").notNull().default(2),
    diskGb: integer("disk_gb").notNull().default(20),
    host: text("host"),
    port: integer("port"),
    endpoint: text("endpoint"),
    dbName: text("db_name"),
    username: text("username"),
    passwordEncrypted: text("password_encrypted"),
    status: text("status").notNull().default("provisioning"), // provisioning | ready | reaped | error
    seededAt: integer("seeded_at", { mode: "timestamp" }),
    lastAwakeAt: integer("last_awake_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    index("pdb_project_idx").on(t.projectId),
    uniqueIndex("pdb_workspace_unique").on(t.workspaceId),
    uniqueIndex("pdb_project_engine_unique").on(t.projectId, t.engine),
  ]
);
