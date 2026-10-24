import { test, expect } from 'bun:test';
import { parseWorkJournal } from '../src/services/ticket-operations.ts';

test('bold-label journal with bullets', () => {
  const r = parseWorkJournal(`**Changed**:
- Moved the approval checkbox beside its label on the Test Call page
- Rendered the JD as Markdown (headings, bold, lists)
**Verified**: ran the page tests; all passed
**Open**: none
**Setup notes**: dev server on port 3000`);
  expect(r.changed).toEqual(['Moved the approval checkbox beside its label on the Test Call page', 'Rendered the JD as Markdown (headings, bold, lists)']);
  expect(r.verified).toEqual(['ran the page tests; all passed']);
  expect(r.open).toEqual([]);
});

test('Markdown headings and numbered items', () => {
  const r = parseWorkJournal(`## Changed
1. Added signed callback tokens for synthetic calls
2) Kept IP checks for real candidates
## Open
- Exotel 401 still needs valid credentials`);
  expect(r.changed).toEqual(['Added signed callback tokens for synthetic calls', 'Kept IP checks for real candidates']);
  expect(r.open).toEqual(['Exotel 401 still needs valid credentials']);
});

test('free text outside known sections is ignored, long lines are capped', () => {
  const r = parseWorkJournal('Some preamble\n- **Changed**: ' + 'x'.repeat(400));
  expect(r.changed[0]!.length).toBeLessThanOrEqual(218);
  expect(r.verified).toEqual([]);
});
