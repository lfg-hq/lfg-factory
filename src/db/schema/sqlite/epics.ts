import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";
import { projects } from "./projects.ts";

/**
 * An EPIC is the unit of delivery: one client-facing chunk of work that owns its
 * docs (scope / technical analysis), its cascading tickets, its git branch, its
 * preview, and its approval. See ../pg/epics.ts for the full rationale.
 *
 *   main ──▶ epic/<key>-<slug> ──▶ feature/<ticket>   (tickets cascade INSIDE the epic)
 *   epic branch ──▶ main   ONLY when the client approves the epic.
 */
export const epics = sqliteTable(
  "epic",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    epicKey: text("epic_key"), // e.g. "PRO-E1" — unique per project
    name: text("name").notNull(),
    goal: text("goal").default(""),

    // draft | building | in_review | approved | merged | rejected
    status: text("status").notNull().default("draft"),

    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    conversationId: text("conversation_id"),

    // ── Git ────────────────────────────────────────────────────────────
    branch: text("branch"),
    baseBranch: text("base_branch").notNull().default("main"),
    baseSha: text("base_sha"),
    parentEpicId: text("parent_epic_id"),

    // ── Promotion to main ──────────────────────────────────────────────
    prNumber: integer("pr_number"),
    prUrl: text("pr_url"),
    mergeCommitSha: text("merge_commit_sha"),
    mergedAt: integer("merged_at", { mode: "timestamp" }),

    // ── Review ─────────────────────────────────────────────────────────
    submittedForReviewAt: integer("submitted_for_review_at", { mode: "timestamp" }),
    approvedById: text("approved_by_id").references(() => users.id, { onDelete: "set null" }),
    approvedAt: integer("approved_at", { mode: "timestamp" }),
    rejectedAt: integer("rejected_at", { mode: "timestamp" }),
    reviewNotes: text("review_notes").default(""),

    previewUrl: text("preview_url"),

    filesTouched: text("files_touched", { mode: "json" }).$type<string[]>().default([]),

    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    index("epic_project_idx").on(t.projectId),
    index("epic_project_status_idx").on(t.projectId, t.status),
    index("epic_conv_idx").on(t.conversationId),
    uniqueIndex("epic_project_key_unique").on(t.projectId, t.epicKey),
  ]
);
