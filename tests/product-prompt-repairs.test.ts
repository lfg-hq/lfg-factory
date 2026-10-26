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
test('provider failures are isolated by testing the provider directly', () => {
  expect(prompt).toContain('find which side is wrong before anything else, by testing the provider directly with runInPreview');
  expect(prompt).toContain('Never ask the user to check a dashboard for something the provider\'s API can tell you.');
});
test('no repeated display-only fixes; re-test after a fix publishes', () => {
  expect(prompt).toContain('Do not queue another fix that only changes how an error is displayed while its cause is still unknown.');
  expect(prompt).toContain('re-run the check that found the problem before calling it fixed');
});
