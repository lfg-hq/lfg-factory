// TEST-ONLY HTTP fixtures; real git-tab.js/CSS rendered in Chromium. No provider mutations.
import { test, expect } from 'bun:test';
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';

test('saved progress, findings, keyboard acknowledgment, editable final confirmation and stale state', async () => {
  const integration = { status: 'not_integrated', ahead: 1, behind: 0, evidence: 'TEST FIXTURE' };
  const row = { id: 'fixture-branch', name: 'Feature', branch: 'feature', destination: 'main', missingRef: false, integration, activeUse: {}, pullRequests: [] };
  const total = { total: 1, integrated: 0, notIntegrated: 1, unknown: 0 };
  const workspace = { repository: 'fixture/repo', canManageCode: true, defaultBranch: { branch: 'main' }, epics: [], other: [row], pullRequests: [], totals: { epics: { ...total, total: 0 }, tickets: { ...total, total: 0 }, other: total }, completeness: { complete: true, pullRequests: true, errors: [] } };
  let review: any, creates = 0, polls = 0, stale = false;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path.endsWith('/branches')) return Response.json(workspace);
    if (path.endsWith('/reviews') && req.method === 'POST') {
      review = { id: 'fixture-review', status: 'queued', headRef: 'feature', baseRef: 'main', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), attempt: 0, createdAt: new Date().toISOString(), correlationId: 'test-only-correlation' };
      return Response.json({ review }, { status: 202 });
    }
    if (path.endsWith('/reviews')) return Response.json({ reviews: review ? [review] : [] });
    if (path.endsWith('/reviews/fixture-review')) {
      polls++;
      review = { ...review, status: polls < 2 ? 'running' : 'completed', attempt: 1, model: 'test-only-model', summary: 'TEST FIXTURE review summary', findings: JSON.stringify([{ severity: 'medium', file: 'src/fixture.ts', line: 8, explanation: '<img src=x onerror=alert(1)>', recommendation: 'Add the missing test.' }]), coverage: JSON.stringify({ correctness: 'Reviewed', security: 'Reviewed', reliability: 'Reviewed', tests: 'Static inspection only', files: ['src/fixture.ts'], excluded: [], scope: { included: ['T1'], excluded: ['T2 not included'], unknown: [], note: 'TEST FIXTURE ancestry' } }), limitations: JSON.stringify(['Static review only. Runtime tests were not executed.']) };
      return Response.json({ review, stale, suggestedBody: 'TEST FIXTURE editable summary and limitations' });
    }
    if (path.endsWith('/pull-requests') && req.method === 'POST') {
      creates++; const body = await req.json();
      expect(body).toMatchObject({ acknowledged: true, title: 'Edited fixture title', body: 'Edited fixture body' });
      return Response.json({ pullRequest: { id: 9, title: 'TEST FIXTURE PR', url: 'https://github.com/fixture/repo/pull/9' }, existing: false });
    }
    if (path.startsWith('/public/')) return new Response(readFileSync('.' + path), { headers: { 'Content-Type': path.endsWith('.js') ? 'text/javascript' : 'text/css' } });
    return new Response('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/public/css/git-tab.css"><section id="git" class="active"><div id="git-root" data-project-id="fixture-project"></div></section><script src="/public/js/git-tab.js"></script>', { headers: { 'Content-Type': 'text/html' } });
  } });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.port}`);
    await page.waitForSelector('#git-root .git-stats', { timeout: 5000 });
    expect(errors).toEqual([]);
    await page.getByRole('button', { name: 'Create PR · review first' }).click({ timeout: 5000 });
    await page.waitForFunction(() => document.querySelector('dialog')?.textContent?.includes('Analyzing immutable'));
    expect(creates).toBe(0);
    await page.waitForSelector('dialog input[type=checkbox]');
    expect(await page.locator('dialog').innerText()).toContain('T2 not included');
    expect(await page.locator('dialog').innerText()).toContain('src/fixture.ts:8');
    expect(await page.locator('dialog img').count()).toBe(0);
    const next = page.getByRole('button', { name: 'Continue to PR details →' }); expect(await next.isDisabled()).toBe(true);
    await page.getByRole('checkbox').focus(); await page.keyboard.press('Space');
    await next.click();
    expect(creates).toBe(0);
    await page.getByLabel('Title', { exact: true }).fill('Edited fixture title'); await page.getByLabel('Body', { exact: true }).fill('Edited fixture body');
    await page.getByRole('button', { name: 'Create pull request', exact: true }).click();
    await page.waitForSelector('dialog a'); expect(creates).toBe(1);
    await page.keyboard.press('Escape'); await page.waitForSelector('dialog', { state: 'detached' });
    await page.getByRole('button', { name: 'Saved reviews' }).click(); await page.getByRole('button', { name: 'Open saved review' }).click();
    await page.waitForSelector('dialog input[type=checkbox]'); expect(await page.locator('dialog').innerText()).toContain('TEST FIXTURE review summary');
    await page.keyboard.press('Escape'); await page.waitForSelector('dialog', { state: 'detached' });
    stale = true; await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Saved reviews' }).click(); await page.getByRole('button', { name: 'Open saved review' }).click();
    await page.waitForFunction(() => document.querySelector('dialog')?.textContent?.includes('Stale review:'));
    expect(await page.getByRole('checkbox').count()).toBe(0); expect(await page.getByRole('button', { name: 'Run new review for current revisions' }).count()).toBe(1);
    expect(await page.locator('dialog').evaluate(n => n.scrollWidth <= n.clientWidth + 1)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await browser?.close(); server.stop(true); }
}, 30_000);
