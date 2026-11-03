// TEST FIXTURES ONLY. Real browser, HTTP server and Better Auth cookies; no
// intercepted API responses or fake authenticated browser state.
import { assessmentFixture, fundRecommendation } from './venture-assessment.fixture.ts';
import { chromium } from "playwright-core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
const temp = await mkdtemp(join(tmpdir(), "venture-browser-"));
const shots = process.env.SCREENSHOT_DIR || tmpdir();
const port = 8091;
Object.assign(process.env, { DATABASE_DRIVER: "sqlite", DATABASE_URL: join(temp, "test.db"), BETTER_AUTH_URL: `http://localhost:${port}`, PORT: String(port), NODE_ENV: "test", GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", TURNSTILE_SECRET_KEY: "", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", GOOGLE_AI_API_KEY: "", EXA_API_KEY: "" });
const push = Bun.spawn(["bun", "run", "db:push"], { env: process.env, stdout: "pipe", stderr: "pipe" });
if (await push.exited !== 0) throw new Error("Browser fixture schema setup failed");
const { db } = await import("../src/config/db.ts");
const { users, accounts } = await import("../src/db/schema/users.ts");
const { hashPassword } = await import("better-auth/crypto");
const id = crypto.randomUUID(), password = crypto.randomUUID(), email = `fixture-${id}@workspace.example.org`;
await db.insert(users).values({ id, email, emailVerified: true, name: "TEST FIXTURE" });
// The fixture founder is also an LFG reviewer so one browser covers both dashboards.
process.env.VENTURE_ADMIN_EMAILS = email;
await db.insert(accounts).values([{ id: crypto.randomUUID(), userId: id, accountId: id, providerId: "credential", password: await hashPassword(password) }, { id: crypto.randomUUID(), userId: id, accountId: `TEST-FIXTURE-${id}`, providerId: "google" }]);
const server = Bun.spawn(["bun", "run", "src/index.ts"], { env: process.env, stdout: "inherit", stderr: "inherit" });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const base = `http://localhost:${port}`;
  let ready = false;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${base}/health`)).ok) { ready = true; break; } } catch {} await Bun.sleep(100); }
  assert(ready, "Temporary web server failed to start");
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  // The landing page explains the offer; its call to action is an idea form that
  // keeps the idea and starts Google sign-in (the analyst's page without JS).
  await page.goto(`${base}/venture-analyst`, { waitUntil: "domcontentloaded" });
  await page.getByRole('heading', { name: 'How it works', exact: true }).waitFor();
  for (const heading of ['Not yet isn\'t no.', 'Sized to the idea.', 'We invest with execution, not cash.', 'LFG is also your coach.']) await page.getByRole('heading', { name: heading, exact: true }).waitFor();
  assert.equal(await page.locator('#va-panel').count(), 0, 'No chat on the landing page');
  const forms = await page.locator('[data-idea-form]').evaluateAll(list => list.map(f => f.getAttribute('action')));
  assert(forms.length >= 2 && forms.every(action => action === '/venture-analyst/chat'), JSON.stringify(forms));
  await page.getByRole('button', { name: 'Chat with the analyst' }).first().click();
  await page.getByText('Tell us a little about your idea first.').waitFor();
  await page.getByLabel('Tell the analyst about your idea').first().fill('TEST FIXTURE booking app for plumbers');
  await page.getByRole('button', { name: 'Chat with the analyst' }).first().click();
  // Google isn't configured here, so sign-in can't start; the idea is kept for after it does.
  await page.getByText(/GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/).waitFor();
  assert.equal(await page.evaluate(() => sessionStorage.getItem('va-idea')), 'TEST FIXTURE booking app for plumbers', 'The idea survives until sign-in');
  await page.evaluate(() => sessionStorage.removeItem('va-idea'));
  await page.screenshot({ path: `${shots}/venture-landing.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Landing has no horizontal scroll on phones');
  await page.screenshot({ path: `${shots}/venture-landing-mobile.png`, fullPage: true });
  await page.goto(`${base}/venture-analyst/terms`, { waitUntil: 'domcontentloaded' });
  for (const heading of ['3. Funding decisions and human verification', '5. Prohibited ventures and content']) await page.getByRole('heading', { name: heading, exact: true }).waitFor();
  await page.screenshot({ path: `${shots}/venture-terms.png`, fullPage: true });
  // The pitch page explains the thesis and the release / hold / halt loop.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${base}/venture-analyst/thesis`, { waitUntil: 'domcontentloaded' });
  for (const heading of ['The loop', 'How the analyst sizes a tranche', 'Agents do the work, on one stack', 'Release, hold or halt']) await page.getByRole('heading', { name: heading, exact: true }).waitFor();
  await page.screenshot({ path: `${shots}/venture-thesis.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Thesis has no horizontal scroll on phones');
  await page.screenshot({ path: `${shots}/venture-thesis-mobile.png`, fullPage: true });
  await page.goto(`${base}/venture-analyst`, { waitUntil: 'domcontentloaded' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  // Signed out, the analyst's page asks for Google sign-in and reports problems honestly.
  await page.goto(`${base}/venture-analyst/chat`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Continue with Google', exact: true }).waitFor();
  assert.equal(await page.locator('.va-error').count(), 0, 'Expected anonymous readiness is not an auth failure');
  assert.equal(await page.getByRole('link', { name: 'Terms and Conditions' }).getAttribute('href'), '/venture-analyst/terms', 'Sign-in states the terms');
  const clickedLabel = await page.getByRole('button', { name: 'Continue with Google', exact: true }).evaluate(el => { (el as HTMLButtonElement).click(); return document.querySelector('.va-google')?.textContent; });
  assert.equal(clickedLabel, 'Signing in with Google…', 'Signing-in state appears only after the click');
  await page.getByText(/GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/).waitFor();
  assert.match(await page.locator('.va-error').textContent() || '', /Correlation ID:/);
  const cancelledLabel = await page.evaluate(() => {
    (document.querySelector('.va-google') as HTMLButtonElement).click();
    const cancel = [...document.querySelectorAll('#va-stage button')].find(el => el.textContent === 'Cancel') as HTMLButtonElement;
    cancel.click(); return document.querySelector('.va-google')?.textContent;
  });
  assert.equal(cancelledLabel, 'Continue with Google', 'Cancelling restores a retryable sign-in state');
  await page.goto(`${base}/venture-analyst/chat?auth=failed&requestId=TEST-FIXTURE`, { waitUntil: 'domcontentloaded' });
  await page.getByText(/Google sign-in wasn’t completed/).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Chat page fits a phone');
  await page.screenshot({ path: `${shots}/venture-mobile.png` });
  await page.evaluate(() => localStorage.setItem('lfg-theme', 'dark'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Continue with Google', exact: true }).waitFor();
  assert.equal(await page.locator('#va-panel').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(22, 27, 34)');
  await page.evaluate(() => localStorage.setItem('lfg-theme', 'light'));
  await page.setViewportSize({ width: 1440, height: 1000 });
  // Signed-out visitors to the dashboard land on sign-in, set to return there.
  await page.goto(`${base}/venture-analyst/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(/\/venture-analyst\/chat\?next=dashboard/);
  await page.getByRole('heading', { name: 'Sign in to see your dashboard', exact: true }).waitFor();
  assert.equal(await page.locator('#va-dashboard').isHidden(), true);
  const loginStatus = await page.evaluate(async ({ email, password }) => {
    const response = await fetch('/api/auth/sign-in/email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    return response.status;
  }, { email, password });
  assert.equal(loginStatus, 200, 'Real Better Auth fixture login');
  await page.goto(`${base}/venture-analyst/chat`, { waitUntil: 'domcontentloaded' });
  assert.equal(await page.locator('#navbar, footer').count(), 0, 'Chat page has no marketing chrome');
  // Opening the analyst starts a fresh chat; nothing is created until the first message.
  assert.equal(await page.getByRole('button', { name: '+ New chat', exact: true }).count(), 0, 'New ventures start from the dashboard');
  await page.getByText('Welcome. Tell me', { exact: false }).waitFor();
  assert.equal(await page.getByLabel('Saved conversations').count(), 0, 'No conversation picker');
  assert.equal(await page.locator('.va-message').count(), 1, 'Only genuine new-conversation greeting');
  const input = page.getByLabel('Your message', { exact: true });
  await page.getByRole('button', { name: 'Dictate a message' }).waitFor();
  assert.equal(await page.locator('.va-box .va-send').evaluate(el => { const r = el.getBoundingClientRect(); return r.width === r.height && r.width <= 40; }), true, 'Send is a compact round button inside the box');
  await input.fill('TEST FIXTURE idea <img src=x onerror=alert(1)>');
  await input.press('Shift+Enter');
  assert.match(await input.inputValue(), /\n$/, 'Shift+Enter adds a line');
  await input.press('Enter');
  await page.getByText(/Platform AI credentials are unavailable/).waitFor();
  await page.waitForURL(/[?&]c=/);
  const selected = new URL(page.url()).searchParams.get('c')!; assert(selected, 'First message creates the conversation');
  assert.equal(await page.locator('#va-status').textContent(), 'TEST FIXTURE idea <img src=x onerror=alert(1)>', 'Header names the venture');
  assert.match(await page.getByRole('link', { name: /Go to dashboard/ }).getAttribute('href') || '', new RegExp(`v=${selected}`));
  assert.equal(await page.locator('.va-message:empty').count(), 0, 'No empty reply bubbles');
  await page.evaluate(() => localStorage.setItem('lfg-theme', 'light')); await page.reload({ waitUntil: 'domcontentloaded' }); await page.getByText(/This reply failed/).waitFor();
  await page.screenshot({ path: `${shots}/venture-chat.png` });
  assert.equal(await page.locator('.va-message img').count(), 0, 'User text must never execute markup');
  await page.getByText(/This reply failed/).waitFor();
  assert.equal(await page.locator('.va-message.user').textContent(), 'TEST FIXTURE idea <img src=x onerror=alert(1)>');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText(/This reply failed/).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('c'), selected, 'Reload resumes the open conversation');
  assert.equal(await page.locator('.va-message.user').count(), 1, 'Reload does not replay billable turns');
  // Analyst Markdown renders, but raw HTML, images and script links never do.
  const { ventureMessages } = await import('../src/venture/db/schema.ts');
  await db.insert(ventureMessages).values({ conversationId: selected, role: 'assistant', requestId: crypto.randomUUID(), status: 'completed', createdAt: new Date(Date.now() + 5000), content: '## Plan\n\n- **Interview** 10 plumbers\n- <img src=x onerror="window.pwned=1"> [bad](javascript:window.pwned=1) ![t](https://example.org/x.png)' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.va-md strong', { hasText: 'Interview' }).waitFor();
  assert.equal(await page.locator('.va-md h2', { hasText: 'Plan' }).count(), 1);
  assert.equal(await page.locator('.va-md img, .va-md a[href^="javascript"]').count(), 0);
  assert.equal(await page.evaluate(() => (window as any).pwned), undefined);
  await page.goto(`${base}/venture-analyst/chat`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Welcome. Tell me', { exact: false }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('c'), null);
  await page.goto(`${base}/venture-analyst/chat?c=${selected}`, { waitUntil: 'domcontentloaded' });
  await page.getByText(/This reply failed/).waitFor();
  const { ventureAssessments } = await import('../src/venture/db/schema.ts');
  await db.insert(ventureAssessments).values({ conversationId: selected, version: 1, status: 'provisional', contentJson: assessmentFixture() });
  await page.getByRole('tab', { name: 'Assessment', exact: true }).click();
  await page.getByText(/PROVISIONAL · Version 1/).waitFor();
  for (const title of ['Founder fit and recommended changes', 'Bottom-up TAM / SAM / SOM', 'Conservative / base / upside revenue', 'Financing and profit-sharing tradeoffs', 'GTM experiments and budgets', 'Validation, MVP, first user and first revenue']) assert.equal(await page.getByRole('heading', { name: title, exact: true }).count(), 1);
  await page.getByRole('button', { name: 'Regenerate explicitly' }).click();
  await page.getByText(/Configure .*retry explicitly/).waitFor();
  assert.equal(await page.getByText(/PROVISIONAL · Version 1/).count(), 1);
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await page.getByLabel('Your message', { exact: true }).fill('TEST FIXTURE unsent correction');
  await page.getByRole('tab', { name: 'Assessment', exact: true }).click();
  await page.getByText(/PROVISIONAL · Version 1/).waitFor();
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  assert.equal(await page.getByLabel('Your message', { exact: true }).inputValue(), 'TEST FIXTURE unsent correction');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Assessment', exact: true }).click();
  await page.getByText(/PROVISIONAL · Version 1/).waitFor();
  assert.equal(await page.locator('#va-panel').evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForFunction(() => !document.querySelector('#va-panel')?.hasAttribute('aria-modal'));
  assert.equal(await page.locator('#va-panel').getAttribute('aria-modal'), null);
  // Dashboard: verdict, tranche, market and to-dos for the founder; decision form for reviewers.
  await db.insert(ventureAssessments).values({ conversationId: selected, version: 2, status: 'provisional', contentJson: fundRecommendation() });
  const { saveTasks } = await import('../src/venture/services/dashboard.ts');
  const { eq, and } = await import('drizzle-orm');
  const [v2] = await db.select().from(ventureAssessments).where(and(eq(ventureAssessments.conversationId, selected), eq(ventureAssessments.version, 2)));
  await saveTasks(selected, v2!);
  // Dashboard opens on the list; a venture opens its full view, and Back returns.
  await page.goto(`${base}/venture-analyst/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Your ventures', exact: true }).waitFor();
  assert.equal(await page.locator('#navbar, footer').count(), 0, 'A working page: no marketing chrome');
  assert.equal(await page.locator('#vd-user').textContent(), 'TEST FIXTURE');
  assert.equal(await page.locator('.vd-row:not(.vd-row-head)').count(), 1);
  await page.getByRole('button', { name: '+ New venture', exact: true }).click();
  await page.getByLabel('Describe a new venture').waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('dialog').waitFor({ state: 'detached' });
  await page.screenshot({ path: `${shots}/venture-list.png`, fullPage: true });
  await page.locator('a.vd-row').first().click();
  await page.getByRole('heading', { name: 'Your to-dos', exact: true }).waitFor();
  assert.match(page.url(), new RegExp(`v=${selected}`));
  for (const heading of ['What LFG will build', 'Why this verdict', 'Recommended tranche', 'Market opportunity', 'Next steps', 'Founder fit']) assert.equal(await page.getByRole('heading', { name: heading, exact: true }).count(), 1, heading);
  assert.equal(await page.locator('.vd-head-tags .vd-dot', { hasText: 'Fund' }).count(), 1);
  assert.equal(await page.locator('.vd-type', { hasText: 'MVP' }).count() >= 1, true, 'Line items say what kind of work LFG does');
  assert.equal(await page.locator('.vd-metric strong', { hasText: '2.5M tokens' }).count(), 1);
  await page.getByText('Awaiting LFG review', { exact: true }).waitFor();
  await page.locator('.vd-todos input').first().check(); await page.waitForTimeout(300);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.vd-todos input').first().waitFor();
  assert.equal(await page.locator('.vd-todos input').first().isChecked(), true, 'To-do state persists');
  await page.screenshot({ path: `${shots}/venture-dashboard.png`, fullPage: true });
  await page.goBack(); await page.getByRole('heading', { name: 'Your ventures', exact: true }).waitFor();
  await page.getByRole('button', { name: 'All founders', exact: true }).click();
  await page.getByRole('heading', { name: 'Venture review', exact: true }).waitFor();
  await page.locator('a.vd-row').first().click();
  await page.getByRole('heading', { name: 'Record LFG decision', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Decision').inputValue(), 'approved', 'Form defaults to the analyst verdict');
  await page.locator('.vd-decide textarea').first().fill('TEST FIXTURE welcome aboard');
  await page.getByRole('button', { name: 'Record decision', exact: true }).click();
  // Approval generates the agreement; nothing is built until both sides sign it.
  await page.locator('.vd-callout', { hasText: 'Revenue share agreement ready to sign' }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'What LFG is building', exact: true }).count(), 0, 'No work before signatures');
  assert.equal(await page.getByRole('heading', { name: 'What LFG will build', exact: true }).count(), 1);
  await page.locator('.vd-agreement', { hasText: '8% of the Venture' }).waitFor();
  for (const side of ['Founder', 'LFG']) {
    await page.getByLabel(`${side} signature`).fill('TEST FIXTURE Signer');
    const block = page.locator('.vd-signature', { has: page.getByLabel(`${side} signature`) });
    await block.locator('input[type=checkbox]').check();
    await block.getByRole('button', { name: 'Sign agreement' }).click();
    await page.locator('.vd-signature.signed', { hasText: side }).waitFor();
  }
  await page.locator('.vd-callout', { hasText: 'LFG approved 2.5M tokens' }).waitFor();
  await page.screenshot({ path: `${shots}/venture-deal.png`, fullPage: true });
  // Approval releases the tranche as work items, with history in the timeline.
  await page.getByRole('heading', { name: 'What LFG is building', exact: true }).waitFor();
  assert.equal(await page.locator('.vd-work-item').count(), 2);
  await page.getByLabel('Status of TEST FIXTURE landing page').selectOption('shipped');
  await page.getByLabel('Tokens spent on TEST FIXTURE landing page').fill('400000');
  await page.locator('.vd-work-item', { hasText: 'TEST FIXTURE landing page' }).getByRole('button', { name: 'Update' }).click();
  await page.locator('.vd-event', { hasText: 'Shipped: TEST FIXTURE landing page' }).waitFor();
  await page.getByLabel('Metric value').fill('120');
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await page.locator('.vd-result', { hasText: '$120' }).waitFor();
  assert.equal(await page.locator('.vd-week-head', { hasText: 'Week 1' }).count(), 1);
  await page.screenshot({ path: `${shots}/venture-admin.png`, fullPage: true });
  await page.getByRole('link', { name: '← All ventures' }).click();
  await page.locator('.vd-pill', { hasText: 'Active' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Dashboard has no horizontal scroll on phones');
  assert.deepEqual(errors, []);
  console.info('Browser checks passed: approved labelled sample, desktop/mobile panel, keyboard/focus, dark mode, honest configuration failure, real session resume/create/reload. Google identities here are TEST FIXTURES, not live OAuth proof.');
} finally {
  await browser?.close(); server.kill(); await server.exited;
  await rm(temp, { recursive: true, force: true });
}
