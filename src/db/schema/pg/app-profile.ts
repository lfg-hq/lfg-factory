import { pgTable, text, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { projects } from "./projects.ts";

// ── App Profile ──────────────────────────────────────────────────────────
// The persisted, self-healing "how to run THIS app" knowledge, produced by the
// PROBE agent (a deep read of the codebase) BEFORE any run. It's the source of
// truth the preview runbook is derived from: exact stack/versions, the schema
// build recipe (migrations + SQL scripts in dependency order + seed), env vars
// classified (auto / derivable / USER-REQUIRED secrets it can't generate), and
// config/build quirks. Each run records failures + corrections back into it, so
// re-runs are deterministic and fast instead of re-investigating from scratch.
// One row per (project, branch); `version` bumps on each re-probe.
export const appProfiles = pgTable(
  "app_profile",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    branch: text("branch").notNull().default("default"), // which branch this profile describes
    version: integer("version").notNull().default(1), // bumps each re-probe
    profile: text("profile").notNull(), // JSON: the full AppProfile (see app-profile.ts)
    probedAt: timestamp("probed_at", { mode: "date" }), // last successful probe
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [uniqueIndex("app_profile_project_branch_unique").on(t.projectId, t.branch)]
);
