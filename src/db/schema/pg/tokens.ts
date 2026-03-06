import {
  pgTable,
  text,
  integer,
  real,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";

export const tokenUsage = pgTable(
  "token_usage",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: text("project_id"),
    conversationId: text("conversation_id"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    timestamp: timestamp("timestamp", { mode: "date" }).notNull().default(sql`now()`),
    requestId: text("request_id"),
    cost: real("cost"),
  },
  (t) => [
    index("tu_user_ts_idx").on(t.userId, t.timestamp),
    index("tu_project_ts_idx").on(t.projectId, t.timestamp),
    index("tu_conv_ts_idx").on(t.conversationId, t.timestamp),
    index("tu_provider_model_idx").on(t.provider, t.model),
  ]
);
