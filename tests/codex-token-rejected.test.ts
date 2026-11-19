import { test, expect, mock } from 'bun:test';
mock.module('../src/config/db.ts', () => ({ db: {} }));
const { tokenRejected, planRejectsModel } = await import('../src/workers/ticket-executor.ts');

test('recognises OpenAI rejecting a revoked ChatGPT token', () => {
  expect(tokenRejected('Pi build failed: Your authentication token has expired. Please try refreshing it.')).toBe(true);
  expect(tokenRejected('{"error":{"code":"token_expired"}}')).toBe(true);
  expect(tokenRejected('Error: refresh_token_reused')).toBe(true);
});
test('leaves other failures alone', () => {
  expect(tokenRejected('npm ERR! code ERESOLVE')).toBe(false);
  expect(tokenRejected("The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account")).toBe(false);
  expect(planRejectsModel("The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account")).toBe(true);
});
