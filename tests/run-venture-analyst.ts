// TEST-ONLY isolated SQLite runner; inherits .env/process settings, never copies secrets.
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const temp = await mkdtemp(join(tmpdir(), 'venture-analyst-tests-'));
try {
  const env = { ...process.env, DATABASE_DRIVER: 'sqlite', DATABASE_URL: join(temp, 'test.db'), VENTURE_TEST_ISOLATED: '1', NODE_ENV: 'test', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GOOGLE_AI_API_KEY: '', EXA_API_KEY: '' };
  for (const command of [['bun', 'run', 'db:migrate'], ['bun', 'test', 'tests/venture.test.ts'], ['bun', 'test', 'tests/venture-analyst.test.ts'], ['bun', 'test', 'tests/venture-public-url.test.ts'], ['bun', 'test', 'tests/venture-oauth.test.ts', 'tests/venture-defaults.test.ts']]) {
    const child = Bun.spawn(command, { env, stdout: 'inherit', stderr: 'inherit' });
    if (await child.exited !== 0) throw new Error(`Failed: ${command.join(' ')}`);
  }
} finally { await rm(temp, { recursive: true, force: true }); }
