/** Only filesystem-specific errors qualify. Auth, transport and generic runner EIO do not. */
export function isSandboxStorageFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /fsync error[^\n]*(?:I\/O error|input\/output error|no space left)/i.test(message)
    || /(?:read-only file system|no space left on device|structure needs cleaning)/i.test(message)
    || /(?:EIO|I\/O error|input\/output error)[^\n]*\/data\//i.test(message)
    || /\/data\/[^\n]*(?:EIO|I\/O error|input\/output error)/i.test(message);
}

/** A stop request is asynchronous: deletion succeeding is the completion check. */
export async function destroyWorkspaceAfterStop(opts: {
  stop: () => Promise<void>;
  remove: () => Promise<void>;
  wait?: () => Promise<void>;
}): Promise<void> {
  const status = (e: unknown) => (e as {statusCode?:number})?.statusCode;
  try { await opts.stop(); }
  catch (e) {
    // An already-gone job can still have stored workspace data to remove.
    if (status(e) !== 404) throw new Error(`Could not stop failed sandbox job: ${(e as Error).message}`);
  }
  for (let attempt=0; attempt<30; attempt++) {
    try { await opts.remove(); return; }
    catch (e) {
      if (status(e)===404) return;
      if (status(e)!==409 || !/active job/i.test((e as Error).message)) throw e;
      if (attempt===29) throw new Error("Failed sandbox job did not stop within the cleanup window; workspace registration is retained and no replacement was created.");
      await (opts.wait ? opts.wait() : new Promise<void>(resolve=>setTimeout(resolve,2000)));
    }
  }
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
