/** Bounded structured records to stdout; the platform collects/rotates web output. Never pass provider bodies or credentials. */
export function logGitRequest(fields: Record<string, unknown>) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: fields.outcome === 'failed' ? 'error' : 'info', service: 'git-workspace', event: 'git.request.completed', retryCount: 0, ...fields }));
}
