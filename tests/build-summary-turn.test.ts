import { test, expect } from 'bun:test';
import { buildEventMessage } from '../src/services/build-summary-turn.ts';

test('completed run asks for a summary and testing steps without granting new work', () => {
  const message = buildEventMessage({ kind: 'complete', tickets: ['APP-1 Auth', 'APP-2 Dashboard'], previewUrl: 'https://preview.test', branch: 'epic/app' });
  expect(message).toContain('not a message from the user');
  expect(message).toContain('not approval for new work');
  expect(message).toContain('APP-1 Auth, APP-2 Dashboard');
  expect(message).toContain('https://preview.test (branch epic/app)');
  expect(message).toContain('testing it in the preview');
  expect(message).toContain('Do not start builds');
});

test('paused run asks for the cause and a recommended fix before any retry', () => {
  const message = buildEventMessage({ kind: 'paused', tickets: ['APP-2'], detail: '1 ticket still queued behind it.' });
  expect(message).toContain('paused because a ticket failed');
  expect(message).toContain('1 ticket still queued');
  expect(message).toContain('Ask before retrying');
  expect(message).not.toContain('Preview:');
});
