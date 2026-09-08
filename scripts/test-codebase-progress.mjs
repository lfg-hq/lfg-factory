// Exercise the actual per-turn progress callback without credentials or network.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const source = fs.readFileSync('src/ai/stream-handler.ts', 'utf8');
const start = source.indexOf('codebaseProgress: (detail: string, warning = false) => {');
assert(start >= 0);
const bodyStart = source.indexOf('\n', start);
const end = source.indexOf('\n        },', bodyStart);
const report = new Function('abortController', 'req', 'noteActivity', 'ws', 'detail', 'warning', source.slice(bodyStart, end));
function turn() {
  const controller = new AbortController();
  const events = [], trail = [];
  let activity = 0;
  return {
    events, trail, controller,
    progress: (detail, warning = false) => report(controller, { onActivity: () => activity++ },
      (...args) => trail.push(args), { send: raw => events.push(JSON.parse(raw)) }, detail, warning),
    activity: () => activity,
  };
}
const apiTurn = turn(), subscriptionTurn = turn();
apiTurn.progress('Reading src/index.ts');
subscriptionTurn.progress('Repository scan failed', true);
assert.equal(apiTurn.events.length, 1);
assert.equal(subscriptionTurn.events.length, 1);
assert.equal(apiTurn.events[0].detail, 'Reading src/index.ts');
assert.equal(apiTurn.events[0].notification_type, 'tool_detail');
assert.equal(subscriptionTurn.events[0].warning, true);
assert.equal(subscriptionTurn.trail[0][2], true);
assert.equal(apiTurn.activity(), 1);
subscriptionTurn.controller.abort();
subscriptionTurn.progress('Late update');
assert.equal(subscriptionTurn.events.length, 1);
assert.equal(subscriptionTurn.activity(), 1);
assert(source.includes('end_reason: endReason'));
assert(source.includes('case "tool-error":'));
console.log('Progress is scoped to each turn, records warnings, reports activity, and ignores cancelled work.');
