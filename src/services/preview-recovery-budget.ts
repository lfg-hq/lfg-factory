/** Shared budget across warm-run, normalization and clean-replay failures. */
export class PreviewRecoveryBudget {
  private seen = new Set<string>();
  private attempts = 0;
  constructor(private limit = 3) {}
  next(fingerprint:string): string | null {
    if(this.seen.has(fingerprint)) return 'The same step failed again with an unchanged saved recipe; recovery stopped because it made no persistent progress.';
    if(this.attempts >= this.limit) return `Recovery exhausted its ${this.limit} repair attempts.`;
    this.seen.add(fingerprint);this.attempts++;
    return null;
  }
}
