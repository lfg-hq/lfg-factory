/**
 * Projects whose app source the agent has read in a turn, kept for the whole turn.
 * A chat on someone's computer reaches these tools over MCP, which binds them afresh
 * for every request, so a per-binding flag was gone by the next call and previewPage
 * refused every mockup. Keyed by conversation, turn and project; dropped after 2 hours.
 */
const designSourceReads = new Map<string, number>();
const SOURCE_READ_TTL_MS = 2 * 60 * 60_000;
const sourceKey = (conversationId: string, turnId: string | undefined, projectId: string) => `${conversationId}|${turnId ?? ''}|${projectId}`;
function rememberSourceRead(key: string) {
  const now = Date.now();
  for (const [k, at] of designSourceReads) if (now - at > SOURCE_READ_TTL_MS) designSourceReads.delete(k);
  designSourceReads.set(key, now);
}
const sourceWasRead = (key: string) => { const at = designSourceReads.get(key); return at !== undefined && Date.now() - at <= SOURCE_READ_TTL_MS; };

/** Bind request context without mutating shared tool definitions across chats. */
export function withConversationContext(tools: Record<string, any>, conversationId: string, userId: string, projectId?: string | null, turnId?: string, opts: { localCheckout?: boolean } = {}): Record<string, any> {
  const bound = { ...tools };
  const activeEpics = new Map<string, string>();
  const builds = new Set(['queueTicketExecution', 'retryTicket', 'startBuildRun']);
  for (const name of Object.keys(tools)) {
    const tool = tools[name];
    if (!tool || typeof tool.execute !== 'function') continue;
    // This tool already captures server-owned identity in previewActionTool's
    // closure. Injecting context into its strict operation payload rejects valid
    // requests (including password resets) before they reach the executor.
    if (name === 'handlePreview') continue;
    bound[name] = { ...tool, execute: async (args: Record<string, any>, callOpts: unknown) => {
      args = { ...args, ...(projectId && 'projectId' in args ? { projectId } : {}) };
      const isDoc = name === 'streamDocumentContent' || name === 'previewPage';
      const context = isDoc || name === 'startEpic' ? await import('../../services/document-epic-context.ts') : null;
      // Only a feature's own docs follow the chat's epic by default; anything else is filed
      // under an epic only when the agent passes one.
      const inferEpic = !isDoc || (name === 'streamDocumentContent' ? context!.isFeatureDocType(args.fileType) : true);
      const epicId = args.epicId || (inferEpic ? activeEpics.get(args.projectId) || (isDoc && args.projectId
        ? await context!.conversationEpic(args.projectId, conversationId) : undefined) : undefined);
      const result = await tool.execute({ ...args, conversationId,
        ...(['sendTicketMessage','getTicketOperationStatus'].includes(name) ? {projectId,userId,turnId} : {}),
        ...(name === 'createTickets' ? {turnId} : {}),
        ...(builds.has(name) || isDoc || name === 'startEpic' || name === 'readDesignSource' || name === 'captureDesignLayout' || name === 'queryCodebase' ? {userId} : {}),
        ...(isDoc && epicId ? {epicId} : {}),
      }, { ...(callOpts as object), designSourceRead: !!args.projectId && sourceWasRead(sourceKey(conversationId, turnId, args.projectId)), localCheckout: !!opts.localCheckout });
      if (name === 'readDesignSource' && args.projectId && result?.commit && result.files?.length && result.files.every((file: any) => typeof file.content === 'string' && file.content.trim())) rememberSourceRead(sourceKey(conversationId, turnId, args.projectId));
      if (isDoc && inferEpic && result?.saved && result.id && !epicId) {
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
