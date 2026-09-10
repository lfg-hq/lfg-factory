/** Only filesystem-specific errors qualify. Auth, transport and generic runner EIO do not. */
export function isSandboxStorageFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /fsync error[^\n]*(?:I\/O error|input\/output error|no space left)/i.test(message)
    || /(?:read-only file system|no space left on device|structure needs cleaning)/i.test(message)
    || /(?:EIO|I\/O error|input\/output error)[^\n]*\/data\//i.test(message)
    || /\/data\/[^\n]*(?:EIO|I\/O error|input\/output error)/i.test(message);
}

/** Destroy each confirmed broken isolated VM; allocate at most one replacement per build. */
export async function recoverSandboxStorage<T>(opts: {
  run: () => Promise<T>;
  discard: () => Promise<void>;
  create: () => Promise<void>;
  onLog: (message: string) => Promise<void>;
}): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await opts.run(); }
    catch (error) {
      if (!isSandboxStorageFailure(error)) throw error;
      await opts.onLog(`Sandbox storage failure: ${(error as Error).message}`);
      // Destruction must succeed before clearing ownership or starting another VM.
      await opts.discard();
      if (attempt === 1) throw new Error("Storage failed again on a fresh sandbox. Both failed sandboxes were removed; check the sandbox provider's storage before retrying.");
      await opts.onLog("Removed the failed ticket sandbox. Creating fresh storage and cloning the remote branch (recovery 1/1)…");
      await opts.create();
    }
  }
  throw new Error("Sandbox recovery exhausted");
}
