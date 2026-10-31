// TEST-ONLY HTTP fixtures in real Chromium; no provider or model calls or repository mutations.
import { test, expect } from 'bun:test';
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
test('hierarchy → AI review findings → confirmed PR → open PR merge → typed deletion, failures retain input', async () => {
  const sha = 'a'.repeat(40), base = 'b'.repeat(40);
  const integration = { status: 'integrated', ahead: 0, behind: 0, evidence: 'TEST FIXTURE' };
  const row = { id: 'ticket', name: 'TEST FIXTURE ticket', branch: 'ticket/feature', headSha: sha, destination: 'epic/delivery', missingRef: false, integration, activeUse: {}, pullRequests: [] };
  const total = { total: 1, integrated: 1, notIntegrated: 0, unknown: 0 };
  const pr = { id: 7, title: '<img src=x onerror=alert(1)>', url: 'https://github.com/fixture/repo/pull/7', source: row.branch, sourceRepo: 'fixture/repo', destination: row.destination, headSha: sha, draft: false };
  const data: any = { repository: 'fixture/repo', canManageCode: true, defaultBranch: { branch: 'main', protected: true }, epics: [{ ...row, id: 'epic', name: 'TEST FIXTURE epic', branch: 'epic/delivery', destination: 'main', tickets: [row] }], other: [], pullRequests: [], totals: { epics: total, tickets: total, other: { ...total, total: 0 } }, completeness: { complete: true, pullRequests: true, errors: [] } };
  const review = { id: 'review', headRef: row.branch, baseRef: row.destination, headSha: sha, baseSha: base, status: 'completed', attempt: 1, findings: '[]', summary: 'TEST FIXTURE AI findings. Real model not called.', limitations: '["Static review only."]' };
  let creates = 0, merges = 0, deletes = 0, denyMerge = true, denyDelete = true;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path.endsWith('/branches') && req.method === 'GET') return Response.json(data);
    if (path.endsWith('/reviews') && req.method === 'POST') return Response.json({ review }, { status: 202 });
    if (path.endsWith('/reviews/review')) return Response.json({ review, stale: false, suggestedBody: 'TEST FIXTURE body' });
    if (path.endsWith('/pull-requests') && req.method === 'POST') { creates++; data.pullRequests = [pr]; return Response.json({ pullRequest: pr }); }
    if (path.endsWith('/merge-state')) return Response.json({ pullRequest: pr, blockers: [], policy: 'clean', correlationId: 'fixture-state' });
    if (path.endsWith('/merge')) {
      merges++; expect(await req.json()).toEqual({ confirmation: row.branch, destination: row.destination, expectedSha: sha });
      if (denyMerge) return Response.json({ error: 'TEST FIXTURE stale revision. Refresh.', code: 'STALE_PR', correlationId: 'fixture-merge-failure' }, { status: 409 });
      data.pullRequests = []; return Response.json({ result: { ...pr, merged: true } });
    }
    if (path.endsWith('/branches') && req.method === 'DELETE') {
      deletes++; expect(await req.json()).toEqual({ branch: row.branch, expectedSha: sha, confirmation: row.branch, confirmUnmerged: true });
      if (denyDelete) return Response.json({ error: 'TEST FIXTURE active build. Wait then refresh.', code: 'ACTIVE_BUILD', correlationId: 'fixture-delete-failure' }, { status: 409 });
      data.epics[0].tickets = []; return Response.json({ result: { deleted: row.branch } });
    }
    if (path.startsWith('/public/')) return new Response(readFileSync('.' + path), { headers: { 'Content-Type': path.endsWith('.js') ? 'text/javascript' : 'text/css' } });
    return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/public/css/git-tab.css"><section id="git" class="active"><div id="git-root" data-project-id="fixture"></div></section><script src="/public/js/git-tab.js"></script>', { headers: { 'Content-Type': 'text/html' } });
  } });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); page.setDefaultTimeout(5000);
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.port}`);
    await page.waitForSelector('.git-stats');
    expect(errors).toEqual([]);
    await page.locator('.git-ticket').getByRole('button', { name: 'Create PR · review first' }).click();
    await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Continue to PR details →' }).click();
    await page.getByRole('button', { name: 'Create pull request', exact: true }).click(); await page.waitForSelector('dialog a'); expect(creates).toBe(1);
    await page.keyboard.press('Escape'); await page.waitForSelector('dialog', { state: 'detached' });
    await page.getByRole('button', { name: 'All open PRs' }).click();
    expect(await page.locator('.git-pr').innerText()).toContain('Ticket → Epic'); expect(await page.locator('.git-pr img').count()).toBe(0);
    await page.getByRole('button', { name: 'Review & merge' }).click();
    await page.getByRole('button', { name: 'Confirm merge into epic/delivery' }).waitFor();
    expect(await page.locator('dialog').innerText()).toContain(sha); expect(merges).toBe(0);
    await page.getByRole('button', { name: 'Confirm merge into epic/delivery' }).click();
    await page.waitForFunction(() => document.querySelector('dialog')?.textContent?.includes('fixture-merge-failure'));
    expect(await page.locator('dialog').isVisible()).toBe(true); denyMerge = false;
    await page.getByRole('button', { name: 'Confirm merge into epic/delivery' }).click(); await page.waitForSelector('dialog', { state: 'detached' });
    await page.waitForFunction(() => document.querySelector('#git-root')?.textContent?.includes('No matching open pull requests.'));
    await page.getByRole('button', { name: 'Branches by epic' }).click();
    await page.locator('.git-ticket').getByRole('button', { name: 'Delete branch…' }).click();
    const typed = page.getByLabel('Type the exact branch name'); await typed.fill('wrong'); expect(await page.getByRole('button', { name: 'Delete branch', exact: true }).isDisabled()).toBe(true);
    await typed.fill(row.branch); await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Delete branch', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('dialog')?.textContent?.includes('fixture-delete-failure'));
    expect(await typed.inputValue()).toBe(row.branch); expect(await page.getByRole('checkbox').isChecked()).toBe(true);
    expect(await page.locator('dialog').evaluate(n => n.scrollWidth <= n.clientWidth + 1)).toBe(true);
    denyDelete = false; await page.getByRole('button', { name: 'Delete branch', exact: true }).click(); await page.waitForSelector('dialog', { state: 'detached' });
    expect(await page.locator('.git-ticket').count()).toBe(0); expect(deletes).toBe(2); expect(merges).toBe(2); expect(errors).toEqual([]);
  } finally { await browser?.close(); server.stop(true); }
}, 30_000);
