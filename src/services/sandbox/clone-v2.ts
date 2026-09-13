/** Clone submission is deliberately never retried: each POST allocates a VM. */
export async function submitClone(sourceId: string): Promise<string> {
  const result = await request('POST', `${encodeURIComponent(sourceId)}/clone`);
  if (typeof result.request_id !== 'string' || !result.request_id.trim()) throw new Error('Clone response missing request_id; do not resubmit automatically');
  return result.request_id;
}

async function request(method: string, path: string): Promise<any> {
  const token = process.env.MAGS_API_TOKEN;
  if (!token) throw new Error('MAGS_API_TOKEN not set');
  const base = (process.env.MAGS_API_URL || 'https://api.magpiecloud.com').replace(/\/+$/, '');
  const response = await fetch(`${base}/api/v2/mags-jobs/${path}`, {
    method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000),
  });
  const raw = await response.text();
  let body: any;
  try { body = JSON.parse(raw); } catch { /* Preserve the HTTP failure below. */ }
  const valid = body && typeof body === 'object' && !Array.isArray(body);
  const scrub = (value:string) => value.split(token).join('[redacted]')
    .replace(/Bearer\s+[^\s<"']+/gi, 'Bearer [redacted]')
    .replace(/(token|password|secret|api_key)(["']?\s*[:=]\s*["']?)[^\s,"'<]+/gi, '$1$2[redacted]')
    .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
  if (!response.ok || !valid) {
    const detail = scrub(String(valid ? body.error || body.message || 'request failed' : raw)) || 'empty response body';
    const uncertain = method === 'POST' ? ' Clone submission was not confirmed; automatic resubmission is blocked to avoid duplicate sandboxes.' : '';
    throw Object.assign(new Error(`Clone API HTTP ${response.status} (${scrub(response.headers.get('content-type') || 'unknown content type')}): ${valid ? '' : 'Non-JSON or invalid response: '}${detail}.${uncertain}`), { statusCode: response.status });
  }
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
