import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    let rows = [{ id: 'saved', type: 'build_complete', message: 'Older project — ready for review', link: '/projects/other/tickets?ticket=one', readAt: null, createdAt: new Date().toISOString() }];
    let reads = [];
    await page.route('http://lfg.test/**', async route => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith('/read')) {
            const body = route.request().postDataJSON(); reads.push(body);
            rows = rows.map(n => !body.id || n.id === body.id ? { ...n, readAt: new Date().toISOString() } : n);
            return route.fulfill({ json: { ok: true } });
        }
        if (url.pathname.endsWith('/build-notifications')) return route.fulfill({ json: { notifications: rows, unread: rows.filter(n => !n.readAt).length } });
        if (url.pathname.endsWith('.css')) return route.fulfill({ contentType: 'text/css', body: await readFile(url.pathname.endsWith('sidebar.css') ? 'public/css/sidebar.css' : 'public/css/build-notifications.css', 'utf8') });
        return route.fulfill({ contentType: 'text/html', body: '<meta charset="utf-8"><link rel="stylesheet" href="/public/css/sidebar.css"><style>body{margin:0;font-family:Arial,sans-serif;background:#f8f9fc}.sidebar{background:white!important;border-right:1px solid #e4e8ef!important}.sidebar-nav{margin-top:160px}.nav-link{color:#738299!important}main{margin:30px 100px;color:#273347}</style><div id="sidebar" class="sidebar minimized"><nav class="sidebar-nav"><button id="build-inbox-button" class="nav-link" type="button" aria-label="Notifications"><i class="fas fa-bell"></i><span class="nav-text">Notifications</span><span class="build-unread" hidden></span></button></nav></div><main>Another project’s chat</main>' });
    });
    let push;
    await page.routeWebSocket('**/ws/chat', ws => { push = ws; });
    await page.goto('http://lfg.test/chat/project/different');
    await page.addScriptTag({ path: 'public/js/build-notifications.js' });
    assert.equal(await page.locator('#build-inbox-button').count(), 1);
    await page.waitForFunction(() => document.querySelector('.build-unread')?.textContent === '1');
    assert.equal(await page.locator('#build-inbox-button').evaluate(el => getComputedStyle(el).borderTopWidth), '0px', 'Bell must not show native button borders');
    assert.equal(await page.locator('.build-toast').isVisible(), false, 'Historical results should not replay as toasts');
    await page.locator('#build-inbox-button').click();
    assert.equal(await page.locator('.build-inbox-list a').getAttribute('href'), '/projects/other/tickets?ticket=one');
    rows.unshift({ id: 'new', type: 'build_failed', message: '<img src=x onerror=alert(1)> failed to push', link: '/projects/other/tickets?ticket=two', readAt: null, createdAt: new Date().toISOString() });
    push.send(JSON.stringify({type:'notification'}));
    await page.waitForFunction(() => document.querySelector('.build-unread').textContent === '2');
    assert.equal(await page.locator('.build-toast').isVisible(), true, 'Cross-project result should toast');
    assert.equal(await page.locator('.build-inbox-list img').count(), 0, 'Ticket names must be text');
    await page.locator('.build-inbox-list article').first().getByRole('button', { name: 'Mark read', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.build-unread').textContent === '1');
    assert.equal(reads[0].id, 'new');
    await page.locator('.build-read-all').click();
    await page.waitForFunction(() => document.querySelector('.build-unread').hidden);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#build-inbox').isVisible(), false);
    // A dropped socket event is recovered on focus, without a chat socket.
    rows.unshift({ id: 'missed', type: 'build_attention', message: 'Needs your input', link: '/projects/third/tickets?ticket=three', readAt: null, createdAt: new Date().toISOString() });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => document.querySelector('.build-unread').textContent === '1');
    await page.locator('#build-inbox-button').click();
    await page.screenshot({ path: '/tmp/lfg-build-inbox.png' });
    await page.evaluate(() => {
        document.documentElement.setAttribute('data-theme', 'dark');
        document.body.style.background = '#121212';
        document.querySelector('#sidebar').style.setProperty('background', '#1a1a1a', 'important');
    });
    assert.equal(await page.locator('#build-inbox').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(26, 26, 26)', 'Inbox uses the app dark surface');
    await page.locator('.build-close').click();
    await page.mouse.move(700, 40);
    await page.waitForFunction(() => getComputedStyle(document.getElementById('build-inbox-button')).backgroundColor === 'rgba(0, 0, 0, 0)');
    await page.locator('#build-inbox-button').click();
    await page.screenshot({ path: '/tmp/lfg-build-inbox-dark.png' });
    await page.setViewportSize({ width: 375, height: 700 });
    const box = await page.locator('#build-inbox').boundingBox();
    assert(box.x >= 0 && box.x + box.width <= 375, 'Mobile inbox fits viewport');
    await page.setViewportSize({ width: 1280, height: 800 });
    const template = await readFile('src/templates/pages/chat.tsx', 'utf8');
    const header = template.slice(template.indexOf('      <!-- Project Header -->'), template.indexOf('      <!-- Messages -->')).replace('${projectName}', 'CoHire');
    await page.setContent('<div id="sidebar"><nav class="sidebar-nav"><button id="build-inbox-button" class="nav-link" type="button" aria-label="Notifications"><i class="fas fa-bell"></i><span class="nav-text">Notifications</span><span class="build-unread" hidden></span></button></nav></div><main class="chat-container">' + header + '</main>');
    for (const css of ['artifacts.css', 'chat.css', 'build-notifications.css', 'light/light-mode.css']) await page.addStyleTag({ content: await readFile('public/css/' + css, 'utf8') });
    await page.addScriptTag({ path: 'public/js/build-notifications.js' });
    assert.equal(await page.locator('.chat-header-actions #build-inbox-button').count(), 0);
    assert.equal(await page.locator('#sidebar #build-inbox-button').count(), 1);
    assert.equal(await page.locator('#artifacts-button').evaluate(el => getComputedStyle(el).position), 'relative');
    const workspace = await page.locator('#artifacts-button').boundingBox();
    const bell = await page.locator('#build-inbox-button').boundingBox();
    assert.equal(await page.locator('.chat-header-actions button').count(), 1);
    await page.locator('#build-inbox-button').click();
    const inbox = await page.locator('#build-inbox').boundingBox();
    assert(inbox.x >= 0 && inbox.x + inbox.width <= 1280);
    for (const theme of ['light','dark']) {
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        await page.locator('.build-close').click();
        await page.locator('#artifacts-button').hover();
        const styles = await page.locator('#artifacts-button').evaluate(el => ({transform:getComputedStyle(el).transform,shadow:getComputedStyle(el).boxShadow,image:getComputedStyle(el).backgroundImage}));
        assert.equal(styles.transform, 'none');assert.equal(styles.shadow, 'none');assert.equal(styles.image, 'none');
        assert.equal(await page.locator('.project-header').evaluate(el=>getComputedStyle(el).borderBottomWidth), '0px');
        assert.notEqual(await page.locator('#build-inbox-button').evaluate(el=>getComputedStyle(el).color), 'rgb(255, 255, 255)');
        await page.locator('#build-inbox-button').click();
    }
    await page.screenshot({ path: '/tmp/lfg-chat-header-controls.png' });
    assert.deepEqual(errors, []);
    console.log('PASS: saved inbox, cross-project toast, safe rendering, read actions, keyboard dismissal, reconnect recovery, mobile layout');
} finally { await browser.close(); }
