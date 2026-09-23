import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

// Exercise the actual message switch branch without opening a live chat.
const source = readFileSync('public/js/chat.js', 'utf8');
const branch = source.slice(source.indexOf("case 'message':"), source.indexOf("case 'ai_chunk':"));
const deliver = new Function('data', 'currentConversationId', 'currentProjectId', `
 let delivered = 0;
 const addMessageToChat = () => delivered++;
 const scrollToBottom = () => {};
 switch (data.type) { ${branch} }
 return delivered;
`);
test('build messages only render in the initiating chat, including when a new chat is open', () => {
 const data = {type:'message',build_status:true,conversation_id:'chat-a',project_id:'project'};
 expect(deliver(data,'chat-a','project')).toBe(1);
 expect(deliver(data,'chat-b','project')).toBe(0);
 expect(deliver(data,null,'project')).toBe(0);
 expect(deliver({...data,conversation_id:null},'chat-a','project')).toBe(0);
 expect(deliver(data,'chat-a','different-project')).toBe(0);
});
test('ordinary chat messages keep their existing behavior', () => {
 expect(deliver({type:'message',message:'Hello'},'chat-a','project')).toBe(1);
});
