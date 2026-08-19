import {
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";
import { projects } from "./projects.ts";

/**
 * An EPIC is the unit of delivery: one client-facing chunk of work that owns its
 * docs (scope / technical analysis), its cascading tickets, its git branch, its
 * preview, and its approval.
 *
 * Why it exists: before epics, every ticket branched off a single global
 * `lfg-agent` branch and auto-merged back into it. That made `lfg-agent` both the
 * cascade base ("ticket 4 needs ticket 3's code") AND the permanent parent of all
 * future work — so an UNAPPROVED batch of tickets leaked into the next batch, the
 * client saw features nobody had shown them, and merging any one thing to main
 * dragged all the unverified code along with it.
 *
 * An epic scopes the cascade to the approval boundary:
 *   main ──▶ epic/<key>-<slug> ──▶ feature/<ticket>   (tickets cascade INSIDE the epic)
 *   epic branch ──▶ main   ONLY when the client approves the epic.
 *
 * Tickets in the same epic still see each other's code. Tickets in a different
 * epic never do — unless the epic explicitly declares `parentEpicId` (stacking),
 * which is recorded, shown, and enforced at merge time.
 */
export const epics = pgTable(
  "epic",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Human-facing key, e.g. "PRO-E1". Unique per project.
    epicKey: text("epic_key"),
    name: text("name").notNull(),
    // One-line client-facing statement of what this delivers.
    goal: text("goal").default(""),

    // draft      — created, no tickets built yet
    // building   — at least one ticket in flight
    // in_review  — all tickets built; waiting on the client
    // approved   — client accepted; ready to promote to main
    // merged     — branch merged to main, docs promoted
    // rejected   — client said no; branch is abandoned, docs discarded
    status: text("status").notNull().default("draft"),

    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    // The chat this epic was born from, so the intent is always one click away.
    conversationId: text("conversation_id"),

    // ── Git ────────────────────────────────────────────────────────────
    // The epic's integration branch. Tickets branch off it and merge back into it.
    branch: text("branch"),
    // What the epic was cut from — normally the repo default branch ("main").
    baseBranch: text("base_branch").notNull().default("main"),
    // Pinned at kickoff so the base can't drift under an in-flight epic.
    baseSha: text("base_sha"),
    // Set when this epic deliberately stacks on another UNAPPROVED epic. Null =
    // cut from clean `baseBranch`. A stacked epic cannot merge to main until its
    // parent has merged.
    parentEpicId: text("parent_epic_id"),

    // ── Promotion to main ──────────────────────────────────────────────
    prNumber: integer("pr_number"),
    prUrl: text("pr_url"),
    mergeCommitSha: text("merge_commit_sha"),
    mergedAt: timestamp("merged_at", { mode: "date" }),

    // ── Review ─────────────────────────────────────────────────────────
    submittedForReviewAt: timestamp("submitted_for_review_at", { mode: "date" }),
    approvedById: text("approved_by_id").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { mode: "date" }),
    rejectedAt: timestamp("rejected_at", { mode: "date" }),
    reviewNotes: text("review_notes").default(""),

    // Preview environment serving THIS epic's branch (not the shared anchor), so
    // "where did this feature come from?" can't happen.
    previewUrl: text("preview_url"),

    // Repo-relative paths touched by this epic's merged tickets. Used to detect
    // when a NEW epic overlaps an unapproved one, so stacking can be suggested
    // instead of asked about blindly.
    filesTouched: jsonb("files_touched").default([]),

    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [
    index("epic_project_idx").on(t.projectId),
    index("epic_project_status_idx").on(t.projectId, t.status),
    index("epic_conv_idx").on(t.conversationId),
    uniqueIndex("epic_project_key_unique").on(t.projectId, t.epicKey),
  ]
);
