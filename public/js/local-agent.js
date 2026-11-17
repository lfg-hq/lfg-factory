// "Use my computer for AI" in the chat composer: the agent's effort level, and a plan-usage
// meter fed by what the agent on the person's computer last reported (Claude Code reports
// its 5-hour and weekly windows on every turn). Loaded only when local AI is on.
(function () {
  const effortSubmenu = document.getElementById('effort-submenu');
  const effortStatus = document.getElementById('local-effort-status');
  const dropdown = document.getElementById('settings-dropdown');

  if (effortSubmenu) {
    effortSubmenu.querySelectorAll('.submenu-option').forEach((option) => {
      option.addEventListener('click', async (event) => {
        event.stopPropagation();
        const effort = option.dataset.value || null;
        const response = await fetch('/api/settings/local-effort', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ effort }),
        });
        if (!response.ok) { const error = await response.json().catch(() => ({})); alert(error.error || 'Could not change effort'); return; }
        effortSubmenu.querySelectorAll('.submenu-option').forEach((o) => o.classList.remove('selected'));
        option.classList.add('selected');
        if (effortStatus) effortStatus.textContent = option.dataset.label || '';
        if (dropdown) dropdown.classList.remove('open');
      });
    });
  }
  if (effortStatus) {
    effortStatus.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!dropdown) return;
      dropdown.classList.add('open');
      setTimeout(() => { const item = document.querySelector('[data-submenu="effort"]'); if (item) item.classList.add('active'); }, 50);
    });
  }

  const button = document.getElementById('local-usage-btn');
  const pop = document.getElementById('local-usage-pop');
  const ring = document.getElementById('local-usage-ring');
  if (!button || !pop) return;

  const WINDOW_LABELS = { five_hour: '5-hour limit', seven_day: 'Weekly · all models', seven_day_opus: 'Weekly · Opus', seven_day_sonnet: 'Weekly · Sonnet' };
  const label = (kind) => WINDOW_LABELS[kind] || kind.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  const pct = (u) => Math.max(0, Math.min(100, Math.round((u || 0) * 100)));

  function resetText(epochSeconds) {
    if (!epochSeconds) return '';
    const at = new Date(epochSeconds * 1000);
    const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return at.getTime() - Date.now() < 20 * 3600 * 1000 ? 'Resets at ' + time : 'Resets ' + at.toLocaleDateString([], { weekday: 'short' }) + ' ' + time;
  }
  function agoText(iso) {
    if (!iso) return '';
    const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
    return minutes < 1 ? 'just now' : minutes < 60 ? minutes + ' min ago' : minutes < 1440 ? Math.round(minutes / 60) + ' h ago' : Math.round(minutes / 1440) + ' d ago';
  }
  const tokens = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n);

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function render(usage) {
    const windows = (usage && usage.windows) || [];
    const lastTurn = usage && usage.lastTurn;
    if (!windows.length && !lastTurn) { button.hidden = true; return; }
    button.hidden = false;
    const top = windows.reduce((m, w) => Math.max(m, pct(w.utilization)), 0);
    if (ring) ring.setAttribute('stroke-dasharray', (47.12 * top / 100).toFixed(2) + ' 47.12');
    button.classList.toggle('warn', top >= 80);
    button.title = windows.length ? 'Plan usage: ' + windows.map((w) => label(w.kind) + ' ' + pct(w.utilization) + '%').join(', ') : 'Last turn on your computer';

    pop.replaceChildren();
    const head = el('div', 'local-usage-head');
    head.append(el('span', null, 'Plan usage on your computer'));
    if (usage.windowsAt) head.append(el('span', 'local-usage-ago', agoText(usage.windowsAt)));
    pop.append(head);
    windows.forEach((w) => {
      const row = el('div', 'local-usage-row');
      const line = el('div', 'local-usage-line');
      line.append(el('span', null, label(w.kind)));
      line.append(el('span', 'local-usage-meta', [resetText(w.resetsAt), pct(w.utilization) + '%'].filter(Boolean).join('  ·  ')));
      const bar = el('div', 'local-usage-bar');
      const fill = el('div', 'local-usage-fill' + (pct(w.utilization) >= 80 ? ' warn' : ''));
      fill.style.width = pct(w.utilization) + '%';
      bar.append(fill);
      row.append(line, bar);
      pop.append(row);
    });
    if (lastTurn) {
      const parts = [];
      if (lastTurn.inputTokens != null) parts.push(tokens(lastTurn.inputTokens) + ' in');
      if (lastTurn.outputTokens != null) parts.push(tokens(lastTurn.outputTokens) + ' out');
      pop.append(el('div', 'local-usage-turn', 'Last turn: ' + (parts.join(' · ') || 'no token count') + (lastTurn.at ? ' · ' + agoText(lastTurn.at) : '')));
    }
    if (!windows.length) pop.append(el('div', 'local-usage-turn', "This agent doesn't report plan limits."));
  }

  async function refresh() {
    try {
      const response = await fetch('/api/settings/local-usage', { credentials: 'include' });
      if (!response.ok) return;
      const data = await response.json();
      render(data.usage);
    } catch { /* offline: keep what is shown */ }
  }

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = pop.hidden;
    pop.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open) refresh();
  });
  document.addEventListener('click', (event) => {
    if (!pop.hidden && !event.target.closest('#local-usage-pop') && !event.target.closest('#local-usage-btn')) {
      pop.hidden = true; button.setAttribute('aria-expanded', 'false');
    }
  });
  window.addEventListener('lfg-local-usage', (event) => render(event.detail));
  refresh();
})();
