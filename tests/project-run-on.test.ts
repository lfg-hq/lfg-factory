import { describe, test, expect, mock } from 'bun:test';

let local = { enabled: true, agent: 'claude' as const };
mock.module('../src/services/runner/opt-in.ts', () => ({ localAiSettings: async () => local }));
const { resolveBuildTarget, projectRunOn } = await import('../src/services/runner/build-target.ts');

describe('project "where builds run" setting', () => {
  test('parses only known values', () => {
    expect(projectRunOn('cloud')).toBe('cloud'); expect(projectRunOn('computer')).toBe('computer');
    expect(projectRunOn('')).toBe(null); expect(projectRunOn(undefined)).toBe(null); expect(projectRunOn('x')).toBe(null);
  });
  test('project sandbox wins over the person\'s computer setting', async () => {
    local = { enabled: true, agent: 'claude' };
    expect(await resolveBuildTarget('u', {}, 'cloud')).toEqual({ where: 'cloud' });
  });
  test('a ticket pinned to an agent still builds on the computer', async () => {
    local = { enabled: true, agent: 'claude' };
    expect(await resolveBuildTarget('u', { buildWith: 'codex' }, 'cloud')).toEqual({ where: 'computer', agent: 'codex' });
  });
  test('no project setting follows the person', async () => {
    local = { enabled: true, agent: 'claude' };
    expect(await resolveBuildTarget('u', {}, null)).toEqual({ where: 'computer', agent: 'claude' });
  });
  test('project computer without Desktop falls back to cloud with a reason', async () => {
    local = { enabled: false, agent: 'claude' };
    const t = await resolveBuildTarget('u', {}, 'computer');
    expect(t.where).toBe('cloud'); expect((t as { reason?: string }).reason).toContain('project is set to build on your computer');
  });
});
