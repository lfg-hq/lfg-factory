import { test, expect } from 'bun:test';
import { withConversationContext } from '../src/ai/tools/conversation-context.ts';
test('server context overrides model origin without leaking between concurrent chats', async () => {
 const execute = async (args: any) => args;
 const tools = {queueTicketExecution:{execute},retryTicket:{execute},startBuildRun:{execute}};
 const a = withConversationContext(tools,'chat-a','user-a');
 const b = withConversationContext(tools,'chat-b','user-b');
 for (const name of Object.keys(tools)) {
   expect(await a[name].execute({conversationId:'wrong',userId:'wrong'},{})).toEqual({conversationId:'chat-a',userId:'user-a'});
   expect(await b[name].execute({},{})).toEqual({conversationId:'chat-b',userId:'user-b'});
 }
 expect(tools.queueTicketExecution.execute).toBe(execute);
});
