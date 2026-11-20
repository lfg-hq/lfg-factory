// The agent answers document comments: a reply lands in the thread marked as the agent's,
// can resolve it, and can't reach comments on another project's documents.
import { test, expect, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { readFileSync } from 'node:fs';

const sqlite = new Database(':memory:');
sqlite.exec(`CREATE TABLE user(id TEXT PRIMARY KEY);
  INSERT INTO user VALUES ('u1');
  CREATE TABLE project_file(id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
  INSERT INTO project_file VALUES ('f1', 'p1'), ('f2', 'p2');
  CREATE TABLE document_comment(id TEXT PRIMARY KEY, file_id TEXT NOT NULL, user_id TEXT NOT NULL, selected_text TEXT NOT NULL,
    range_start INTEGER NOT NULL, range_end INTEGER NOT NULL, content TEXT NOT NULL, parent_id TEXT,
    is_resolved INTEGER NOT NULL DEFAULT 0, resolved_by_id TEXT, resolved_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()));`);
// The shipped migration adds the column, so the test also checks it.
sqlite.exec(readFileSync(new URL('../drizzle/manual/20261121-comment-by-agent-sqlite.sql', import.meta.url), 'utf8'));
sqlite.exec(`INSERT INTO document_comment(id, file_id, user_id, selected_text, range_start, range_end, content) VALUES
  ('c1', 'f1', 'u1', 'the diagram', 10, 21, 'What is this? Need a better diagram'),
  ('c2', 'f2', 'u1', 'other', 0, 5, 'Someone else''s project');`);
// The table definitions follow DATABASE_DRIVER (a developer's .env may say postgresql).
process.env.DATABASE_DRIVER = 'sqlite';
const db = drizzle(sqlite);
mock.module('../src/config/db.ts', () => ({ db }));
const { replyToComment } = await import('../src/ai/tools/comment-tools.ts');
const ctx = { projectId: 'p1', userId: 'u1' };

test('the reply joins the thread as the agent, and resolves it when asked', async () => {
  const r = await replyToComment(db as any, ctx, { commentId: 'c1', reply: 'Replaced it with a five-step diagram.', resolve: true });
  expect(r).toMatchObject({ replied: true, threadId: 'c1', resolved: true });
  const reply = sqlite.query(`SELECT * FROM document_comment WHERE parent_id = 'c1'`).get() as any;
  expect(reply).toMatchObject({ by_agent: 1, user_id: 'u1', selected_text: 'the diagram', content: 'Replaced it with a five-step diagram.' });
  expect((sqlite.query(`SELECT is_resolved FROM document_comment WHERE id = 'c1'`).get() as any).is_resolved).toBe(1);
});

test('a reply to a reply goes into the same thread', async () => {
  const replyId = (sqlite.query(`SELECT id FROM document_comment WHERE parent_id = 'c1'`).get() as any).id;
  const r = await replyToComment(db as any, ctx, { commentId: replyId, reply: 'Also tidied the labels.' });
  expect(r).toMatchObject({ replied: true, threadId: 'c1' });
});

test("another project's comments are out of reach", async () => {
  const r = await replyToComment(db as any, ctx, { commentId: 'c2', reply: 'Hi' });
  expect(r.replied).toBe(false);
  expect(sqlite.query(`SELECT count(*) AS n FROM document_comment WHERE parent_id = 'c2'`).get()).toEqual({ n: 0 });
});
