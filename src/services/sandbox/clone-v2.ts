/** Clone submission is deliberately never retried: each POST allocates a VM. */
export async function submitClone(sourceId: string): Promise<string> {
  const result = await request('POST', `${encodeURIComponent(sourceId)}/clone`);
  if (!result.request_id) throw new Error('Clone response missing request_id; do not resubmit automatically');
  return result.request_id;
}

async function request(method: string, path: string): Promise<any> {
  const token = process.env.MAGS_API_TOKEN;
  if (!token) throw new Error('MAGS_API_TOKEN not set');
  const base = (process.env.MAGS_API_URL || 'https://api.magpiecloud.com').replace(/\/+$/, '');
  const response = await fetch(`${base}/api/v2/mags-jobs/${path}`, {
    method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json() as any;
  if (!response.ok) throw Object.assign(new Error(`Clone API HTTP ${response.status}: ${body.error || body.message || 'request failed'}`), { statusCode: response.status });
  return body;
}

export async function waitForClone(requestId: string, options: {
  status?: () => Promise<any>; wait?: (ms: number) => Promise<void>; now?: () => number;
} = {}): Promise<{ jobId: string; workspaceId: string }> {
  const now = options.now || Date.now;
  const deadline = now() + 660_000; // server allows ten minutes; leave boot/reporting headroom
  while (now() < deadline) {
    const status = await (options.status ? options.status() : request('GET', `${encodeURIComponent(requestId)}/status`));
    if (status.status === 'running' && typeof status.name === 'string' && status.name) {
      return { jobId: requestId, workspaceId: status.name };
    }
    if (['error', 'completed', 'stopped'].includes(status.status)) {
      throw new Error(`Clone ${requestId} failed: ${status.error_message || status.message || status.status}. Inspect clone logs; source rollback failures require operator attention.`);
    }
    await (options.wait ? options.wait(10_000) : new Promise(resolve => setTimeout(resolve, 10_000)));
  }
  throw new Error(`Clone ${requestId} still provisioning; its saved request will be resumed on retry`);
}
