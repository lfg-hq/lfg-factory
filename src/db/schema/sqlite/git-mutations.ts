import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { projects } from './projects.ts';
import { users } from './users.ts';

export const gitMutations = sqliteTable('git_mutations', {
  id: text('id').primaryKey(), operationKey: text('operation_key').notNull(), activeKey: text('active_key'),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  actorId: text('actor_id').notNull(),
  repo: text('repo').notNull(), provider: text('provider').notNull(), type: text('type').notNull(),
  headRef: text('head_ref').notNull(), baseRef: text('base_ref').notNull(), headSha: text('head_sha').notNull(), baseSha: text('base_sha').notNull(),
  acknowledgedAt: integer('acknowledged_at', { mode: 'timestamp' }).notNull(),
  status: text('status').notNull(), result: text('result'), errorCode: text('error_code'), providerRequestId: text('provider_request_id'),
  correlationId: text('correlation_id').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(), updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, t => [uniqueIndex('git_mutations_key_idx').on(t.operationKey), uniqueIndex('git_mutations_active_idx').on(t.activeKey)]);
