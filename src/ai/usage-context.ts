import { AsyncLocalStorage } from "node:async_hooks";

export interface UsageContext {
  cliOutputs?: Array<{ workspaceId: string; outputFile: string }>;
  userId: string;
  projectId?: string | null;
  conversationId?: string | null;
  ticketId?: string | null;
  runId?: string | null;
  operation?: string;
  billingMode?: string;
  ticketIds?: Set<string>;
  documentIds?: Set<string>;
  toolUsage?: Map<string, string>;
}
const storage = new AsyncLocalStorage<UsageContext>();
export const currentUsage = () => storage.getStore();
export function withUsage<T>(context: UsageContext, run: () => T): T {
  return storage.run({ documentIds: new Set(), ticketIds: new Set(), toolUsage: new Map(), ...context }, run);
}
export function withUsageOperation<T>(operation: string, run: () => T): T {
  const context = currentUsage();
  return context ? withUsage({ ...context, operation, ...(operation === "title" ? { documentIds: new Set<string>(), ticketIds: new Set<string>() } : {}) }, run) : run();
}
