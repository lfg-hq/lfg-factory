import { describe, test, expect } from 'bun:test';
import { vmReleasedDisk, RELEASE_SETTLE_MS } from '../src/services/project-sandbox.ts';

const now = Date.parse('2026-11-19T12:00:00Z');
const ago = (ms: number) => new Date(now - ms).toISOString();

describe('vmReleasedDisk', () => {
  test('completed long ago is released', () => expect(vmReleasedDisk({ status: 'completed', completed_at: ago(3 * 86400_000) }, now)).toBe(true));
  test('completed moments ago is not yet', () => expect(vmReleasedDisk({ status: 'completed', completed_at: ago(60_000) }, now)).toBe(false));
  test('just past the settle window is released', () => expect(vmReleasedDisk({ status: 'stopped', completed_at: ago(RELEASE_SETTLE_MS + 1000) }, now)).toBe(true));
  test('no completion time is not proof', () => expect(vmReleasedDisk({ status: 'completed' }, now)).toBe(false));
  test('a running job is never released', () => expect(vmReleasedDisk({ status: 'running', completed_at: ago(86400_000) }, now)).toBe(false));
});
