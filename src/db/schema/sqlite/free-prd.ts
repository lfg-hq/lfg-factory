import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ── Free PRD Requests ────────────────────────────────────────────────
// Public, unauthenticated leads from the landing-page "Free PRD" form.
// The row id doubles as the public token for the /prd/:id page.
//
// status lifecycle:
//   pending_verification → (email code verified) → assessing
//   assessing → needs_clarification | generating
//   needs_clarification → (user answers) → assessing
//   generating → ready | failed
//
// Mirrors pg/free-prd.ts. SQLite has no boolean or timestamp type, so
// `verified` is an integer-backed boolean and the date columns are
// integer-backed timestamps — the same convention every other table here uses.
export const freePrdRequests = sqliteTable(
  "free_prd_request",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    email: text("email").notNull(),
    projectIdea: text("project_idea").notNull(),

    // Build Sprint lead context. These fields are nullable so the original
    // free-PRD flow can continue to use the same table and API.
    campaign: text("campaign"),
    name: text("name"),
    company: text("company"),
    website: text("website"),
    audience: text("audience"),
    currentWorkflow: text("current_workflow"),
    integration: text("integration"),
    timeline: text("timeline"),
    budget: text("budget"),
    attributionJson: text("attribution_json"),
    consentAt: integer("consent_at", { mode: "timestamp" }),
    leadScore: integer("lead_score").notNull().default(0),
    priority: text("priority").notNull().default("normal"),
    qualification: text("qualification"),
    blueprintVersion: text("blueprint_version"),
    modelVersion: text("model_version"),
    promptVersion: text("prompt_version"),

    // Email verification (6-digit code)
    code: text("code"),
    codeExpiresAt: integer("code_expires_at", { mode: "timestamp" }),
    verified: integer("verified", { mode: "boolean" }).notNull().default(false),

    status: text("status").notNull().default("pending_verification"),

    // JSON array of clarifying questions when the idea is too thin for a PRD
    clarifyingQuestions: text("clarifying_questions"),
    // Free-text answers the user provided to those questions (accumulated)
    clarificationAnswers: text("clarification_answers"),

    title: text("title"),
    prdMarkdown: text("prd_markdown"),
    generationError: text("generation_error"),

    viewCount: integer("view_count").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    index("fpr_email_idx").on(t.email),
    index("fpr_status_idx").on(t.status),
    index("fpr_priority_idx").on(t.priority),
  ]
);
