import { pgTable, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { projects } from "./projects.ts";

// ── Project databases ────────────────────────────────────────────────
// Provisioned DB engines (one persistent Mags sandbox per project+engine),
// used to run/test the project's app in dev. Data persists via the sandbox's
// S3-synced workspace; the sandbox idle-reaps and is respawned on demand.
export const projectDatabases = pgTable(
  "project_database",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    engine: text("engine").notNull(), // postgres | mysql | mssql | redis
    // Mags workspace name (stable, S3-backed) — respawn key for wake-on-resume.
    workspaceId: text("workspace_id").notNull(),
    memGb: integer("mem_gb").notNull().default(2), // sandbox RAM tier (2 or 4)
    diskGb: integer("disk_gb").notNull().default(20),
    host: text("host"), // reachable host (from the exposed port)
    port: integer("port"), // engine port (5432 / 3306 / 1433 / 6379)
    endpoint: text("endpoint"), // full reachable endpoint (host:port or URL)
    dbName: text("db_name"), // default database created
    username: text("username"),
    passwordEncrypted: text("password_encrypted"), // we generate + own the password
    status: text("status").notNull().default("provisioning"), // provisioning | ready | reaped | error
    seededAt: timestamp("seeded_at", { mode: "date" }),
    lastAwakeAt: timestamp("last_awake_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [
    index("pdb_project_idx").on(t.projectId),
    uniqueIndex("pdb_workspace_unique").on(t.workspaceId),
    uniqueIndex("pdb_project_engine_unique").on(t.projectId, t.engine),
  ]
);
