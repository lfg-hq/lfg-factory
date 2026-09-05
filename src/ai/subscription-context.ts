import { AsyncLocalStorage } from "node:async_hooks";

export interface SubscriptionExecution {
  modelId: string;
  getAccessToken: () => Promise<string>;
}

// Scoped to one async agent turn (including its tool-triggered helper calls).
// Never enterWith(): concurrent requests must not inherit another user's context.
const execution = new AsyncLocalStorage<SubscriptionExecution | undefined>();
export const currentSubscription = () => execution.getStore();
export function withSubscription<T>(context: SubscriptionExecution, run: () => T): T {
  return execution.run(context, run);
}
export function withoutSubscription<T>(run: () => T): T {
  return execution.run(undefined, run);
}
