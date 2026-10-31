import { pgTable, text, integer, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { projects } from './projects.ts';
import { users } from './users.ts';

export const gitReviews = pgTable('git_reviews', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  actorId: text('actor_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(), repo: text('repo').notNull(),
  headRef: text('head_ref').notNull(), baseRef: text('base_ref').notNull(),
  headSha: text('head_sha').notNull(), baseSha: text('base_sha').notNull(),
  status: text('status').notNull(), attempt: integer('attempt').notNull().default(0),
  leaseId: text('lease_id'), leaseUntil: timestamp('lease_until', { mode: 'date' }),
  nextAttemptAt: timestamp('next_attempt_at', { mode: 'date' }).notNull(),
  startedAt: timestamp('started_at', { mode: 'date' }), completedAt: timestamp('completed_at', { mode: 'date' }),
  createdAt: timestamp('created_at', { mode: 'date' }).notNull(), updatedAt: timestamp('updated_at', { mode: 'date' }).notNull(),
  findings: text('findings'), coverage: text('coverage'), summary: text('summary'), limitations: text('limitations'),
  model: text('model'), modelProvider: text('model_provider'), providerRequestId: text('provider_request_id'),
  errorCode: text('error_code'), correlationId: text('correlation_id').notNull(),
}, t => [index('git_reviews_queue_idx').on(t.status, t.nextAttemptAt), index('git_reviews_project_idx').on(t.projectId, t.createdAt)]);

export const gitOperations = pgTable('git_operations', {
  id: text('id').primaryKey(), operationKey: text('operation_key').notNull(), activeKey: text('active_key'),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  actorId: text('actor_id').notNull(), reviewId: text('review_id').notNull().references(() => gitReviews.id, { onDelete: 'cascade' }),
  repo: text('repo').notNull(), provider: text('provider').notNull(), type: text('type').notNull(),
  headRef: text('head_ref').notNull(), baseRef: text('base_ref').notNull(), headSha: text('head_sha').notNull(), baseSha: text('base_sha').notNull(),
  acknowledgedAt: timestamp('acknowledged_at', { mode: 'date' }).notNull(),
  status: text('status').notNull(), result: text('result'), errorCode: text('error_code'), providerRequestId: text('provider_request_id'),
  correlationId: text('correlation_id').notNull(),
  createdAt: timestamp('created_at', { mode: 'date' }).notNull(), updatedAt: timestamp('updated_at', { mode: 'date' }).notNull(),
}, t => [uniqueIndex('git_operations_key_idx').on(t.operationKey), uniqueIndex('git_operations_active_idx').on(t.activeKey)]);
