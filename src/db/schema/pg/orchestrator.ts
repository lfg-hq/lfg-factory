import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.ts";
import { projects } from "./projects.ts";

export const agentRuns = pgTable(
  "agent_run",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    conversationId: text("conversation_id").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    triggerMessage: text("trigger_message").notNull(),
    runType: text("run_type").notNull().default("direct_response"),
    plan: jsonb("plan").default({}),
    status: text("status").notNull().default("planning"),
    orchestratorMessages: jsonb("orchestrator_messages").default([]),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().default(sql`now()`),
    completedAt: timestamp("completed_at", { mode: "date" }),
  },
  (t) => [
    index("ar_conv_status_idx").on(t.conversationId, t.status),
    index("ar_project_status_idx").on(t.projectId, t.status),
  ]
);

export const ticketExecutions = pgTable(
  "ticket_execution",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    agentRunId: text("agent_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    ticketId: text("ticket_id"),
    title: text("title").notNull(),
    description: text("description").notNull(),
    executionType: text("execution_type").notNull(),
    status: text("status").notNull().default("queued"),
    sequenceNumber: integer("sequence_number").notNull().default(0),
    workerContext: jsonb("worker_context").default({}),
    result: jsonb("result"),
    blockedReason: text("blocked_reason"),
    blockedQuestion: text("blocked_question"),
    userResponse: text("user_response"),
    taskId: text("task_id"),
    workerType: text("worker_type"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
    startedAt: timestamp("started_at", { mode: "date" }),
    completedAt: timestamp("completed_at", { mode: "date" }),
  },
  (t) => [
    index("te_run_status_idx").on(t.agentRunId, t.status),
    index("te_status_seq_idx").on(t.status, t.sequenceNumber),
  ]
);

export const ticketExecutionDependencies = pgTable(
  "ticket_execution_dependency",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    executionId: text("execution_id")
      .notNull()
      .references(() => ticketExecutions.id, { onDelete: "cascade" }),
    dependsOnId: text("depends_on_id")
      .notNull()
      .references(() => ticketExecutions.id, { onDelete: "cascade" }),
  },
  (t) => [index("ted_exec_idx").on(t.executionId)]
);

export const agentEvents = pgTable(
  "agent_event",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    agentRunId: text("agent_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    ticketExecutionId: text("ticket_execution_id").references(
      () => ticketExecutions.id,
      { onDelete: "set null" }
    ),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").default({}),
    requiresUserAction: boolean("requires_user_action").notNull().default(false),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().default(sql`now()`),
  },
  (t) => [
    index("ae_run_type_idx").on(t.agentRunId, t.eventType),
    index("ae_user_action_idx").on(t.requiresUserAction, t.createdAt),
  ]
);
