import { test, expect } from 'bun:test';
import { parseReview } from '../src/services/pr-review.ts';

const review = { verdict: 'needs_changes', summary: 'Adds limits.', findings: [{ severity: 'major', file: 'a.ts', line: 3, title: 'Off by one', detail: 'x' }], checked: ['AC1'], title: 'Add limits', body: '## Summary' };

test('parses a bare JSON answer, a fenced one, and one with prose around it', () => {
  expect(parseReview(JSON.stringify(review))?.findings[0]!.title).toBe('Off by one');
  expect(parseReview('Here you go:\n```json\n' + JSON.stringify(review) + '\n```')?.verdict).toBe('needs_changes');
  expect(parseReview('Review done. ' + JSON.stringify(review) + ' Thanks')?.title).toBe('Add limits');
});

test('rejects answers that are not a review', () => {
  expect(parseReview('Looks good to me!')).toBeNull();
  expect(parseReview(JSON.stringify({ verdict: 'great' }))).toBeNull();
});
