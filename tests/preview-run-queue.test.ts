import { test, expect } from 'bun:test';
import { PreviewRunQueue } from '../src/services/preview-run-queue.ts';

test('a project is active while a run holds the queue, and idle after release', async () => {
  const queue = new PreviewRunQueue();
  expect(queue.isActive('p')).toBe(false);
  const release = await queue.acquire('p');
  expect(queue.isActive('p')).toBe(true);
  release();
  expect(queue.isActive('p')).toBe(false);
});
