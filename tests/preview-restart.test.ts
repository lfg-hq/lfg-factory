import { expect, test } from 'bun:test';
import { restartWorktree, restartServerCommand, waitForRestart } from '../src/services/preview-restart.ts';
import { shellQuote } from '../src/services/preview-plan.ts';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

const worktrees = 'worktree /data/project\nHEAD abc\nbranch refs/heads/main\n\nworktree /data/wt-epic\nHEAD def\nbranch refs/heads/epic/inv-e1\n\nworktree /data/gone\nHEAD 123\nbranch refs/heads/gone\nprunable gitdir missing\n';
test('restart targets the active epic, default, or checkout-mode branch without substituting main', () => {
  expect(restartWorktree(worktrees, 'epic/inv-e1')).toBe('/data/wt-epic');
  expect(restartWorktree(worktrees, '(default)')).toBe('/data/project');
  expect(restartWorktree(worktrees.replace('refs/heads/main', 'refs/heads/checkout-mode'), 'checkout-mode')).toBe('/data/project');
  expect(() => restartWorktree(worktrees, 'missing')).toThrow('checkout is missing');
  expect(() => restartWorktree(worktrees, 'gone')).toThrow('checkout is missing');
});

function readiness(sequence: Array<{code: number; exited: boolean}>, cancelAfterProbe = false) {
  let now = 0, probes = 0, cancelled = false;
  return {
    deps: { probe: async () => { probes++; cancelled = cancelAfterProbe; return sequence.shift() || {code: 0, exited: false}; },
      now: () => now, sleep: async (ms: number) => { now += ms; }, cancelled: () => cancelled, progress: () => {} },
    probes: () => probes, elapsed: () => now,
  };
}
test('warm readiness succeeds immediately, also for a login redirect', async () => {
  const r = readiness([{code: 307, exited: false}]);
  await waitForRestart(r.deps);
  expect(r.probes()).toBe(1); expect(r.elapsed()).toBe(0);
});
test('startup crash fails promptly rather than triggering repairs or waiting a minute', async () => {
  const r = readiness([{code: 0, exited: true}]);
  await expect(waitForRestart(r.deps)).rejects.toThrow('start command exited');
  expect(r.probes()).toBe(1);
});
test('HTTP server errors do not count as a healthy restart', async () => {
  const r = readiness([{code: 500, exited: false}]);
  await expect(waitForRestart(r.deps)).rejects.toThrow('HTTP 500');
});
test('silent startup times out at 60 seconds without a recovery cycle', async () => {
  const r = readiness([]);
  await expect(waitForRestart(r.deps)).rejects.toThrow('60 seconds');
  expect(r.elapsed()).toBe(60_000);
});
test('Stop wins over a simultaneous successful probe', async () => {
  const r = readiness([{code: 200, exited: false}], true);
  await expect(waitForRestart(r.deps)).rejects.toThrow('__CANCELLED__');
});

test('actual launch script sources existing environment and preserves files, records failure, and quotes paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'preview-restart-'));
  const dir = join(root, "checkout's directory");
  const bin = join(root, 'bin');
  mkdirSync(dir); mkdirSync(bin); mkdirSync(join(dir, '.git'));
  // Substitute only Linux process utilities so the production script can run on macOS.
  writeFileSync(join(bin, 'setsid'), '#!/bin/sh\nexec "$@"\n', {mode: 0o755});
  writeFileSync(join(bin, 'fuser'), '#!/bin/sh\nexit 1\n', {mode: 0o755});
  writeFileSync(join(dir, '.env'), "TEST_VALUE='retained environment'\n");
  writeFileSync(join(dir, 'local-repair.txt'), 'unsaved login fix');
  writeFileSync(join(dir, 'build-output'), 'existing build');
  const exit = join(dir, 'unique.exit');
  try {
    const cmd = restartServerCommand(dir, 18080, 'printf "%s" "$TEST_VALUE"; exit 42', `set -a; . ${shellQuote(join(dir, '.env'))}; set +a;`, 'preview.log', exit);
    const launched = spawnSync('sh', ['-c', cmd], {encoding: 'utf8', env: {...process.env, PATH: bin + ':' + process.env.PATH}});
    expect(launched.status).toBe(0);
    for (let i = 0; i < 100 && !existsSync(exit); i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(readFileSync(exit, 'utf8').trim()).toBe('42');
    expect(readFileSync(join(dir, 'preview.log'), 'utf8')).toBe('retained environment');
    expect(readFileSync(join(dir, 'local-repair.txt'), 'utf8')).toBe('unsaved login fix');
    expect(readFileSync(join(dir, 'build-output'), 'utf8')).toBe('existing build');
    const missing = spawnSync('sh', ['-c', restartServerCommand(join(root, 'missing'), 18080, 'touch should-not-exist', '')], {encoding: 'utf8'});
    expect(missing.status).not.toBe(0);
    expect(missing.stdout).toContain('checkout is missing');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('actual UI sends ordinary restart and branch updates as distinct actions', async () => {
  const js = readFileSync(new URL('../public/js/preview-tab.js', import.meta.url), 'utf8');
  const start = js.slice(js.indexOf('  async function doRestart('), js.indexOf('  // HARD rebuild:'));
  const branch = js.slice(js.indexOf('  async function doRunBranch('), js.indexOf('  function onActionClick('));
  const requests: any[] = [], renders: any[] = [];
  const context = vm.createContext({stateVersion: 0, branches: [{id: 'epic:e1', branch: 'epic/inv-e1'}], branchId: 'epic:e1', currentView: 'running',
    window: {currentConversationId: 'conversation'}, setSub: () => {}, logText: '', render: (s: any) => renders.push(s), managePolling: () => {},
    api: async (_path: string, options: any) => { requests.push(JSON.parse(options.body)); return {ok: true}; }});
  vm.runInContext(start + branch, context);
  await vm.runInContext('doRestart()', context);
  expect(requests[0].refresh).toBe(false);
  await vm.runInContext('doRunBranch("epic:e1")', context);
  expect(requests[1]).toMatchObject({refresh: true, branch: 'epic/inv-e1'});
  await vm.runInContext('doRestart(true)', context);
  expect(requests[2].refresh).toBe(true);
});
