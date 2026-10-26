import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

// Tickets open with the problem in plain words, not narration of the chat.
const skill = readFileSync(new URL('../src/ai/skills/ticket-delivery.md', import.meta.url), 'utf8');
const tools = readFileSync(new URL('../src/ai/tools/ticket-tools.ts', import.meta.url), 'utf8');
const quick = readFileSync(new URL('../src/ai/tools/quick-change-tools.ts', import.meta.url), 'utf8');

test('the ticket template starts with Problem and Goal', () => {
  expect(skill.indexOf('## Problem')).toBeLessThan(skill.indexOf('## Goal'));
  expect(skill.indexOf('## Goal')).toBeLessThan(skill.indexOf('## Implementation Notes'));
  expect(skill).not.toContain('## Overview');
});
test('tickets never narrate the conversation', () => {
  expect(skill).toContain('Never narrate the conversation');
});
test('createTickets and quickChange ask for the same sections', () => {
  for (const source of [tools, quick]) {
    expect(source).toContain('## Problem (what is wrong');
    expect(source).toContain('## Goal (what will be true when done');
  }
});
