// At-a-glance workspace status for the chat page:
// - icons in the chat header for Docs, Tickets and Preview (the Tickets icon pulses while
//   something builds), each opening the side panel straight on its tab, plus a ⋯ menu for
//   the panel's other tabs;
// - a build bar pinned above the message box while tickets build, so progress stays in
//   view however far the conversation scrolls.
(function () {
  'use strict';
  const PID = () => document.body.dataset.projectId;
  const AGENTS = { claude: 'Claude Code', codex: 'Codex', copilot: 'Copilot' };
  let state = null;
  let timer = null;
  let lastBuilding = new Map(); // id -> ticket, from the previous poll
  let finished = null; // { tickets: [...], at } shown briefly after a build ends
  let dismissedAt = 0;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function openTab(tab) {
    if (typeof window.switchTab === 'function') window.switchTab(tab);
    if (window.ArtifactsPanel && window.ArtifactsPanel.open) window.ArtifactsPanel.open();
  }
  function elapsed(iso) {
    if (!iso) return '';
    const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return s + 's';
    const m = Math.round(s / 60);
    return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }
  function whereText(t) {
    return t.where === 'computer' ? 'on your computer' + (t.agent && AGENTS[t.agent] ? ' · ' + AGENTS[t.agent] : '') : 'in the cloud';
  }

  // ── Header icons ─────────────────────────────────────────────────────
  // Docs, Tickets and Preview as icons with counts, then a ⋯ for the panel's other tabs.
  // Each icon opens the panel straight on its tab; clicking the tab you're already on
  // closes the panel. Hover shows what each one is.
  const OTHER_TABS = [['boards', 'Boards', 'fa-chalkboard'], ['evals', 'Evals', 'fa-vial'], ['git', 'Git', 'fa-code-branch'], ['env', 'Env', 'fa-key'], ['notes', 'Notes', 'fa-note-sticky']];
  function panelOpen() { return !!document.querySelector('#artifacts-panel.expanded'); }
  function activeTab() { return document.querySelector('.tab-button.active')?.getAttribute('data-tab') || null; }
  function goTo(tab) {
    if (panelOpen() && activeTab() === tab) { window.ArtifactsPanel?.close?.(); paintActive(); return; }
    // Switch first, then open: the panel appears already on the right tab, with no
    // flash of whatever tab it showed last.
    try { if (typeof window.switchTab === 'function') window.switchTab(tab); } catch (e) { console.warn('switching tab failed:', e); }
    if (!panelOpen()) window.ArtifactsPanel?.open?.();
    paintActive();
  }
  function chip(id, icon, label, tab) {
    const b = el('button', 'ws-chip');
    b.type = 'button'; b.id = id; b.dataset.wsTab = tab; b.dataset.tip = label;
    b.innerHTML = '<i class="fas ' + icon + '" aria-hidden="true"></i><span class="ws-chip-text"></span><span class="ws-chip-dot" aria-hidden="true"></span>';
    b.setAttribute('aria-label', label);
    b.addEventListener('click', () => goTo(tab));
    return b;
  }
  function closeMenu() { document.getElementById('ws-more-menu')?.remove(); document.getElementById('ws-more')?.setAttribute('aria-expanded', 'false'); }
  function toggleMenu(anchor) {
    if (document.getElementById('ws-more-menu')) { closeMenu(); return; }
    const m = el('div', 'ws-menu'); m.id = 'ws-more-menu'; m.setAttribute('role', 'menu');
    for (const [tab, label, icon] of OTHER_TABS) {
      if (!document.querySelector('.tab-button[data-tab="' + tab + '"]')) continue;
      const it = el('button', 'ws-menu-item'); it.type = 'button'; it.setAttribute('role', 'menuitem');
      it.innerHTML = '<i class="fas ' + icon + '" aria-hidden="true"></i>';
      it.append(el('span', null, label));
      if (panelOpen() && activeTab() === tab) it.classList.add('is-current');
      it.addEventListener('click', () => { closeMenu(); goTo(tab); });
      m.append(it);
    }
    m.append(el('div', 'ws-menu-sep'));
    const toggle = el('button', 'ws-menu-item'); toggle.type = 'button'; toggle.setAttribute('role', 'menuitem');
    toggle.innerHTML = '<i class="fas ' + (panelOpen() ? 'fa-angles-right' : 'fa-table-columns') + '" aria-hidden="true"></i>';
    toggle.append(el('span', null, panelOpen() ? 'Hide panel' : 'Show panel'));
    toggle.addEventListener('click', () => { closeMenu(); window.ArtifactsPanel?.toggle?.(); paintActive(); });
    m.append(toggle);
    document.body.append(m);
    const r = anchor.getBoundingClientRect();
    m.style.top = (r.bottom + 6) + 'px';
    m.style.left = Math.max(8, r.right - m.offsetWidth) + 'px';
    anchor.setAttribute('aria-expanded', 'true');
    setTimeout(() => document.addEventListener('click', function off(e) { if (!m.contains(e.target) && !anchor.contains(e.target)) { closeMenu(); document.removeEventListener('click', off); } }), 0);
  }
  function ensureChips() {
    const actions = document.querySelector('.chat-header-actions');
    if (!actions || document.getElementById('ws-chips')) return !!actions;
    const wrap = el('div', 'ws-chips'); wrap.id = 'ws-chips';
    const more = el('button', 'ws-chip ws-more'); more.type = 'button'; more.id = 'ws-more';
    more.innerHTML = '<i class="fas fa-ellipsis" aria-hidden="true"></i>';
    more.dataset.tip = 'More: Boards, Evals, Git, Env, Notes';
    more.setAttribute('aria-label', 'More: Boards, Evals, Git, Env, Notes, and show or hide the panel');
    more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
    more.addEventListener('click', () => toggleMenu(more));
    wrap.append(chip('ws-docs', 'fa-file-lines', 'Docs', 'filebrowser'), chip('ws-tickets', 'fa-list-check', 'Tickets', 'checklist'), chip('ws-preview', 'fa-desktop', 'Preview', 'preview'), more);
    actions.insertBefore(wrap, actions.firstChild);
    // The ⋯ menu shows and hides the panel, so the separate panel icon goes.
    const panelBtn = document.getElementById('artifacts-button');
    if (panelBtn) panelBtn.style.display = 'none';
    // Keep the highlighted icon in step with the panel, however it was opened or closed.
    const art = document.getElementById('artifacts-panel');
    if (art) new MutationObserver(paintActive).observe(art, { attributes: true, attributeFilter: ['class'] });
    document.querySelector('.artifacts-tabs-list')?.addEventListener('click', () => setTimeout(paintActive, 0));
    return true;
  }
  function paintActive() {
    const open = panelOpen(), tab = activeTab();
    document.querySelectorAll('#ws-chips .ws-chip[data-ws-tab]').forEach(b => b.classList.toggle('is-current', open && b.dataset.wsTab === tab));
    document.getElementById('ws-more')?.classList.toggle('is-current', open && OTHER_TABS.some(t => t[0] === tab));
  }
  function paintChips() {
    if (!state || !ensureChips()) return;
    const docs = document.getElementById('ws-docs');
    docs.querySelector('.ws-chip-text').textContent = state.docs ? String(state.docs) : '';
    docs.dataset.tip = 'Docs · ' + state.docs + (state.docs === 1 ? ' document' : ' documents');

    const tickets = document.getElementById('ws-tickets');
    const n = state.building.length;
    tickets.dataset.state = n ? 'building' : 'idle';
    tickets.querySelector('.ws-chip-text').textContent = n ? n + ' building' : (state.tickets ? String(state.tickets) : '');
    tickets.dataset.tip = n
      ? 'Tickets · building ' + state.building.map(t => t.key || 'ticket').join(', ')
      : 'Tickets · ' + state.tickets + (state.tickets === 1 ? ' ticket' : ' tickets');

    const preview = document.getElementById('ws-preview');
    const p = String(state.preview || 'idle');
    const kind = p === 'running' ? 'running' : p === 'error' ? 'error' : /^(detecting|provisioning|installing|seeding|starting)$/.test(p) ? 'starting' : 'idle';
    preview.dataset.state = kind;
    preview.dataset.tip = 'Preview · ' + ({ running: 'running', error: 'failed', starting: 'starting', idle: 'not running' })[kind];
    for (const b of [docs, tickets, preview]) b.setAttribute('aria-label', b.dataset.tip);
    paintActive();
  }

  // ── Build bar above the message box ──────────────────────────────────
  function ensureBar() {
    let bar = document.getElementById('ws-buildbar');
    if (bar) return bar;
    // Inside the composer's form, above the input box, so it matches the composer's width.
    const host = document.querySelector('.chat-input-container #chat-form') || document.querySelector('.chat-input-container');
    if (!host) return null;
    bar = el('div', 'ws-buildbar'); bar.id = 'ws-buildbar'; bar.hidden = true;
    bar.setAttribute('role', 'status'); bar.setAttribute('aria-live', 'polite');
    host.insertBefore(bar, host.firstChild);
    return bar;
  }
  function openTicket(t) {
    if (window.TicketAgentChat && window.TicketAgentChat.open) window.TicketAgentChat.open(String(t.id), t.key || '', t.name || '', { status: t.stage });
    else openTab('checklist');
  }
  function paintBar() {
    const bar = ensureBar(); if (!bar || !state) return;
    const building = state.building;
    if (building.length) {
      const t = building[0];
      const main = el('button', 'ws-bar-main'); main.type = 'button';
      main.title = 'Open ' + (t.key || 'the ticket');
      main.addEventListener('click', () => openTicket(t));
      const line = el('span', 'ws-bar-line');
      line.append(el('span', 'ws-bar-dot'), el('strong', null, 'Building ' + (t.key || '')), el('span', 'ws-bar-name', t.name || ''),
        el('span', 'ws-bar-stage', t.label), el('span', 'ws-bar-meta', [elapsed(t.since), whereText(t)].filter(Boolean).join(' · ')));
      main.append(line);
      if (t.update) main.append(el('span', 'ws-bar-note', String(t.update).replace(/^[☀-➿\u{1F300}-\u{1FAFF}️\s]+/u, '')));
      const parts = [main];
      if (building.length > 1) {
        const more = el('button', 'ws-bar-more', '+' + (building.length - 1) + ' more'); more.type = 'button';
        more.title = building.slice(1).map(x => (x.key || 'ticket') + ': ' + x.label).join('\n');
        more.addEventListener('click', () => openTab('checklist'));
        parts.push(more);
      }
      bar.dataset.state = 'building';
      bar.replaceChildren(...parts); bar.hidden = false;
      return;
    }
    if (finished && finished.at > dismissedAt && Date.now() - finished.at < 10 * 60_000) {
      const failed = finished.tickets.filter(t => t.stage === 'failed' || t.stage === 'stopped');
      const ready = finished.tickets.filter(t => t.stage === 'ready');
      const first = failed[0] || ready[0] || finished.tickets[0];
      const main = el('button', 'ws-bar-main'); main.type = 'button';
      main.addEventListener('click', () => openTicket(first));
      const line = el('span', 'ws-bar-line');
      const names = finished.tickets.map(t => t.key || 'ticket').join(', ');
      line.append(el('span', failed.length ? 'ws-bar-icon ws-bad' : 'ws-bar-icon ws-good', failed.length ? '⏸' : '✓'),
        el('strong', null, failed.length ? (first.key || 'A ticket') + ' needs attention' : names + (ready.length === 1 ? ' is' : ' are') + ' ready for review'),
        el('span', 'ws-bar-meta', failed.length ? 'Open it to see what went wrong' : 'Open to review the changes'));
      main.append(line);
      const close = el('button', 'ws-bar-close', '×'); close.type = 'button'; close.setAttribute('aria-label', 'Dismiss');
      close.addEventListener('click', () => { dismissedAt = Date.now(); bar.hidden = true; });
      bar.dataset.state = failed.length ? 'failed' : 'done';
      bar.replaceChildren(main, close); bar.hidden = false;
      return;
    }
    bar.hidden = true;
  }

  // ── Polling ──────────────────────────────────────────────────────────
  async function refresh() {
    clearTimeout(timer); timer = null;
    const pid = PID(); if (!pid) return;
    try {
      const r = await fetch('/api/projects/' + encodeURIComponent(pid) + '/workspace-status', { credentials: 'same-origin' });
      if (r.ok) {
        const next = await r.json();
        const nowIds = new Set(next.building.map(t => t.id));
        const ended = [...lastBuilding.keys()].filter(id => !nowIds.has(id));
        if (ended.length) {
          // Look up how the tickets that just stopped building ended up.
          const p = await fetch('/api/projects/' + encodeURIComponent(pid) + '/build-progress?tickets=' + ended.map(encodeURIComponent).join(','), { credentials: 'same-origin' })
            .then(x => x.ok ? x.json() : null).catch(() => null);
          if (p && p.tickets && p.tickets.length) finished = { tickets: p.tickets.filter(t => !t.active), at: Date.now() };
        }
        lastBuilding = new Map(next.building.map(t => [t.id, t]));
        state = next;
        paintChips(); paintBar();
      }
    } catch (_) { /* try again on the next tick */ }
    const busy = state && state.building.length;
    timer = setTimeout(refresh, document.hidden ? 30000 : busy ? 4000 : 20000);
  }
  // Keep the elapsed time current between polls.
  setInterval(() => { if (state && state.building.length && !document.hidden) paintBar(); }, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('focus', () => refresh());
  window.WorkspaceStatus = { refresh };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh); else refresh();
})();
