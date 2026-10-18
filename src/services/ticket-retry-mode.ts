/** A saved publication needs integration, not another implementation run. */
export function ticketRetryMode(ticket: { githubMergeStatus: string | null; githubCommitSha: string | null }, requested: 'auto' | 'merge' | 'build' = 'auto'): 'merge' | 'build' {
  if (requested !== 'auto') return requested;
  return ticket.githubMergeStatus === 'pushed' && !!ticket.githubCommitSha ? 'merge' : 'build';
}
