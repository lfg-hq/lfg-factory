import {test,expect} from 'bun:test';
import {savedChatArtifact} from '../src/ai/chat-artifacts.ts';
test('failed document writes cannot claim to be saved',()=>{
 expect(savedChatArtifact('streamDocumentContent',{saved:false,id:'d'},'call')).toBeNull();
 expect(savedChatArtifact('updateFileContent',{success:true,id:'d',error:'failed'},'call')).toBeNull();
});
test('create and revision results preserve the canonical document identity',()=>{
 const expected={kind:'document',id:'d',name:'Requirements',fileType:'prd'};
 expect(savedChatArtifact('streamDocumentContent',{saved:true,id:'d',name:'Requirements',fileType:'prd'},'a')).toEqual(expected);
 expect(savedChatArtifact('patchFileContent',{success:true,id:'d',name:'Requirements',fileType:'prd'},'b')).toEqual(expected);
});
test('ticket groups contain only saved references, never arbitrary tool fields',()=>{
 const output={name:'Recruiting',tickets:[{id:'t',name:'Consent',ticketKey:'REC-1',secret:'omit'},null,{}]};
 const card=savedChatArtifact('createTickets',output,'batch');
 expect(card).toEqual({kind:'tickets',id:'batch',name:'Recruiting',tickets:[{id:'t',name:'Consent',ticketKey:'REC-1'}]});
 expect(savedChatArtifact('createTickets',{tickets:[{}]},'batch')).toBeNull();
 expect(savedChatArtifact('getFileContent',{id:'d'},'batch')).toBeNull();
});
test('document revisions carry the version they replaced so the card can show changes',()=>{
 expect(savedChatArtifact('patchFileContent',{success:true,id:'d',name:'Requirements',fileType:'prd',previousVersion:4},'c')).toEqual({kind:'document',id:'d',name:'Requirements',fileType:'prd',previousVersion:4});
 expect(savedChatArtifact('streamDocumentContent',{saved:true,id:'d',name:'Requirements',fileType:'prd',previousVersion:0},'c')).not.toHaveProperty('previousVersion');
});

test('every way of starting a build gets the live build card', async () => {
  const { savedChatArtifact } = await import('../src/ai/chat-artifacts.ts');
  expect(savedChatArtifact('quickChange', { runId: 'run-1', ticketId: 't6', ticketKey: 'REC-6', status: 'queued' }, 'c1')).toEqual({ kind: 'build_run', id: 'run-1', name: 'Build', ticketIds: ['t6'] });
  expect(savedChatArtifact('quickChange', { ticketId: 't6', status: 'review', note: 'already completed' }, 'c1')).toBeNull();
  expect(savedChatArtifact('retryTicket', { success: true, ticketId: 't3', note: 'Ticket queued for execution' }, 'c2')).toMatchObject({ kind: 'build_run', ticketIds: ['t3'] });
});
