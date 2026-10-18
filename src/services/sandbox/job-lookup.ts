import type { JobInfo } from './types.ts';

type ProviderJob = { request_id?: string; id?: string; workspace_id?: string; name?: string; status: string };
const terminal = new Set(['completed', 'stopped', 'error', 'failed', 'cancelled']);

/** Search all pages, retaining in-flight jobs so they cannot be mistaken for absence. */
export async function lookupJob(nameOrId: string, list: (page: number) => Promise<{ jobs: ProviderJob[]; total?: number }>): Promise<JobInfo | null> {
  const matches = new Map<string, ProviderJob>();
  const seen = new Set<string>();
  for (let page = 1; ; page++) {
    if (page > 10000) throw new Error('Sandbox job lookup exceeded pagination limit; refusing to assume absence');
    const response = await list(page);
    if (!Array.isArray(response.jobs)) throw new Error('Invalid sandbox job list');
    let added = 0;
    for (const job of response.jobs) {
      const id = job.request_id || job.id;
      if (!id) throw new Error('Sandbox job list missing job ID');
      if (!seen.has(id)) { seen.add(id); added++; }
      if (id === nameOrId || job.name === nameOrId || job.workspace_id === nameOrId) matches.set(id, job);
    }
    if (!response.jobs.length) break;
    if (!added) throw new Error('Sandbox pagination repeated a page; refusing to assume absence');
    // Request another page even when one page is short: provider page-size caps vary.
  }
  const live = [...matches.entries()].filter(([, job]) => !terminal.has(job.status));
  if (live.length > 1) throw new Error(`Multiple active sandbox jobs for ${nameOrId}; provider must resolve disk ownership before use`);
  const selected = live[0] ?? matches.entries().next().value;
  if (!selected) return null;
  const [jobId, job] = selected;
  return { jobId, workspaceId: job.workspace_id || job.name || nameOrId, status: job.status };
}
