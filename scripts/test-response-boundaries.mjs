import fs from 'node:fs';
import assert from 'node:assert/strict';
const src = fs.readFileSync('src/ai/stream-handler.ts', 'utf8');
const start = src.indexOf('          if (beginsTextBlock) {');
const end = src.indexOf('          const now = Date.now();', start);
assert(start >= 0 && end > start);
const execute = new Function('events', `
  let beginsTextBlock = true, fullResponse = '', chunkBuffer = '';
  const sent = [];
  const flush = () => { if (chunkBuffer) sent.push({ text: chunkBuffer }); chunkBuffer = ''; };
  const ws = { send: raw => sent.push(JSON.parse(raw)) };
  for (const event of events) {
    if (event.start) beginsTextBlock = true;
    ${src.slice(start, end)}
  }
  flush();
  return { fullResponse, sent };
`);
const result = execute([
  { text: 'Let me merge ' }, { text: 'them into one ticket.' },
  { start: true, text: 'Now let me update the main ticket to cover everything:' },
  { start: true, text: 'Done.' },
]);
assert.equal(result.fullResponse, 'Let me merge them into one ticket.\n\nNow let me update the main ticket to cover everything:\n\nDone.');
assert.equal(result.sent.filter(e => e.notification_type === 'text_boundary').length, 3);
assert.equal(result.sent.filter(e => e.text).length, 3);
console.log('Model steps have distinct response boundaries; token fragments within a step remain contiguous.');
