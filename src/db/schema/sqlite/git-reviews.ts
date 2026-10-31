import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { projects } from './projects.ts';
import { users } from './users.ts';

export const gitReviews = sqliteTable('git_reviews', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  actorId: text('actor_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(), repo: text('repo').notNull(),
  headRef: text('head_ref').notNull(), baseRef: text('base_ref').notNull(),
  headSha: text('head_sha').notNull(), baseSha: text('base_sha').notNull(),
  status: text('status').notNull(), attempt: integer('attempt').notNull().default(0),
  leaseId: text('lease_id'), leaseUntil: integer('lease_until', { mode: 'timestamp' }),
  nextAttemptAt: integer('next_attempt_at', { mode: 'timestamp' }).notNull(),
  startedAt: integer('started_at', { mode: 'timestamp' }), completedAt: integer('completed_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(), updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  findings: text('findings'), coverage: text('coverage'), summary: text('summary'), limitations: text('limitations'),
  model: text('model'), modelProvider: text('model_provider'), providerRequestId: text('provider_request_id'),
  errorCode: text('error_code'), correlationId: text('correlation_id').notNull(),
}, t => [index('git_reviews_queue_idx').on(t.status, t.nextAttemptAt), index('git_reviews_project_idx').on(t.projectId, t.createdAt)]);

export const gitOperations = sqliteTable('git_operations', {
  id: text('id').primaryKey(), operationKey: text('operation_key').notNull(), activeKey: text('active_key'),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  actorId: text('actor_id').notNull(), reviewId: text('review_id').notNull().references(() => gitReviews.id, { onDelete: 'cascade' }),
  repo: text('repo').notNull(), provider: text('provider').notNull(), type: text('type').notNull(),
  headRef: text('head_ref').notNull(), baseRef: text('base_ref').notNull(), headSha: text('head_sha').notNull(), baseSha: text('base_sha').notNull(),
  acknowledgedAt: integer('acknowledged_at', { mode: 'timestamp' }).notNull(),
  status: text('status').notNull(), result: text('result'), errorCode: text('error_code'), providerRequestId: text('provider_request_id'),
  correlationId: text('correlation_id').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(), updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, t => [uniqueIndex('git_operations_key_idx').on(t.operationKey), uniqueIndex('git_operations_active_idx').on(t.activeKey)]);
