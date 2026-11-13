import { pgTable, text, integer, doublePrecision, timestamp, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";
import { conversations } from "./chat.ts";

// ── Meetings ─────────────────────────────────────────────────────────
// One row per call the LFG agent was added to. The agent's work in the call lands in
// `conversationId`, a normal chat owned by the person who added it.
// status: joining | waiting_room | in_call | ended | failed.
// projectId holds the PUBLIC project id, the same value conversation.project_id stores.
export const meetings = pgTable(
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
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    startedAt: timestamp("started_at", { mode: "date" }),
    endedAt: timestamp("ended_at", { mode: "date" }),
  },
  (t) => [index("meeting_user_idx").on(t.userId), index("meeting_project_idx").on(t.projectId), index("meeting_bot_idx").on(t.botId)]
);

// What was said (kind = speech) or typed in the meeting chat (kind = chat), in order.
export const meetingSegments = pgTable(
  "meeting_segment",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    meetingId: text("meeting_id").notNull().references(() => meetings.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull().default("speech"), // speech | chat | agent
    speaker: text("speaker").notNull().default("Someone"),
    text: text("text").notNull(),
    // Seconds from the start of the call, when known.
    offsetSeconds: doublePrecision("offset_seconds"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [index("meeting_segment_meeting_idx").on(t.meetingId, t.seq)]
);
