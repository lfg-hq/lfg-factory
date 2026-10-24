import { test, expect, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { previewRunScript } from '../src/services/dev-preview.ts';

let repo = '', scratch = '', tmp = '';
const sh = (script: string) => spawnSync('sh', ['-c', script], { encoding: 'utf8' }).stdout;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'lfg-app-')); scratch = mkdtempSync(join(tmpdir(), 'lfg-scratch-')); tmp = mkdtempSync(join(tmpdir(), 'lfg-tmp-'));
  spawnSync('git', ['init', '-q', repo]); writeFileSync(join(repo, 'app.js'), 'x');
  spawnSync('git', ['-C', repo, 'add', '.']); spawnSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
});
const build = (run: string, cwd = repo, timeout = 10) => previewRunScript({ prefix: 'export GREETING=hello; ', dir: repo, cwd, prepare: '', run, timeout, tmp });

test('runs in the app checkout with settings loaded and reports the exit code', () => {
  const out = sh(build('echo "$GREETING from $(basename $PWD)"; exit 3'));
  expect(out).toContain('hello from ' + repo.split('/').pop());
  expect(out).toContain('__LFG_EXIT=3');
  expect(out).not.toContain('__LFG_CHANGED');
});

test('a change to the served checkout is reported with the file', () => {
  const out = sh(build('echo y > app.js; echo new > extra.txt'));
  expect(out).toContain('__LFG_CHANGED');
  expect(out).toContain('app.js');
  expect(out).toContain('extra.txt');
});

test('scratch work does not count as an app change', () => {
  const out = sh(build('echo data > result.json; cat result.json', scratch));
  expect(out).toContain('data');
  expect(out).not.toContain('__LFG_CHANGED');
});

test('a command past its timeout is stopped', () => {
  const out = sh(build('sleep 5', repo, 1));
  expect(out).toContain('__LFG_EXIT=124');
});
