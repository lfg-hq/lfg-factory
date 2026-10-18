import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dockerBringup } from '../src/services/database-bringup.ts';

function run(mode: string) {
  const root = mkdtempSync(join(tmpdir(), 'database-safety-'));
  const data = join(root, 'db'); mkdirSync(data);
  writeFileSync(join(data, 'valuable-data'), 'keep me');
  const trace = join(root, 'calls'); writeFileSync(trace, '');
  writeFileSync(join(root, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(root, 'docker'), `#!/bin/sh
echo "$*" >> "$TRACE"
case "$1" in
info) echo ready;;
ps) if [ "$MODE" != create-fail ] && [ "$MODE" != fresh ]; then echo postgres; fi
    case "$MODE" in port|shared) echo recovered;; esac;;
inspect)
  case "$3" in
  *HostPort*) [ "$MODE" = port ] && [ "$4" = recovered ] && echo 5432; exit 0;;
  *State.Status*) case "$MODE" in stopped) echo exited;; *) echo running;; esac;;
  *) if [ "$MODE" = mount ]; then echo /wrong; elif [ "$4" = recovered ] && [ "$MODE" != shared ]; then echo /other; else echo "$DATA"; fi;;
  esac;;
start) if [ "$MODE" = start-fail ]; then echo 'Bind for 127.0.0.1:5432 failed: port is already allocated' >&2; exit 1; fi;;
run) if [ "$MODE" = fresh ]; then echo new-container; else echo 'address already in use' >&2; exit 1; fi;;
logs) echo 'database diagnostic';;
exec)
  if [ "$3" = ready ]; then
    if [ "$MODE" = timeout ]; then echo 'still starting'; else echo accepting; fi
  else
    if [ "$MODE" = auth ]; then echo 'password authentication failed' >&2; exit 1; fi
    echo 1
  fi;;
*) echo 'UNEXPECTED MUTATION' >&2; exit 99;;
esac
`, { mode: 0o755 });
  if (mode === 'locked') mkdirSync(data + '.lfg-start.lock');
  const script = dockerBringup({ name: 'postgres', image: 'postgres:16-alpine', port: 5432,
    volume: data + ':/var/lib/postgresql/data', readyProbe: 'docker exec postgres ready',
    readyGrep: 'accepting', authProbe: 'docker exec postgres auth' });
  try {
    const result = spawnSync('sh', ['-c', script], { env: { ...process.env, PATH: root + ':' + process.env.PATH, MODE: mode, DATA: data, TRACE: trace }, encoding: 'utf8', timeout: 10000 });
    const calls = readFileSync(trace, 'utf8');
    expect(readFileSync(join(data, 'valuable-data'), 'utf8')).toBe('keep me');
    expect(calls).not.toMatch(/^(rm|stop|kill) /m);
    return { output: result.stdout + result.stderr, status: result.status, calls };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

for (const [mode, error] of [
  ['port', 'already reserves database port'], ['shared', 'already uses the database directory'],
  ['mount', 'unexpected database mount'], ['start-fail', 'port is already allocated'],
  ['create-fail', 'address already in use'], ['stopped', 'container is exited'],
  ['auth', 'password authentication failed'], ['timeout', 'readiness timed out'],
  ['locked', 'startup lock exists'],
]) test(`${mode}: preserves data and reports the real failure`, () => {
  const r = run(mode!); expect(r.status).toBe(1); expect(r.output).toContain(error!);
  expect(r.output).toContain('ENGINE_ERROR'); expect(r.output).not.toContain('ENGINE_READY');
  if (['port', 'shared', 'mount', 'locked'].includes(mode!)) expect(r.calls).not.toMatch(/^(start|run) /m);
  if (['stopped', 'start-fail', 'create-fail', 'timeout'].includes(mode!)) expect(r.calls).not.toContain('exec postgres auth');
});

test('healthy existing database is checked without recreation', () => {
  const r = run('healthy'); expect(r.status).toBe(0); expect(r.output).toContain('ENGINE_READY');
  expect(r.calls).toContain('exec postgres auth'); expect(r.calls).not.toMatch(/^run /m);
});

test('a new container can start without deleting an existing data directory', () => {
  const r = run('fresh'); expect(r.status).toBe(0); expect(r.output).toContain('ENGINE_READY');
  expect(r.calls).toMatch(/^run /m); expect(r.calls).toContain('exec postgres auth');
});
