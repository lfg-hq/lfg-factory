// At-a-glance workspace status for the chat page:
// - counts on the side panel's Docs / Tickets / Preview tabs, and, while the panel is
//   closed, one pill in the chat header with the same status that opens the panel;
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
    if (window.ArtifactsPanel && window.ArtifactsPanel.open) window.ArtifactsPanel.open();
    if (typeof window.switchTab === 'function') window.switchTab(tab);
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

  // ── Counts live on the panel's own tabs ──────────────────────────────
  // While the panel is open, its Docs / Tickets / Preview tabs carry the counts and the
  // preview dot, so the header needs no buttons of its own. While it is closed, one quiet
  // pill in the header ("Docs 14 · Tickets 22 · Preview ●") keeps the status in view.
  function previewKind() {
    const p = String((state && state.preview) || 'idle');
    return p === 'running' ? 'running' : p === 'error' ? 'error' : /^(detecting|provisioning|installing|seeding|starting)$/.test(p) ? 'starting' : 'idle';
  }
  const PREVIEW_WORDS = { running: 'running', error: 'failed', starting: 'starting', idle: 'not running' };
  function tabBadge(tab) {
    const btn = document.querySelector('.tab-button[data-tab="' + tab + '"]');
    if (!btn) return null;
    let badge = btn.querySelector('.ws-tab-badge');
    if (!badge) { badge = el('span', 'ws-tab-badge'); badge.setAttribute('aria-hidden', 'true'); btn.append(badge); }
    return badge;
  }
  function paintTabs() {
    const docs = tabBadge('filebrowser');
    if (docs) { docs.textContent = state.docs ? String(state.docs) : ''; docs.dataset.state = 'idle'; }
    const tickets = tabBadge('checklist');
    const n = state.building.length;
    if (tickets) {
      tickets.textContent = n ? n + ' building' : (state.tickets ? String(state.tickets) : '');
      tickets.dataset.state = n ? 'building' : 'idle';
      tickets.parentElement.title = n
        ? 'Building: ' + state.building.map(t => (t.key || 'ticket') + ' ' + t.label.toLowerCase()).join(', ')
        : state.tickets + (state.tickets === 1 ? ' ticket' : ' tickets');
    }
    const preview = tabBadge('preview');
    if (preview) {
      preview.textContent = '';
      preview.dataset.state = 'dot-' + previewKind();
      preview.parentElement.title = 'Preview: ' + PREVIEW_WORDS[previewKind()];
    }
  }
  function segment(text, tab, label) {
    const b = el('button', 'ws-seg'); b.type = 'button';
    b.append(el('span', null, text));
    b.title = label; b.setAttribute('aria-label', label);
    b.addEventListener('click', () => openTab(tab));
    return b;
  }
  function paintPill() {
    const actions = document.querySelector('.chat-header-actions');
    if (!actions) return;
    let pill = document.getElementById('ws-chips');
    if (!pill) { pill = el('div', 'ws-pill'); pill.id = 'ws-chips'; actions.insertBefore(pill, actions.firstChild); }
    const n = state.building.length;
    const kind = previewKind();
    const tickets = segment(n ? n + ' building' : 'Tickets ' + (state.tickets || 0), 'checklist', n ? 'Tickets: ' + n + ' building' : 'Open Tickets');
    if (n) tickets.dataset.state = 'building';
    const preview = segment('Preview', 'preview', 'Preview: ' + PREVIEW_WORDS[kind]);
    preview.append(el('span', 'ws-dot'));
    preview.dataset.state = kind;
    pill.replaceChildren(segment('Docs ' + (state.docs || 0), 'filebrowser', 'Open Docs'), tickets, preview);
  }
  function paintChips() {
    if (!state) return;
    paintTabs(); paintPill();
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
