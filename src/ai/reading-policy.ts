/** Per-turn only: never shares document content, credentials, or results across users. */
export function readingTools(tools: Record<string, any>, message: string) {
  const next = { ...tools };
  const documentFirst = /\b(report|audit|document|overview)\b/i.test(message)
    && /\b(read|review|summari[sz]e|suggest|suggestions|feedback)\b/i.test(message)
    && !/\b(verify|source|repository|scan)\b/i.test(message);
  let documentRead = false;
  let failedScans = 0;
  const queries = new Map<string, Promise<any>>();
  if (tools.getFileContent?.execute) next.getFileContent = {
    ...tools.getFileContent,
    execute: async (...args: any[]) => {
      const result = await tools.getFileContent.execute(...args);
      if (result?.found) documentRead = true;
      return result;
    },
  };
  if (tools.queryCodebase?.execute) next.queryCodebase = {
    ...tools.queryCodebase,
    execute: async (input: any, options: any) => {
      if (documentFirst && tools.getFileContent?.execute && !documentRead) return { error: 'Read the requested saved document first using getFileList and getFileContent. Answer from that document; inspect source only if necessary to verify a specific point.' };
      const key = JSON.stringify([input.projectId, input.ticketId, input.branch, input.question?.trim().toLowerCase().replace(/\s+/g, ' ')]);
      if (queries.has(key)) return queries.get(key);
      if (failedScans >= 2) return { error: 'Two repository investigations were incomplete. Stop scanning and answer using saved documents and partial findings. Clearly state what remains unverified.' };
      const result = Promise.resolve().then(() => tools.queryCodebase.execute(input, options)).then(value => {
        if (value?.error || value?.warning) failedScans++;
        return value;
      });
      queries.set(key, result);
      return result;
    },
  };
  return next;
}

export const READING_INSTRUCTIONS = `
## Reading and investigation policy
When asked to review a saved report, audit, overview, or document, list project files and read that document FIRST.
Give useful document-based recommendations without making repository inspection a prerequisite.
Only query source for specific verification gaps; narrow to relevant folders/files. Never repeat a failed broad scan unchanged.
If inspection is incomplete, return the findings you already have, label them as partial and state exactly what remains unverified.
Do not claim documents or files were read unless a tool actually returned their contents.
`;
