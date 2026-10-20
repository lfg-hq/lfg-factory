import type { ChatArtifact } from '../types/chat-artifact.ts';

/** Only successful, saved tool results become durable chat references. */
export function savedChatArtifact(tool: string, output: Record<string, unknown> | undefined, callId: string): ChatArtifact | null {
  if (!output || output.error) return null;
  if (['streamDocumentContent', 'updateFileContent', 'patchFileContent'].includes(tool)) {
    if (!(output.saved === true || output.success === true) || typeof output.id !== 'string' || !output.id) return null;
    return {kind:'document', id:output.id, name:typeof output.name === 'string' ? output.name : 'Document', fileType:typeof output.fileType === 'string' ? output.fileType : 'document',
      ...(typeof output.previousVersion === 'number' && output.previousVersion > 0 ? {previousVersion:output.previousVersion} : {})};
  }
  // A build shows one live card following every ticket it builds.
  if (tool === 'startBuildRun' && typeof output.runId === 'string' && output.runId && Array.isArray(output.ticketIds)) {
    const ticketIds = output.ticketIds.filter((id): id is string => typeof id === 'string' && !!id);
    return ticketIds.length ? {kind:'build_run', id:output.runId, name:'Build', ticketIds} : null;
  }
  if (['queueTicketExecution','sendTicketMessage'].includes(tool) && output.success === true && typeof output.ticketId === 'string') {
    return {kind:'build_run', id:'ticket-'+output.ticketId+'-'+callId, name:'Build', ticketIds:[output.ticketId]};
  }
  if (tool === 'createTickets' && Array.isArray(output.tickets)) {
    const tickets = output.tickets.filter(t => t && typeof t.id === 'string' && t.id).map(t => ({id:t.id, name:typeof t.name === 'string' ? t.name : 'Ticket', ticketKey:typeof t.ticketKey === 'string' ? t.ticketKey : null}));
    if (!tickets.length) return null;
    return {kind:'tickets',id:callId,name:typeof output.name === 'string' ? output.name : 'Created tickets',tickets};
  }
  return null;
}
