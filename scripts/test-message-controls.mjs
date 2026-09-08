import fs from 'node:fs';
import assert from 'node:assert/strict';
const src = fs.readFileSync('public/js/chat.js', 'utf8');
const start = src.indexOf('    function updateMessageDisplay(');
const end = src.indexOf('    function finishMessageDisplay(', start);
const update = new Function(src.slice(start, end) + '; return updateMessageDisplay;')();
const classes = new Set();
const content = { scrollHeight: 700 };
const toggle = { setAttribute(k, v) { this[k] = v; } };
const message = {
  isConnected: true, dataset: {},
  classList: { toggle: (key, yes) => yes ? classes.add(key) : classes.delete(key) },
  querySelector: selector => selector === '.message-content' ? content : toggle,
};
update(message);
assert(classes.has('message-collapsed'));
assert.equal(toggle.textContent, 'Show more');
assert.equal(toggle['aria-expanded'], 'false');
message.dataset.expanded = 'true';
update(message);
assert(!classes.has('message-collapsed'));
assert.equal(toggle.textContent, 'Show less');
message.dataset.expanded = 'false';
message.dataset.streaming = 'true';
update(message);
assert(!classes.has('message-collapsed'));
assert.equal(toggle.hidden, true);
message.dataset.streaming = 'false';
update(message);
assert(classes.has('message-collapsed'));
content.scrollHeight = 80;
update(message);
assert(!classes.has('message-collapsed'));
assert.equal(toggle.hidden, true);
// Execute the actual top-button handler; the bottom button uses the same source.
const handler = src.match(/copyButton.onclick = function\(\) \{([\s\S]*?)\n        \};/)[1];
let raw = 'First token';
const copies = [];
const copy = new Function('contentDiv', 'copyMessageToClipboard', handler);
const el = { getAttribute: () => raw };
copy(el, text => copies.push(text));
raw = 'Full completed message, including hidden collapsed content.';
copy(el, text => copies.push(text));
assert.deepEqual(copies, ['First token', raw]);
assert(src.includes("bottomCopy.onclick = function() { copyMessageToClipboard(contentDiv.getAttribute('data-raw-content') || '', this); }"));
console.log('Long/short messages, expansion, streaming, accessibility state, and full-message copy passed.');
