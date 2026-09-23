/** Bind request context without mutating shared tool definitions across chats. */
export function withConversationContext(tools: Record<string, any>, conversationId: string, userId: string): Record<string, any> {
  const bound = { ...tools };
  const activeEpics = new Map<string, string>();
  const builds = new Set(['queueTicketExecution', 'retryTicket', 'startBuildRun']);
  for (const name of ['createTickets', 'startEpic', 'addToEpic', 'createTicket', ...builds, 'streamDocumentContent', 'previewPage']) {
    const tool = tools[name];
    if (!tool || typeof tool.execute !== 'function') continue;
    bound[name] = { ...tool, execute: async (args: Record<string, any>, opts: unknown) => {
      const isDoc = name === 'streamDocumentContent' || name === 'previewPage';
      const context = isDoc || name === 'startEpic' ? await import('../../services/document-epic-context.ts') : null;
      const epicId = args.epicId || activeEpics.get(args.projectId) || (isDoc && args.projectId
        ? await context!.conversationEpic(args.projectId, conversationId) : undefined);
      const result = await tool.execute({ ...args, conversationId,
        ...(builds.has(name) || isDoc || name === 'startEpic' ? {userId} : {}),
        ...(isDoc && epicId ? {epicId} : {}),
      }, opts);
      if (isDoc && result?.saved && result.id && !epicId) {
        await context!.rememberPendingDocument(args.projectId, conversationId, result.id);
      }
      if (name === 'startEpic' && result?.epicId) {
        activeEpics.set(args.projectId, result.epicId);
        await context!.linkPendingDocuments(args.projectId, conversationId, result.epicId, userId);
      }
      return result;
    }};
  }
  return bound;
}
