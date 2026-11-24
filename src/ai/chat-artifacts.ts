import type { ChatArtifact } from '../types/chat-artifact.ts';

/** Only successful, saved tool results become durable chat references. */
export function savedChatArtifact(tool: string, output: Record<string, unknown> | undefined, callId: string): ChatArtifact | null {
  if (!output || output.error) return null;
  if (['streamDocumentContent', 'updateFileContent', 'patchFileContent'].includes(tool)) {
    if (!(output.saved === true || output.success === true) || typeof output.id !== 'string' || !output.id) return null;
    return {kind:'document', id:output.id, name:typeof output.name === 'string' ? output.name : 'Document', fileType:typeof output.fileType === 'string' ? output.fileType : 'document',
      ...(typeof output.previousVersion === 'number' && output.previousVersion > 0 ? {previousVersion:output.previousVersion} : {})};
  }
  // A board the agent created or drew on: one card per board, however many times it drew.
  if (['createWhiteboard', 'drawOnWhiteboard'].includes(tool)) {
    if (output.saved !== true || typeof output.boardId !== 'string' || !output.boardId) return null;
    return {kind:'board', id:output.boardId, name:typeof output.title === 'string' && output.title ? output.title : 'Whiteboard'};
  }
  // An eval suite the agent wrote, changed or started running: one card per suite, with its Run button and results table.
  if (['saveEvalSuite', 'runEvals'].includes(tool)) {
    if (!(output.saved === true || output.started === true) || typeof output.suiteId !== 'string' || !output.suiteId) return null;
    return {kind:'evals', id:output.suiteId, name:typeof output.name === 'string' && output.name ? output.name : 'Evals'};
  }
  // A build shows one live card following every ticket it builds.
  if (tool === 'startBuildRun' && typeof output.runId === 'string' && output.runId && Array.isArray(output.ticketIds)) {
    const ticketIds = output.ticketIds.filter((id): id is string => typeof id === 'string' && !!id);
    return ticketIds.length ? {kind:'build_run', id:output.runId, name:'Build', ticketIds} : null;
  }
  if (['queueTicketExecution','sendTicketMessage'].includes(tool) && output.success === true && typeof output.ticketId === 'string') {
    return {kind:'build_run', id:'ticket-'+output.ticketId+'-'+callId, name:'Build', ticketIds:[output.ticketId]};
  }
  // A quick change creates one ticket and builds it; a retry rebuilds one. Both get the live card.
  if (tool === 'quickChange' && typeof output.ticketId === 'string' && output.ticketId && ['queued', 'running', 'executing'].includes(String(output.status))) {
    return {kind:'build_run', id:typeof output.runId === 'string' && output.runId ? output.runId : 'ticket-'+output.ticketId+'-'+callId, name:'Build', ticketIds:[output.ticketId]};
  }
  if (tool === 'retryTicket' && typeof output.ticketId === 'string' && output.ticketId && (output.success === true || output.queued === true || output.status === 'queued')) {
    return {kind:'build_run', id:'ticket-'+output.ticketId+'-'+callId, name:'Build', ticketIds:[output.ticketId]};
  }
  if (tool === 'createTickets' && Array.isArray(output.tickets)) {
    const tickets = output.tickets.filter(t => t && typeof t.id === 'string' && t.id).map(t => ({id:t.id, name:typeof t.name === 'string' ? t.name : 'Ticket', ticketKey:typeof t.ticketKey === 'string' ? t.ticketKey : null,
      ...(Array.isArray(t.dependsOn) && t.dependsOn.length ? {dependsOn:t.dependsOn.filter((d: unknown): d is string => typeof d === 'string')} : {})}));
    if (!tickets.length) return null;
    return {kind:'tickets',id:callId,name:typeof output.name === 'string' ? output.name : 'Created tickets',tickets};
  }
  return null;
}
