import { expect, mock, test } from 'bun:test';
const commands: string[] = [];
mock.module('../src/services/mags.ts', () => ({execOnWorkspace: async (_id:string, command:string) => {
  commands.push(command); return {exitCode:0,output:' M saved-work.ts\n?? notes.txt\n'};
}}));
const {resolveTurnOutcome} = await import('../src/services/ticket-chat-turn.ts');

test('answering a question preserves saved edits and never cleans or publishes the checkout', async () => {
  const result = await resolveTurnOutcome({ticketId:'ticket',workspaceId:'vm',projectDir:'/data/a project',replyText:'Here is the status.\nLFG_TURN: answer'});
  expect(result.mode).toBe('answer');
  expect(result.preservedEdits).toBe(true);
  expect(commands).toHaveLength(1);
  expect(commands[0]).toContain("cd '/data/a project'");
  expect(commands[0]).not.toMatch(/git (clean|checkout|reset|push|commit)/);
});
