// TEST-ONLY PostgreSQL schema, always removed. Does not change application rows.
import { test, expect } from 'bun:test';
import { Pool } from 'pg';
import { env } from '../src/config/env.ts';
import { getTableColumns } from 'drizzle-orm';
import { gitMutations } from '../src/db/schema/pg/git-mutations.ts';
test('PostgreSQL additive mutation schema preserves rows and prevents duplicate operation/ref claims', async () => {
  if (env.DATABASE_DRIVER !== 'postgresql') throw Error('Requires the configured local PostgreSQL database');
  const pool = new Pool({ connectionString: env.POSTGRES_URL, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
  const schema = `git_safety_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const client = await pool.connect(); let created = false;
  try {
    await client.query(`CREATE SCHEMA "${schema}"`); created = true;
    await client.query(`SET search_path TO "${schema}"`);
    await client.query("CREATE TABLE project(id text PRIMARY KEY); INSERT INTO project VALUES ('test-only-project')");
    await client.query(await Bun.file('drizzle/pg/0002_git_mutations.sql').text());
    expect((await client.query('SELECT count(*)::int as n FROM project')).rows[0].n).toBe(1);
    const columns = await client.query('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2', [schema, 'git_mutations']);
    expect(columns.rows.map(c => c.column_name).sort()).toEqual(Object.values(getTableColumns(gitMutations)).map(c => c.name).sort());
    const insert = (id: string, key: string, active: string) => client.query(`INSERT INTO git_mutations(id,operation_key,active_key,project_id,actor_id,repo,provider,type,head_ref,base_ref,head_sha,base_sha,status,correlation_id,created_at,updated_at,acknowledged_at) VALUES($1,$2,$3,'test-only-project','test-only-user','fixture/repo','github','merge','feature','main','head','base','started','test-only-correlation',now(),now(),now()) ON CONFLICT DO NOTHING RETURNING id`, [id, key, active]);
    expect((await insert('one', 'key', 'ref')).rowCount).toBe(1);
    expect((await insert('two', 'key', 'other-ref')).rowCount).toBe(0);
    expect((await insert('three', 'new-key', 'ref')).rowCount).toBe(0);
  } finally {
    await client.query('SET search_path TO public');
    if (created) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    client.release(); await pool.end();
  }
}, 20_000);
