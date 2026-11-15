import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";
import { conversations } from "./chat.ts";

// ── Meetings ─────────────────────────────────────────────────────────
// One row per call the LFG agent was added to. The agent's work in the call lands in
// `conversationId`, a normal chat owned by the person who added it.
// status: joining | waiting_room | in_call | ended | failed.
// projectId holds the PUBLIC project id, the same value conversation.project_id stores.
export const meetings = sqliteTable(
  "meeting",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id"),
    conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    title: text("title").notNull().default("Meeting"),
    meetingUrl: text("meeting_url").notNull(),
    platform: text("platform").notNull().default("google_meet"),
    provider: text("provider").notNull().default("mags_browser"),
    botId: text("bot_id"),
    status: text("status").notNull().default("joining"),
    statusDetail: text("status_detail"),
    // Segments up to this sequence number have been handed to the chat agent as context.
    contextSeq: integer("context_seq").notNull().default(0),
    // The agent's end-of-call recap (also posted in the meeting's chat), for the project Home.
    recap: text("recap"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    startedAt: integer("started_at", { mode: "timestamp" }),
    endedAt: integer("ended_at", { mode: "timestamp" }),
  },
  (t) => [index("meeting_user_idx").on(t.userId), index("meeting_project_idx").on(t.projectId), index("meeting_bot_idx").on(t.botId)]
);

// What was said (kind = speech) or typed in the meeting chat (kind = chat), in order.
export const meetingSegments = sqliteTable(
  "meeting_segment",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    meetingId: text("meeting_id").notNull().references(() => meetings.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull().default("speech"), // speech | chat | agent
    speaker: text("speaker").notNull().default("Someone"),
    text: text("text").notNull(),
    // Seconds from the start of the call, when known.
    offsetSeconds: real("offset_seconds"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [index("meeting_segment_meeting_idx").on(t.meetingId, t.seq)]
);

// ── Meeting bot seats ────────────────────────────────────────────────
// The pool of browsers the meeting bot joins calls from. A seat is one Mags workspace
// holding one Chrome profile, signed in once to one Google account (`account`). One seat
// is in one call at a time, so the pool's size is how many calls LFG can be in at once.
// A seat is taken by writing `holder` (a meeting id, or "sign-in:<user id>") with a lease
// that the holding server renews while it works; a lease that ran out is free again, so a
// crashed server never strands a seat.
// state: ready | needs_sign_in | disabled.
export const meetingBotSeats = sqliteTable(
  "meeting_bot_seat",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    workspace: text("workspace").notNull().unique(),
    account: text("account").notNull().default(""),
    state: text("state").notNull().default("needs_sign_in"),
    holder: text("holder"),
    leaseUntil: integer("lease_until", { mode: "timestamp" }),
    lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
    lastError: text("last_error"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [index("meeting_bot_seat_state_idx").on(t.state)]
);
