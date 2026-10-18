import { expect, test } from 'bun:test';
import { ticketRetryMode } from '../src/services/ticket-retry-mode.ts';

test('retry resumes integration of published code, while implementation failures rebuild', () => {
  expect(ticketRetryMode({githubMergeStatus:'pushed', githubCommitSha:'abc123'})).toBe('merge');
  expect(ticketRetryMode({githubMergeStatus:'failed', githubCommitSha:null})).toBe('build');
  expect(ticketRetryMode({githubMergeStatus:'pushed', githubCommitSha:null})).toBe('build');
  expect(ticketRetryMode({githubMergeStatus:'merged', githubCommitSha:'abc123'})).toBe('build');
  expect(ticketRetryMode({githubMergeStatus:'pushed', githubCommitSha:'abc123'}, 'build')).toBe('build');
});
