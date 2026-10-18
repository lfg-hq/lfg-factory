/** Recover a terminal auth-VM startup failure once; never replay OAuth refresh. */
export async function startAuthWorkspaceWithRecovery<T>(ops: {
  create: (name: string) => Promise<T>;
  cleanup: (name: string) => Promise<void>;
  name: () => string;
  onRetry?: () => void;
}): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const name = ops.name();
    try { return await ops.create(name); }
    catch (error) {
      // A timeout is ambiguous: the VM may still be starting. Only replace a VM
      // whose startup explicitly ended, not a credential, network or database error.
      const terminal = error instanceof Error && /ended unexpectedly with status: (error|completed)\b/.test(error.message);
      if (!terminal) throw error;
      await ops.cleanup(name).catch(() => {});
      if (attempt === 1) throw new Error('The ChatGPT authentication service could not start after two attempts. Please try again shortly. Your saved connection has not been removed.');
      ops.onRetry?.();
    }
  }
  throw new Error('Authentication workspace unavailable');
}
