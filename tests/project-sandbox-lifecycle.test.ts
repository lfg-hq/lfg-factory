import { describe, test, expect } from 'bun:test';
import { ensureProjectVm, singleFlight } from '../src/services/sandbox/project-lifecycle.ts';
import { lookupJob } from '../src/services/sandbox/job-lookup.ts';
import type { JobInfo } from '../src/services/sandbox/types.ts';

const job = (status: string): JobInfo => ({ jobId: 'existing-job', workspaceId: 'workspace', status });

describe('project VM lifecycle', () => {
  for (const status of ['running', 'sleeping']) test(`${status} uses the existing job without creation`, async () => {
    const probes: string[] = []; let creates = 0;
    const result = await ensureProjectVm({ mayCreate: false, find: async () => job(status),
      probe: async j => { probes.push(j.jobId); }, create: async () => { creates++; } });
    expect(probes).toEqual(['existing-job']); expect(creates).toBe(0); expect(result.created).toBe(false);
  });
  test('failed wake never replaces the VM', async () => {
    let creates = 0;
    await expect(ensureProjectVm({ mayCreate: false, find: async () => job('sleeping'),
      probe: async () => { throw new Error('wake timeout'); }, create: async () => { creates++; } })).rejects.toThrow('wake timeout');
    expect(creates).toBe(0);
  });
  for (const status of ['completed', 'stopped', 'error', 'provisioning', 'queued', null]) test(`existing ${status} cannot authorize replacement`, async () => {
    let creates = 0;
    await expect(ensureProjectVm({ mayCreate: false, find: async () => status ? job(status) : null,
      probe: async () => {}, create: async () => { creates++; } })).rejects.toThrow('Automatic replacement is blocked');
    expect(creates).toBe(0);
  });
  test('lookup failure is not absence', async () => {
    let creates = 0;
    await expect(ensureProjectVm({ mayCreate: true, find: async () => { throw new Error('provider unavailable'); },
      probe: async () => {}, create: async () => { creates++; } })).rejects.toThrow('provider unavailable');
    expect(creates).toBe(0);
  });
  test('first claimant creates once', async () => {
    let creates = 0;
    expect(await ensureProjectVm({ mayCreate: true, find: async () => null,
      probe: async () => {}, create: async () => { creates++; } })).toEqual({ created: true });
    expect(creates).toBe(1);
  });
  test('creation timeout reconciles the accepted job without another POST', async () => {
    let reads = 0, creates = 0, probes = 0;
    const result = await ensureProjectVm({ mayCreate: true, find: async () => ++reads === 1 ? null : job('running'),
      probe: async () => { probes++; }, create: async () => { creates++; throw new Error('poll timeout'); } });
    expect(result.created).toBe(true); expect(creates).toBe(1); expect(probes).toBe(1);
  });
  test('unresolved creation remains blocked on the next request', async () => {
    let creates = 0;
    const options = { find: async () => null, probe: async () => {}, create: async () => { creates++; throw new Error('lost response'); } };
    await expect(ensureProjectVm({ ...options, mayCreate: true })).rejects.toThrow('creation is unresolved');
    await expect(ensureProjectVm({ ...options, mayCreate: false })).rejects.toThrow('Automatic replacement is blocked');
    expect(creates).toBe(1);
  });
  test('concurrent callers share one lifecycle operation', async () => {
    const run = singleFlight<number>(); let calls = 0;
    let finish!: (v: number) => void;
    const work = () => { calls++; return new Promise<number>(r => { finish = r; }); };
    const a = run('project', work), b = run('project', work);
    await Promise.resolve(); finish(7);
    expect(await Promise.all([a, b])).toEqual([7, 7]); expect(calls).toBe(1);
    expect(await run('project', async () => 8)).toBe(8);
  });
});

describe('provider job lookup', () => {
  test('finds an old sleeping VM beyond the first 50 jobs', async () => {
    const pages: number[] = [];
    const found = await lookupJob('workspace', async page => {
      pages.push(page);
      return { jobs: page === 1 ? Array.from({ length: 50 }, (_, i) => ({ request_id: `other-${i}`, status: 'running' }))
        : page === 2 ? [{ request_id: 'old', workspace_id: 'workspace', status: 'sleeping' }] : [] };
    });
    expect(found?.jobId).toBe('old'); expect(pages).toEqual([1, 2, 3]);
  });
  test('rejects multiple active owners across pages', async () => {
    await expect(lookupJob('workspace', async page => ({ jobs: page < 3
      ? [{ request_id: `owner-${page}`, name: 'workspace', status: page === 1 ? 'sleeping' : 'running' }] : [] })))
      .rejects.toThrow('Multiple active');
  });
  test('provisioning owner wins over a completed record', async () => {
    const result = await lookupJob('workspace', async page => ({ jobs: page === 1 ? [
      { request_id: 'old', name: 'workspace', status: 'completed' },
      { request_id: 'new', name: 'workspace', status: 'provisioning' },
    ] : [] }));
    expect(result?.jobId).toBe('new');
  });
  test('repeated pages fail closed', async () => {
    await expect(lookupJob('missing', async () => ({ jobs: [{ request_id: 'one', status: 'running' }] })))
      .rejects.toThrow('repeated a page');
  });
  test('later page failures propagate', async () => {
    await expect(lookupJob('missing', async page => {
      if (page === 2) throw new Error('network failure');
      return { jobs: [{ request_id: 'one', status: 'running' }] };
    })).rejects.toThrow('network failure');
  });
});
