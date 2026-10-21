/** Reserve a place synchronously so concurrent waiters cannot share the same turn. */
export class PreviewRunQueue {
  private tails = new Map<string, Promise<void>>();

  /** True while this process holds or waits for a run of the project. */
  isActive(projectId: string): boolean { return this.tails.has(projectId); }

  async acquire(projectId: string): Promise<() => void> {
    const previous = this.tails.get(projectId);
    let resolve!: () => void;
    const mine = new Promise<void>(done => { resolve = done; });
    this.tails.set(projectId, mine);
    if (previous) await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.tails.get(projectId) === mine) this.tails.delete(projectId);
      resolve();
    };
  }
}
