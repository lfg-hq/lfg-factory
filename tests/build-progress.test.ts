import { test, expect } from 'bun:test';
import { ticketStage, latestUpdate } from '../src/services/build-progress.ts';
const logs = (...lines: string[]) => lines.map(text => ({ text, type: 'command' }));

test('stage follows the build from queue to review', () => {
  expect(ticketStage({ status: 'open', queueStatus: 'none' }, [])).toBe('waiting');
  expect(ticketStage({ status: 'open', queueStatus: 'queued' }, [])).toBe('queued');
  const running = { status: 'in_progress', queueStatus: 'executing' };
  expect(ticketStage(running, logs('Isolated build: spinning up a fresh sandbox'))).toBe('building');
  expect(ticketStage(running, logs('**Build saved:** commit `abc1234` is pushed', 'Isolated build: x'))).toBe('committed');
  expect(ticketStage(running, logs('[Validation] Checking an HTTP response', '**Build saved:** commit'))).toBe('checking');
  expect(ticketStage(running, logs('[Validation] Browser: click', '[Validation] Reading application files'))).toBe('testing');
  expect(ticketStage(running, logs('**Repairing runtime checks:** sign-in rejected', '[Validation] Browser: click'))).toBe('repairing');
  expect(ticketStage({ status: 'review', queueStatus: 'none' }, [])).toBe('ready');
  expect(ticketStage({ status: 'blocked', queueStatus: 'none' }, [])).toBe('failed');
});

test('update skips tool chatter and keeps one readable sentence', () => {
  expect(latestUpdate(logs('[Validation] Reading application files', '[Validation] Editing a file',
    '[Validation] The first browser sign-in was rejected because `.env` names localhost as the trusted origin. I will fix it.'))).toBe(
    'The first browser sign-in was rejected because .env names localhost as the trusted origin.');
  expect(latestUpdate(logs('Running npm audit --omit=dev', 'Successfully replaced 4 block(s) in src/a.ts.'))).toBeNull();
  expect(latestUpdate(logs('x'.repeat(400)))!.length).toBeLessThanOrEqual(158);
});
