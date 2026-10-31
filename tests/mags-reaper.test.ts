import { test, expect } from 'bun:test';
import { reapable } from '../src/services/mags-reaper.ts';

const now = Date.parse('2026-10-31T12:00:00Z');
const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString();

test('deletes idle leftovers, keeps previews, active VMs and anything LFG still uses', () => {
  const list = [
    { workspace_id: 'clone-failed-copy', last_used: ago(3) },          // failed copy, idle 3h
    { workspace_id: 'code-2512e00b-1', last_used: ago(1) },            // fresh VM, idle 1h: not yet
    { workspace_id: 'claude-auth-abc', last_used: ago(24 * 200) },     // old sign-in VM
    { workspace_id: 'instant-abc', last_used: ago(30) },               // idle 30h: not yet (2 days)
    { workspace_id: 'pv-de3ce3d4', last_used: ago(24 * 30) },          // preview: always kept
    { workspace_id: 'clone-busy', last_used: ago(100), has_active: true },
    { workspace_id: 'clone-held-edits', last_used: ago(100) },         // LFG still points at it
    { workspace_id: 'mystery', last_used: null },                      // unknown age: kept
  ];
  expect(reapable(list, new Set(['clone-held-edits']), now)).toEqual(['claude-auth-abc', 'clone-failed-copy']);
});
