import type { JobInfo } from './types.ts';

/** Never infer that a disk is free from a timeout, missing lookup, or job status. */
export async function ensureProjectVm(options: {
  mayCreate: boolean;
  find: () => Promise<JobInfo | null>;
  probe: (job: JobInfo) => Promise<void>;
  create: () => Promise<unknown>;
}): Promise<{ created: boolean }> {
  let job = await options.find(); // Lookup errors must not become permission to create.
  if (!job && options.mayCreate) {
    try {
      await options.create();
      return { created: true };
    } catch (error) {
      // A timed-out POST/poll may have created a VM. Reconcile, never submit again.
      job = await options.find();
      if (!job || !['running', 'sleeping'].includes(job.status)) {
        throw new Error(`Sandbox creation is unresolved; no replacement was submitted. Check the existing job before retrying. ${error instanceof Error ? error.message : String(error)}`);
      }
      await options.probe(job);
      return { created: true };
    }
  }
  if (!job || !['running', 'sleeping'].includes(job.status)) {
    throw new Error(`Sandbox is ${job?.status ?? 'not found'}. Automatic replacement is blocked until the provider confirms the previous VM released its disk. Retry to check the existing job; do not create another VM for this workspace.`);
  }
  // Exec wakes a sleeping Mags VM. Failed wake/liveness is not proof of termination.
  await options.probe(job);
  return { created: false };
}

/** Collapse concurrent calls in this process; DB insertion arbitrates across processes. */
export function singleFlight<T>() {
  const pending = new Map<string, Promise<T>>();
  return (key: string, run: () => Promise<T>): Promise<T> => {
    const current = pending.get(key);
    if (current) return current;
    const result = Promise.resolve().then(run).finally(() => pending.delete(key));
    pending.set(key, result);
    return result;
  };
}
