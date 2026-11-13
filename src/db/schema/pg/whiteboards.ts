import { pgTable, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";

// ── Whiteboards ──────────────────────────────────────────────────────
// A freeform canvas for a project. `elements` is a JSON array of everything on the board
// (shapes, notes, strokes, comments); each element carries `v`, the board version at which
// it last changed, so a browser can ask for only what changed since the version it has.
// projectId holds the PUBLIC project id, the same value conversation.project_id stores.
export const whiteboards = pgTable(
  "whiteboard",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id").notNull(),
    title: text("title").notNull().default("Untitled board"),
    elements: text("elements").notNull().default("[]"),
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [index("whiteboard_project_idx").on(t.projectId)]
);

// The conversation with the agent on a board, oldest first.
export const whiteboardMessages = pgTable(
  "whiteboard_message",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    boardId: text("board_id").notNull().references(() => whiteboards.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    userId: text("user_id"),
    role: text("role").notNull(), // user | assistant
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [index("whiteboard_message_board_idx").on(t.boardId, t.seq)]
);
