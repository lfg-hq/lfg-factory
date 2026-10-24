import { test, expect } from 'bun:test';
import { getProductSystemPrompt } from '../src/ai/prompts/product.ts';

const prompt = getProductSystemPrompt({});
test('a defect found while verifying is the agent\'s to fix in the same turn', () => {
  expect(prompt).toContain('A defect you find is yours to fix');
  expect(prompt).toContain('queue the fix in the same turn');
  expect(prompt).toContain('A defect you found while testing or verifying is a repair.');
  expect(prompt).toContain('Repairing a defect in code that is already built needs no new approval.');
});
test('testing no longer excludes a repair', () => {
  expect(prompt).not.toContain('add, build, expose, test or set up');
});
