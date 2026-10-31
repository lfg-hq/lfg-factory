// TEST-ONLY PostgreSQL fixtures in a uniquely named schema, always removed.
// Runs against the application's resolved local .env database; no public rows changed.
import { test, expect } from 'bun:test';
import { Pool } from 'pg';
import { env } from '../src/config/env.ts';
import { readFileSync } from 'node:fs';
import { getTableColumns } from 'drizzle-orm';
import { gitReviews, gitOperations } from '../src/db/schema/pg/git-reviews.ts';

test('PostgreSQL additive migration, atomic review claims and unique operation keys', async () => {
  if (env.DATABASE_DRIVER !== 'postgresql') throw new Error('This check requires the selected PostgreSQL development service. Run SQLite tests separately.');
  const pool = new Pool({ connectionString: env.POSTGRES_URL, max: 2, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
  const schema = `git_review_test_${crypto.randomUUID().replaceAll('-', '')}`;
  let created = false;
  try {
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`); created = true;
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(`CREATE TABLE project(id text PRIMARY KEY); CREATE TABLE "user"(id text PRIMARY KEY); INSERT INTO project VALUES ('test-only-project'); INSERT INTO "user" VALUES ('test-only-user')`);
      const migration = readFileSync('drizzle/pg/0001_git_reviews.sql', 'utf8').replaceAll('"public".', `"${schema}".`);
      await client.query(migration);
      expect((await client.query('SELECT count(*)::int AS n FROM project')).rows[0].n).toBe(1);
      for (const [name, table] of [['git_reviews', gitReviews], ['git_operations', gitOperations]] as const) {
        const columns = await client.query('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2', [schema, name]);
        expect(columns.rows.map(c => c.column_name).sort()).toEqual(Object.values(getTableColumns(table)).map(c => c.name).sort());
      }
      await client.query(`INSERT INTO git_reviews (id,project_id,actor_id,provider,repo,head_ref,base_ref,head_sha,base_sha,status,next_attempt_at,created_at,updated_at,correlation_id) VALUES ('test-only-review','test-only-project','test-only-user','github','test-only-repo','feature','main',$1,$2,'queued',now(),now(),now(),'test-only-correlation')`, ['a'.repeat(40), 'b'.repeat(40)]);
    } finally { await client.query('SET search_path TO public'); client.release(); }
    const claims = await Promise.all([1, 2].map(i => pool.query(`UPDATE "${schema}".git_reviews SET status='running',attempt=attempt+1,lease_id=$1,lease_until=now()+interval '3 minutes' WHERE id='test-only-review' AND status='queued' RETURNING id`, [`test-only-lease-${i}`])));
    expect(claims.reduce((n, r) => n + r.rowCount!, 0)).toBe(1);
    const results = await Promise.all([1, 2].map(i => pool.query(`INSERT INTO "${schema}".git_operations (id,operation_key,project_id,actor_id,review_id,repo,provider,type,head_ref,base_ref,head_sha,base_sha,status,correlation_id,created_at,updated_at,acknowledged_at) VALUES ($1,'test-only-key','test-only-project','test-only-user','test-only-review','test-only-repo','github','create_pr','feature','main',$2,$3,'started','test-only-correlation',now(),now(),now()) ON CONFLICT DO NOTHING RETURNING id`, [`test-only-op-${i}`, 'a'.repeat(40), 'b'.repeat(40)])));
    expect(results.reduce((n, r) => n + r.rowCount!, 0)).toBe(1);
    await pool.query(`DELETE FROM "${schema}".git_operations`);
    const locks = await Promise.all([1, 2].map(i => pool.query(`INSERT INTO "${schema}".git_operations (id,operation_key,active_key,project_id,actor_id,review_id,repo,provider,type,head_ref,base_ref,head_sha,base_sha,status,correlation_id,created_at,updated_at,acknowledged_at) VALUES ($1,$1,'test-only-pair','test-only-project','test-only-user','test-only-review','test-only-repo','github','create_pr','feature','main',$2,$3,'started','test-only-correlation',now(),now(),now()) ON CONFLICT DO NOTHING RETURNING id`, [`test-only-active-${i}`, 'a'.repeat(40), 'b'.repeat(40)])));
    expect(locks.reduce((n, r) => n + r.rowCount!, 0)).toBe(1);
  } finally {
    if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
}, 20_000);
