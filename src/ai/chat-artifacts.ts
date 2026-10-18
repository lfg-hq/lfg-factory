import type { ChatArtifact } from '../types/chat-artifact.ts';

/** Only successful, saved tool results become durable chat references. */
export function savedChatArtifact(tool: string, output: Record<string, unknown> | undefined, callId: string): ChatArtifact | null {
  if (!output || output.error) return null;
  if (['streamDocumentContent', 'updateFileContent', 'patchFileContent'].includes(tool)) {
    if (!(output.saved === true || output.success === true) || typeof output.id !== 'string' || !output.id) return null;
    return {kind:'document', id:output.id, name:typeof output.name === 'string' ? output.name : 'Document', fileType:typeof output.fileType === 'string' ? output.fileType : 'document'};
  }
  if (tool === 'createTickets' && Array.isArray(output.tickets)) {
    const tickets = output.tickets.filter(t => t && typeof t.id === 'string' && t.id).map(t => ({id:t.id, name:typeof t.name === 'string' ? t.name : 'Ticket', ticketKey:typeof t.ticketKey === 'string' ? t.ticketKey : null}));
    if (!tickets.length) return null;
    return {kind:'tickets',id:callId,name:typeof output.name === 'string' ? output.name : 'Created tickets',tickets};
  }
  return null;
}
