// Venture dashboard. Two views rendered into #vd:
//  - list (default): every venture at a glance, with filters;
//  - detail (?v=id): where the venture stands now (what LFG built, what it
//    cost, results, a week-by-week timeline), then the analyst's assessment.
// Founders see their own ventures; LFG reviewers can switch to all founders,
// record the binding decision and report progress. Server content is rendered
// with textContent, except sanitized Markdown in the transcript.
(() => {
  'use strict';
  const root = document.getElementById('vd');
  const params = new URLSearchParams(location.search);
  let scope = params.get('scope') === 'all' ? 'all' : 'mine';
  let selected = params.get('v'), filter = 'all', isAdmin = false, ventures = [], rate = 5, openDeal = false;

  // ---- tiny DOM helpers ---------------------------------------------------
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null && text !== '') node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const h = (tag, className, ...children) => { const node = el(tag, '', className); node.append(...children.flat().filter(c => c !== null && c !== undefined && c !== false)); return node; };
  const btn = (text, action, className = 'vd-btn') => { const b = el('button', text, className); b.type = 'button'; b.onclick = action; return b; };
  const link = (text, href, className = 'vd-btn') => { const a = el('a', text, className); a.href = href; return a; };
  const barOf = pct => { const bar = el('span'); bar.style.width = `${Math.min(100, Math.max(0, pct))}%`; return bar; };

  // ---- formatting ---------------------------------------------------------
  const VERDICT = { fund: ['Fund', 'good'], needs_more_info: ['Needs more info', 'warn'], decline: ['Decline', 'bad'], prohibited: ['Prohibited', 'bad'] };
  const DECISION = { approved: ['Approved', 'good'], needs_more_info: ['Needs more info', 'warn'], declined: ['Declined', 'bad'], prohibited: ['Prohibited', 'bad'] };
  const STATUS = { planned: ['Planned', 'neutral'], in_progress: ['In progress', 'info'], shipped: ['Shipped', 'good'], blocked: ['Blocked', 'bad'] };
  const TIER = { micro: 'Micro business', small_business: 'Small business', venture_scale: 'Venture scale' };
  const WORK = { landing_page: 'Landing page', content_strategy: 'Content strategy', mvp: 'MVP', product_feature: 'Product feature', integration: 'Integration', support_tooling: 'Support tooling', security: 'Security', maintenance: 'Maintenance', marketing: 'Marketing', sales: 'Sales', analytics: 'Analytics', operations: 'Operations' };
  const dot = ([label, tone]) => el('span', label, `vd-dot ${tone}`);
  const pill = ([label, tone]) => el('span', label, `vd-pill ${tone}`);
  const compact = n => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  const tokens = n => n === null || n === undefined ? '—' : `${compact(n)} tokens`;
  const usd = (n, digits = 0) => n === null || n === undefined ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n);
  const usdShort = n => n === null || n === undefined ? 'Unknown' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(n);
  const cost = t => usd(t / 1e6 * rate, t / 1e6 * rate < 100 ? 2 : 0);
  const date = d => d ? new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  const shortDate = d => d ? new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
  function ago(d) {
    const days = Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000);
    return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : days < 30 ? `${days} days ago` : date(d);
  }
  const DEAL = { equity: 'Equity', revenue_share: 'Revenue share', profit_share: 'Profit share' };
  const AGREEMENT = { awaiting_signatures: ['Awaiting signatures', 'warn'], changes_requested: ['Renegotiating', 'warn'], active: ['Active', 'good'] };
  const lfgStatus = v => v.deal && AGREEMENT[v.deal.status] ? AGREEMENT[v.deal.status] : v.decision ? DECISION[v.decision.decision] : v.assessment?.verdict ? ['Awaiting review', 'neutral'] : ['Not assessed', 'muted'];
  const metricValue = (name, v) => name === 'revenue_usd' ? usd(v) : name === 'conversion_rate' ? `${v}%` : compact(v);

  // ---- data and routing ---------------------------------------------------
  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...options.headers } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || 'Request failed. Please retry.'), { status: response.status, code: data.code, requestId: data.requestId });
    return data;
  }
  const errorText = e => `${e.message}${e.requestId ? ` (ref ${String(e.requestId).slice(0, 8)})` : ''}`;
  function url(id = selected) {
    const q = new URLSearchParams();
    if (scope === 'all') q.set('scope', 'all');
    if (id) q.set('v', id);
    return `${location.pathname}${q.size ? `?${q}` : ''}`;
  }
  function go(id) { selected = id; openDeal = false; history.pushState(null, '', url()); render(); window.scrollTo(0, 0); }
  addEventListener('popstate', () => {
    const q = new URLSearchParams(location.search), nextScope = q.get('scope') === 'all' ? 'all' : 'mine';
    selected = q.get('v');
    if (nextScope !== scope) { scope = nextScope; load(); } else render();
  });

  function showViewer(viewer) {
    const user = document.getElementById('vd-user'), out = document.getElementById('vd-signout');
    if (!viewer) return;
    user.textContent = viewer.name || viewer.email; user.title = viewer.email; user.hidden = false; out.hidden = false;
    out.onclick = async () => {
      out.disabled = true;
      try { await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch { /* still leave */ }
      location.assign('/venture-analyst');
    };
  }

  async function refreshList() {
    const data = await api(`/api/venture/dashboard${scope === 'all' ? '?scope=all' : ''}`);
    isAdmin = data.isAdmin; ventures = data.ventures; rate = data.usdPerMillionTokens || rate; showViewer(data.viewer);
  }
  async function load() {
    root.replaceChildren(el('p', 'Loading…', 'vd-loading'));
    try { await refreshList(); render(); }
    catch (error) {
      // Signed-out visitors sign in on the analyst page, then come straight back here.
      if (error.status === 401 || error.code === 'GOOGLE_LINK_REQUIRED') { location.replace('/venture-analyst?chat=open&next=dashboard'); return; }
      if (error.code === 'ADMIN_REQUIRED') { scope = 'mine'; history.replaceState(null, '', url()); load(); return; }
      root.replaceChildren(h('div', 'vd-state', el('p', errorText(error), 'vd-error'), btn('Retry', load)));
    }
  }
  const render = () => selected ? renderDetail(selected) : renderList();

  // ---- list view ----------------------------------------------------------
  function newVentureDialog() {
    const dialog = el('dialog', '', 'vd-dialog');
    const form = el('form', '', 'vd-new');
    const input = el('textarea'); input.rows = 5; input.maxLength = 4000; input.required = true;
    input.placeholder = 'e.g. I run a 3-person plumbing business and lose jobs because I can’t answer calls on site…';
    input.setAttribute('aria-label', 'Describe a new venture');
    const feedback = el('p', '', 'vd-muted'); feedback.setAttribute('role', 'status');
    const start = el('button', 'Start with the analyst', 'vd-btn primary'); start.type = 'submit';
    form.append(
      el('h2', 'Start a new venture'),
      el('p', 'Describe the idea, who it helps and what you bring to it. The analyst picks it up from here.', 'vd-muted'),
      input, h('div', 'vd-new-actions', btn('Cancel', () => dialog.close()), start), feedback);
    input.onkeydown = e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); form.requestSubmit(); } };
    form.onsubmit = async e => {
      e.preventDefault(); const text = input.value.trim(); if (!text) return;
      start.disabled = true; feedback.textContent = 'Creating your conversation…';
      try {
        const { conversation } = await api('/api/venture/conversations', { method: 'POST', body: JSON.stringify({ title: text.replace(/\s+/g, ' ').slice(0, 80) }) });
        // The chat page sends this once as the first message, then forgets it.
        try { sessionStorage.setItem(`va-pending:${conversation.id}`, text); } catch { /* storage unavailable: founder retypes */ }
        location.assign(`/venture-analyst/chat?c=${encodeURIComponent(conversation.id)}`);
      } catch (error) { start.disabled = false; feedback.textContent = errorText(error); }
    };
    dialog.append(form);
    dialog.addEventListener('close', () => dialog.remove());
    dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });
    document.body.append(dialog); dialog.showModal(); input.focus();
  }

  const FILTERS = [
    ['all', 'All', () => true],
    ['building', 'Building', v => v.progress.total > 0],
    ['review', 'Awaiting review', v => !v.decision && Boolean(v.assessment?.verdict)],
    ['signing', 'Awaiting signatures', v => ['awaiting_signatures', 'changes_requested'].includes(v.deal?.status)],
    ['info', 'Needs info', v => (v.decision?.decision || v.assessment?.verdict) === 'needs_more_info'],
    ['closed', 'Declined', v => ['declined', 'prohibited', 'decline'].includes(v.decision?.decision || v.assessment?.verdict)],
    ['draft', 'Not assessed', v => !v.assessment],
  ];

  function stats() {
    const spent = ventures.reduce((sum, v) => sum + v.progress.tokensSpent, 0);
    const approved = ventures.reduce((sum, v) => sum + v.tokensApproved, 0);
    const shipped = ventures.reduce((sum, v) => sum + v.progress.shipped, 0), items = ventures.reduce((sum, v) => sum + v.progress.total, 0);
    const revenue = ventures.reduce((sum, v) => sum + (v.revenueUsd || 0), 0);
    const stat = (label, value, hint) => h('div', 'vd-stat', el('span', label, 'vd-stat-label'), el('strong', value), el('span', hint, 'vd-sub'));
    return h('div', 'vd-stats',
      stat('Ventures building', String(ventures.filter(v => v.progress.total).length), `${ventures.length} total · ${ventures.filter(FILTERS[2][2]).length} awaiting review`),
      stat('Spent so far', cost(spent), `${tokens(spent)} of ${compact(approved)} approved`),
      stat('Shipped', `${shipped}`, `of ${items} work items`),
      stat('Monthly revenue', usd(revenue), 'Latest reading, all ventures'));
  }

  function row(v) {
    const r = v.assessment, p = v.progress;
    const item = el('a', '', 'vd-row');
    item.href = url(v.id);
    item.onclick = e => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; e.preventDefault(); go(v.id); };
    const subtitle = [v.owner ? (v.owner.name || v.owner.email) : null, r?.summary || (r ? 'Assessed before verdicts existed' : 'In conversation with the analyst')].filter(Boolean).join(' · ');
    const spendCell = v.tokensApproved ? h('div', 'vd-stack', el('strong', cost(p.tokensSpent)), h('div', 'vd-track', barOf(100 * p.tokensSpent / v.tokensApproved)), el('span', `${compact(p.tokensSpent)} of ${compact(v.tokensApproved)} tokens`, 'vd-sub'))
      : r?.recommendedTokens ? h('div', 'vd-stack', el('span', '—', 'vd-faint'), el('span', `${compact(r.recommendedTokens)} recommended`, 'vd-sub')) : el('span', '—', 'vd-faint');
    const progressCell = p.total ? h('div', 'vd-stack', el('strong', `Week ${p.week}`), el('span', `${p.shipped} of ${p.total} shipped`, 'vd-sub')) : el('span', '—', 'vd-faint');
    item.append(
      h('div', 'vd-cell vd-cell-main', el('strong', v.title, 'vd-row-title'), el('span', subtitle, 'vd-sub vd-clamp')),
      h('div', 'vd-cell vd-stack', pill(lfgStatus(v)), v.deal ? el('span', DEAL[v.deal.structure], 'vd-sub') : r?.verdict ? el('span', `Analyst: ${VERDICT[r.verdict][0]}`, 'vd-sub') : null),
      h('div', 'vd-cell', spendCell),
      h('div', 'vd-cell', progressCell),
      h('div', 'vd-cell', v.revenueUsd !== null ? h('div', 'vd-stack', el('strong', usd(v.revenueUsd)), el('span', 'per month', 'vd-sub')) : el('span', '—', 'vd-faint')),
      h('div', 'vd-cell vd-cell-end', el('span', ago(v.updatedAt), 'vd-sub')));
    return item;
  }

  function renderList() {
    document.title = 'Ventures | LFG';
    const head = h('div', 'vd-pagehead',
      h('div', '', el('h1', scope === 'all' ? 'Venture review' : 'Your ventures'), el('p', scope === 'all' ? 'Every founder’s venture: what LFG is building, what it has cost, and the results.' : 'What LFG is building for each idea, what it has cost, and the results.', 'vd-muted')),
      h('div', 'vd-actions',
        isAdmin ? h('div', 'vd-seg', ...[['mine', 'My ventures'], ['all', 'All founders']].map(([key, label]) => {
          const b = btn(label, () => { if (scope !== key) { scope = key; filter = 'all'; history.pushState(null, '', url()); load(); } }, `vd-seg-btn${scope === key ? ' active' : ''}`);
          b.setAttribute('aria-pressed', String(scope === key)); return b;
        })) : null,
        btn('+ New venture', newVentureDialog, 'vd-btn primary')));
    if (!ventures.length) {
      root.replaceChildren(head, h('div', 'vd-empty',
        el('h2', scope === 'all' ? 'No ventures yet' : 'Start your first venture'),
        el('p', scope === 'all' ? 'When founders talk to the analyst, their ventures appear here.' : 'Describe your idea and the analyst will assess the opportunity, your edge and what it would take to fund it.', 'vd-muted'),
        scope === 'mine' ? btn('+ New venture', newVentureDialog, 'vd-btn primary') : null));
      return;
    }
    const chips = h('div', 'vd-chips', ...FILTERS.map(([key, label, test]) => {
      const count = ventures.filter(test).length;
      if (key !== 'all' && !count) return null;
      const chip = btn('', () => { filter = key; renderList(); }, `vd-chip${filter === key ? ' active' : ''}`);
      chip.append(el('span', label), el('span', String(count), 'vd-chip-count')); chip.setAttribute('aria-pressed', String(filter === key));
      return chip;
    }));
    const shown = ventures.filter(FILTERS.find(f => f[0] === filter)[2]);
    const table = h('div', 'vd-list',
      h('div', 'vd-row vd-row-head', ...['Venture', 'Status', 'Spent', 'Progress', 'Revenue', 'Updated'].map((t, i) => el('span', t, `vd-cell${i === 5 ? ' vd-cell-end' : ''}`))),
      ...shown.map(row));
    root.replaceChildren(head, stats(), chips, table);
  }

  // ---- detail: shared bits ------------------------------------------------
  const card = (title, ...children) => h('section', 'vd-card', title ? el('h2', title) : null, ...children);
  const cardHead = (title, sub, ...right) => h('div', 'vd-card-head', h('div', '', el('h2', title), sub ? el('p', sub, 'vd-sub') : null), ...right);
  function claims(list, sources) {
    if (!list?.length) return el('p', 'None recorded.', 'vd-muted');
    return h('ul', 'vd-claims', ...list.map(c => {
      const li = h('li', '', el('span', c.text));
      if (c.kind && c.kind !== 'estimate') li.prepend(el('span', c.kind === 'self-report' ? 'Founder says' : c.kind, `vd-tag ${c.kind}`));
      for (const id of c.sourceIds || []) {
        const src = sources.get(id); if (!src) continue;
        try { const u = new URL(src.url); if (!['http:', 'https:'].includes(u.protocol)) continue; const a = link(src.title || u.hostname, u.href, 'vd-source'); a.target = '_blank'; a.rel = 'noopener noreferrer'; li.append(a); } catch { /* skip */ }
      }
      return li;
    }));
  }
  function sparkline(values) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 100 32'); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('class', 'vd-spark'); svg.setAttribute('aria-hidden', 'true');
    if (values.length < 2) return svg;
    const max = Math.max(...values), min = Math.min(...values), span = max - min || 1;
    const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${30 - ((v - min) / span) * 26}`);
    const area = document.createElementNS(svg.namespaceURI, 'polygon'); area.setAttribute('points', `0,32 ${pts.join(' ')} 100,32`); area.setAttribute('class', 'vd-spark-area');
    const line = document.createElementNS(svg.namespaceURI, 'polyline'); line.setAttribute('points', pts.join(' ')); line.setAttribute('class', 'vd-spark-line');
    svg.append(area, line); return svg;
  }

  // ---- detail: current state ----------------------------------------------
  function stateStrip(data, r) {
    const p = data.progress, revenue = data.metrics.filter(m => m.name === 'revenue_usd');
    const m = (label, value, sub, extra) => h('div', 'vd-metric', el('span', label, 'vd-stat-label'), value, extra || null, sub ? el('span', sub, 'vd-sub') : null);
    const latest = revenue.at(-1), prev = revenue.at(-2);
    const change = latest && prev && prev.value ? Math.round(100 * (latest.value - prev.value) / prev.value) : null;
    if (!p.total) {
      return h('div', 'vd-metrics',
        m('Stage', el('strong', data.agreements.current ? AGREEMENT[data.agreements.current.status]?.[0] || 'Agreement' : data.decision ? DECISION[data.decision.decision][0] : r ? 'Awaiting review' : 'Talking to analyst'), r ? `Analyst says ${VERDICT[r.verdict][0].toLowerCase()}` : null),
        m('Recommended tranche', el('strong', r?.verdict === 'fund' ? tokens(r.tokenTranche.totalTokens) : '—'), r?.verdict === 'fund' ? `≈ ${cost(r.tokenTranche.totalTokens)} of agent work` : null),
        m('Work planned', el('strong', r?.verdict === 'fund' ? `${r.tokenTranche.lineItems.length} items` : '—'), r?.verdict === 'fund' ? 'Starts when both sides sign' : null),
        m('Next check-in', el('strong', r?.checkInWeeks ? `${r.checkInWeeks} weeks after funding` : '—'), null));
    }
    return h('div', 'vd-metrics',
      m('Timeline', el('strong', `Week ${p.week}`), `Funded ${date(p.fundedAt)}`),
      m('Spent so far', el('strong', cost(p.tokensSpent)), `${tokens(p.tokensSpent)} of ${compact(p.tokensApproved)} approved`, h('div', 'vd-track wide', barOf(100 * p.tokensSpent / (p.tokensApproved || 1)))),
      m('Shipped', el('strong', `${p.shipped} of ${p.total}`), `${data.workItems.filter(w => w.status === 'in_progress').length} in progress`),
      m('Monthly revenue', el('strong', latest ? usd(latest.value) : '—'), latest ? (change !== null ? `${change >= 0 ? '+' : ''}${change}% since ${shortDate(prev.recordedAt)}` : `as of ${shortDate(latest.recordedAt)}`) : 'No revenue yet'));
  }

  function workAdmin(item, onDone) {
    const status = el('select'); status.setAttribute('aria-label', `Status of ${item.title}`);
    Object.entries(STATUS).forEach(([key, [label]]) => status.append(new Option(label, key)));
    status.value = item.status;
    const add = el('input'); add.type = 'number'; add.min = '0'; add.step = '1000'; add.placeholder = '+ tokens spent'; add.setAttribute('aria-label', `Tokens spent on ${item.title}`);
    const save = btn('Update', async () => {
      const body = {};
      if (status.value !== item.status) body.status = status.value;
      if (Number(add.value) > 0) body.addTokens = Math.round(Number(add.value));
      if (!Object.keys(body).length) return;
      save.disabled = true;
      try { await api(`/api/venture/admin/work-items/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: JSON.stringify(body) }); await onDone(); }
      catch (error) { save.disabled = false; alert(errorText(error)); }
    }, 'vd-btn small');
    return h('div', 'vd-work-admin', status, add, save);
  }

  function building(data, r, reload) {
    const items = data.workItems;
    if (!items.length) {
      if (r?.verdict !== 'fund') return null;
      return card('What LFG will build', el('p', 'Planned from the analyst’s recommendation. Work starts once LFG approves and both sides sign the agreement.', 'vd-muted vd-tight'),
        h('div', 'vd-work', ...r.tokenTranche.lineItems.map(line => h('div', 'vd-work-item',
          h('div', 'vd-work-top', h('div', 'vd-work-title', line.workType ? el('span', WORK[line.workType] || line.workType, 'vd-type') : null, el('strong', line.item)), pill(STATUS.planned)),
          line.deliverable ? el('p', line.deliverable, 'vd-deliverable') : null,
          el('span', `${tokens(line.tokens)} · ≈ ${cost(line.tokens)}`, 'vd-sub')))));
    }
    const p = data.progress;
    return h('section', 'vd-card',
      cardHead('What LFG is building', `${tokens(p.tokensSpent)} spent (${cost(p.tokensSpent)}) of ${compact(p.tokensApproved)} approved`),
      h('div', 'vd-work', ...items.map(w => {
        const pct = w.tokensBudgeted ? 100 * w.tokensSpent / w.tokensBudgeted : 0;
        const when = w.status === 'shipped' ? `Shipped ${shortDate(w.shippedAt)}` : w.startedAt ? `Started ${shortDate(w.startedAt)}` : 'Not started';
        return h('div', `vd-work-item ${w.status}`,
          h('div', 'vd-work-top', h('div', 'vd-work-title', el('span', WORK[w.workType] || w.workType, 'vd-type'), el('strong', w.title)), pill(STATUS[w.status] || [w.status, 'neutral'])),
          w.deliverable ? el('p', w.deliverable, 'vd-deliverable') : null,
          h('div', 'vd-work-meter', h('div', `vd-track wide${pct > 100 ? ' over' : ''}`, barOf(pct)), el('span', `${compact(w.tokensSpent)} / ${compact(w.tokensBudgeted)} · ${cost(w.tokensSpent)}`, 'vd-sub')),
          el('span', when, 'vd-sub'),
          isAdmin ? workAdmin(w, reload) : null);
      })));
  }

  function results(data, reload) {
    const by = {};
    for (const m of data.metrics) (by[m.name] ??= []).push(m);
    const names = Object.keys(data.metricLabels).filter(n => by[n]);
    const section = h('section', 'vd-card', cardHead('Results', names.length ? 'Readings from LFG analytics and billing' : null));
    if (!names.length) section.append(el('p', data.progress.total ? 'No results recorded yet.' : 'Results appear here once LFG starts building.', 'vd-muted'));
    else section.append(h('div', 'vd-results', ...names.map(name => {
      const series = by[name], latest = series.at(-1), prev = series.at(-2);
      const delta = prev ? latest.value - prev.value : null;
      return h('div', 'vd-result',
        el('span', data.metricLabels[name], 'vd-stat-label'),
        h('div', 'vd-result-row', el('strong', metricValue(name, latest.value)), delta !== null && delta !== 0 ? el('span', `${delta > 0 ? '▲' : '▼'} ${metricValue(name, Math.abs(Math.round(delta * 10) / 10))}`, `vd-delta ${delta > 0 ? 'up' : 'down'}`) : null),
        sparkline(series.map(m => m.value)),
        el('span', `${series.length} readings · latest ${shortDate(latest.recordedAt)}`, 'vd-sub'));
    })));
    if (isAdmin) {
      const name = el('select'); name.setAttribute('aria-label', 'Metric');
      Object.entries(data.metricLabels).forEach(([key, label]) => name.append(new Option(label, key)));
      const value = el('input'); value.type = 'number'; value.min = '0'; value.step = 'any'; value.placeholder = 'Value'; value.setAttribute('aria-label', 'Metric value');
      const save = btn('Record', async () => {
        if (value.value === '') return;
        save.disabled = true;
        try { await api(`/api/venture/admin/conversations/${encodeURIComponent(data.conversation.id)}/metrics`, { method: 'POST', body: JSON.stringify({ name: name.value, value: Number(value.value) }) }); await reload(); }
        catch (error) { save.disabled = false; alert(errorText(error)); }
      }, 'vd-btn small');
      section.append(h('div', 'vd-work-admin vd-metric-admin', name, value, save));
    }
    return section;
  }

  function timeline(data) {
    if (!data.events.length) return null;
    const groups = [];
    for (const e of data.events) {
      const key = e.week ? `Week ${e.week}` : 'Before funding';
      if (groups.at(-1)?.key !== key) groups.push({ key, week: e.week, events: [] });
      groups.at(-1).events.push(e);
    }
    const start = data.progress.fundedAt ? new Date(data.progress.fundedAt).getTime() : null;
    const range = w => start ? `${shortDate(start + (w - 1) * 7 * 86_400_000)} – ${shortDate(start + (w * 7 - 1) * 86_400_000)}` : '';
    return h('section', 'vd-card',
      cardHead('Timeline', data.progress.week ? `Week ${data.progress.week} since LFG funded it` : 'History so far'),
      h('div', 'vd-timeline', ...groups.map(g => h('div', 'vd-week',
        h('div', 'vd-week-head', el('strong', g.key), g.week ? el('span', range(g.week), 'vd-sub') : null),
        h('ol', 'vd-events', ...g.events.map(e => h('li', `vd-event ${e.kind}`,
          h('div', 'vd-event-body', el('strong', e.title), e.detail ? el('p', e.detail, 'vd-sub') : null),
          h('div', 'vd-event-meta', el('span', shortDate(e.occurredAt), 'vd-sub'), e.tokens && ['shipped', 'spend'].includes(e.kind) ? el('span', `${compact(e.tokens)} · ${cost(e.tokens)}`, 'vd-sub') : null))))))));
  }

  // Deal terms editor shared by the decision form, revisions and change requests.
  function termFields(initial = {}, optional = false) {
    const structure = el('select'); structure.setAttribute('aria-label', 'Deal structure');
    if (optional) structure.append(new Option('No change', ''));
    Object.entries(DEAL).forEach(([k, v]) => structure.append(new Option(v, k)));
    structure.value = initial.structure ?? (optional ? '' : 'revenue_share');
    const num = (label, value, step) => { const i = el('input'); i.type = 'number'; i.step = step; i.min = '0'; i.setAttribute('aria-label', label); if (value !== null && value !== undefined) i.value = String(value); return i; };
    const equity = num('Equity %', initial.equityPercent, '0.1'), share = num('Share %', initial.revenueSharePercent, '0.5'), cap = num('Cap multiple', initial.capMultiple, '0.5'), term = num('Term in months', initial.termMonths, '1');
    const f = (label, input) => h('label', 'vd-field', el('span', label), input);
    const eqField = f('Equity %', equity), shareField = f('Share %', share), capField = f('Cap (× tranche value)', cap), termField = f('Term (months)', term);
    const sync = () => { const v = structure.value; eqField.hidden = v !== 'equity'; [shareField, capField, termField].forEach(x => { x.hidden = !v || v === 'equity'; }); };
    structure.onchange = sync; sync();
    const n = i => i.value === '' ? null : Number(i.value);
    return {
      node: h('div', 'vd-terms-form', f('Deal', structure), eqField, shareField, capField, termField),
      read: () => {
        const v = structure.value; if (!v) return null;
        return v === 'equity' ? { structure: v, equityPercent: n(equity), revenueSharePercent: null, capMultiple: null, termMonths: null }
          : { structure: v, equityPercent: null, revenueSharePercent: n(share), capMultiple: n(cap), termMonths: n(term) };
      },
    };
  }

  function dealCard(data, r, reload) {
    const ag = data.agreements.current, versions = data.agreements.versions, messages = data.agreements.messages;
    if (!ag && !r?.deal) return null;
    const box = h('details', 'vd-card vd-deal');
    const needsMe = ag && ag.status === 'awaiting_signatures' && ((data.isOwner && !ag.founderSignedAt) || (isAdmin && !ag.lfgSignedAt));
    const needsLfg = ag && ag.status === 'changes_requested' && isAdmin;
    const structure = ag?.structure ?? r.deal.structure;
    box.append(h('summary', 'vd-deal-summary',
      h('div', 'vd-deal-title', el('h2', 'Deal'), el('span', DEAL[structure], 'vd-type'), el('span', ag ? ag.summary : `Analyst recommends: ${dealLine(r.deal, r.tokenTranche.totalTokens)}`, 'vd-sub')),
      h('div', 'vd-deal-state', needsMe || needsLfg ? el('span', 'Action needed', 'vd-pill bad') : null, ag ? pill(AGREEMENT[ag.status] || [ag.status, 'neutral']) : pill(['Not proposed yet', 'muted']))));
    const body = h('div', 'vd-deal-body');
    if (!ag) {
      body.append(el('p', `The analyst recommends ${DEAL[r.deal.structure].toLowerCase()}: ${dealLine(r.deal, r.tokenTranche.totalTokens)}. ${r.deal.rationale}`, 'vd-muted'),
        el('p', 'LFG proposes the final terms when it approves. Both sides then sign the agreement before any work starts.', 'vd-sub'));
      box.append(body); return box;
    }
    const term = (label, value) => h('div', 'vd-term', el('span', label, 'vd-stat-label'), el('strong', value));
    body.append(h('div', 'vd-terms',
      term('Structure', DEAL[ag.structure]),
      ag.structure === 'equity' ? term('LFG stake', `${ag.equityPercent}%`) : term(ag.structure === 'revenue_share' ? 'Share of revenue' : 'Share of profit', `${ag.revenueSharePercent}%`),
      ag.structure === 'equity' ? null : term('Repayment cap', `${ag.capMultiple}× · ${usd(ag.valueUsd * ag.capMultiple)}`),
      ag.structure === 'equity' ? null : term('Term', `${ag.termMonths} months`),
      term('Tokens committed', `${compact(ag.tokensCommitted)} · ≈ ${usd(ag.valueUsd, ag.valueUsd < 100 ? 2 : 0)}`),
      term('Version', `v${ag.version}${ag.activatedAt ? ` · active ${date(ag.activatedAt)}` : ''}`)));
    const doc = el('div', '', 'vd-agreement');
    window.ventureMarkdown ? window.ventureMarkdown.into(doc, ag.body, new Map()) : (doc.textContent = ag.body);
    body.append(doc);

    const signature = (side, label, signedName, signedAt, canSign) => {
      const block = h('div', `vd-signature${signedAt ? ' signed' : ''}`, el('span', label, 'vd-stat-label'));
      if (signedAt) { block.append(el('strong', signedName, 'vd-signed-name'), el('span', `Signed ${date(signedAt)}`, 'vd-sub')); return block; }
      if (!canSign) { block.append(el('span', ag.status === 'changes_requested' ? 'Waiting for LFG to respond' : 'Not signed yet', 'vd-sub')); return block; }
      const name = el('input'); name.placeholder = 'Type your full name'; name.setAttribute('aria-label', `${label} signature`);
      const consent = el('input'); consent.type = 'checkbox';
      const go = btn('Sign agreement', async () => {
        if (name.value.trim().length < 2 || !consent.checked) { alert('Type your full name and tick the box to sign.'); return; }
        go.disabled = true;
        try { await api(`/api/venture/agreements/${encodeURIComponent(ag.id)}/sign`, { method: 'POST', body: JSON.stringify({ side, name: name.value.trim(), consent: true }) }); await reload(true); }
        catch (error) { go.disabled = false; alert(errorText(error)); }
      }, 'vd-btn primary small');
      block.append(name, h('label', 'vd-consent', consent, el('span', `I have read this agreement and agree to it on behalf of ${side === 'founder' ? 'myself as the founder' : 'LFG'}.`)), go);
      return block;
    };
    body.append(h('div', 'vd-signatures',
      signature('founder', 'Founder', ag.founderSignedName, ag.founderSignedAt, data.isOwner && ag.status === 'awaiting_signatures'),
      signature('lfg', 'LFG', ag.lfgSignedName, ag.lfgSignedAt, isAdmin && ag.status === 'awaiting_signatures')));

    if (messages.length || ag.status !== 'active') {
      const thread = h('div', 'vd-thread', el('h3', 'Negotiation'));
      if (!messages.length) thread.append(el('p', 'No change requests. The founder can ask to renegotiate before signing; LFG reviews every request manually.', 'vd-sub'));
      const KIND = { change_request: 'asked for changes', reply: 'replied', revision: 'revised the terms' };
      for (const m of messages) {
        const proposed = m.proposedTerms && m.proposedTerms.structure ? dealLine(m.proposedTerms, m.proposedTerms.tokens ?? ag.tokensCommitted) : null;
        thread.append(h('div', `vd-msg ${m.side}`, h('div', 'vd-msg-head', el('strong', m.side === 'lfg' ? 'LFG' : (m.authorName || 'Founder')), el('span', `${KIND[m.kind]} · ${date(m.createdAt)}`, 'vd-sub')), el('p', m.message), proposed ? el('p', `Proposed: ${proposed}`, 'vd-sub') : null));
      }
      if (data.isOwner && ag.status === 'awaiting_signatures' && !ag.founderSignedAt) {
        const text = el('textarea'); text.rows = 3; text.placeholder = 'What would you like to change, and why?'; text.setAttribute('aria-label', 'Change request');
        const fields = termFields({}, true);
        const send = btn('Request changes', async () => {
          if (text.value.trim().length < 5) { alert('Explain what you would like to change.'); return; }
          send.disabled = true;
          try { const proposed = fields.read(); await api(`/api/venture/agreements/${encodeURIComponent(ag.id)}/changes`, { method: 'POST', body: JSON.stringify({ message: text.value.trim(), ...(proposed ? { proposed } : {}) }) }); await reload(true); }
          catch (error) { send.disabled = false; alert(errorText(error)); }
        }, 'vd-btn small');
        thread.append(h('details', 'vd-renegotiate', el('summary', 'Want different terms? Ask to renegotiate'), el('p', 'LFG reviews requests manually and replies here, either with revised terms (a new version to sign) or keeping these.', 'vd-sub'), text, el('span', 'Proposed terms (optional)', 'vd-stat-label'), fields.node, send));
      }
      if (isAdmin && ag.status === 'changes_requested') {
        const text = el('textarea'); text.rows = 3; text.placeholder = 'Reply to the founder'; text.setAttribute('aria-label', 'Reply to change request');
        const fields = termFields(ag);
        const tokensInput = el('input'); tokensInput.type = 'number'; tokensInput.value = String(ag.tokensCommitted); tokensInput.setAttribute('aria-label', 'Tokens committed');
        const respond = async revise => {
          if (text.value.trim().length < 2) { alert('Write a reply to the founder.'); return; }
          try {
            const revised = revise ? { ...fields.read(), tokens: Number(tokensInput.value) || ag.tokensCommitted } : undefined;
            await api(`/api/venture/admin/agreements/${encodeURIComponent(ag.id)}/respond`, { method: 'POST', body: JSON.stringify({ message: text.value.trim(), ...(revised ? { revised } : {}) }) }); await reload(true);
          } catch (error) { alert(errorText(error)); }
        };
        thread.append(h('div', 'vd-respond', el('h3', 'Respond to the change request'), text, fields.node, h('label', 'vd-field', el('span', 'Tokens committed'), tokensInput),
          h('div', 'vd-new-actions', btn('Keep current terms', () => respond(false), 'vd-btn small'), btn('Send revised terms', () => respond(true), 'vd-btn primary small'))));
      }
      body.append(thread);
    }
    if (versions.length > 1) body.append(h('details', 'vd-history', el('summary', `Versions (${versions.length})`), ...versions.map(v => el('p', `v${v.version} · ${v.status.replace('_', ' ')} · ${v.summary} · ${date(v.createdAt)}`, 'vd-sub'))));
    box.append(body);
    if (needsMe || needsLfg || openDeal) box.open = true;
    box.addEventListener('toggle', () => { openDeal = box.open; });
    return box;
  }
  const dealLine = (d, t) => d.structure === 'equity' ? `${d.equityPercent}% equity` : `${d.revenueSharePercent}% of ${d.structure === 'revenue_share' ? 'revenue' : 'profit'} until ${d.capMultiple}× (${usd(t / 1e6 * rate * d.capMultiple)}) or ${d.termMonths} months`;

  function decisionNote(data, r) {
    const d = data.decision;
    const note = (tone, title, text, extra) => h('div', `vd-callout ${tone}`, el('strong', title), text ? el('p', text) : null, extra || null);
    const ag = data.agreements.current;
    if (ag && ag.status !== 'active') {
      const mine = (data.isOwner && !ag.founderSignedAt) || (isAdmin && !ag.lfgSignedAt);
      return ag.status === 'changes_requested'
        ? note('warn', 'The founder asked to change the terms', isAdmin ? 'Review the request in the Deal section and revise the terms or reply.' : 'LFG is reviewing your request. You’ll see revised terms or a reply in the Deal section.')
        : note('warn', `Approved: ${DEAL[ag.structure]} agreement ready to sign`, `${ag.summary}. Work starts once both sides sign.${mine ? ' Open the Deal section to read and sign it.' : ''}`);
    }
    if (d) {
      const [label, tone] = DECISION[d.decision];
      return note(tone, d.decision === 'approved' ? `LFG approved ${tokens(d.tokensApproved)} (≈ ${cost(d.tokensApproved)}) on ${date(d.createdAt)}` : `LFG decision: ${label}`, d.founderNote ? `“${d.founderNote}”` : null, isAdmin && d.internalNote ? el('p', `Internal: ${d.internalNote}`, 'vd-sub') : null);
    }
    if (!data.assessment) return note('neutral', 'Not assessed yet', data.isOwner ? 'Keep talking with the analyst, then generate an assessment from the Assessment tab in chat.' : 'The founder hasn’t generated an assessment yet.');
    if (!r) return note('neutral', 'This assessment predates verdicts', 'Regenerate it from the chat to get a verdict and token tranche.');
    return note('neutral', 'Awaiting LFG review', 'The analyst’s verdict is a recommendation. LFG’s venture team makes the funding decision.');
  }

  // ---- detail: assessment -------------------------------------------------
  function tranche(r, sources) {
    if (r.verdict !== 'fund' || !r.tokenTranche.lineItems.length) return card('Recommended tranche', el('p', 'No tranche is recommended at this stage.', 'vd-muted'), el('h3', 'Reasoning'), claims([r.tokenTranche.expectedReturn], sources));
    const total = r.tokenTranche.totalTokens;
    return card('Recommended tranche',
      h('div', 'vd-total', el('span', 'First tranche', 'vd-stat-label'), h('div', 'vd-stack vd-right', el('strong', tokens(total)), el('span', `≈ ${cost(total)}`, 'vd-sub'))),
      h('div', 'vd-lines', ...r.tokenTranche.lineItems.map(item => h('div', 'vd-line',
        h('div', 'vd-line-top', h('div', 'vd-work-title', item.workType ? el('span', WORK[item.workType] || item.workType, 'vd-type') : null, el('strong', item.item)), el('span', tokens(item.tokens), 'vd-line-amount')),
        h('div', 'vd-track wide', barOf(Math.max(3, Math.round(100 * item.tokens / total)))),
        item.deliverable ? el('p', item.deliverable, 'vd-deliverable') : null,
        el('p', item.rationale, 'vd-sub')))),
      el('h3', 'Expected return'), claims([r.tokenTranche.expectedReturn], sources));
  }

  function market(a, sources) {
    const { market: m, revenue: rev, units } = a;
    const max = Math.max(...[m.tam, m.sam, m.som].map(c => c.amount || 0), 1);
    const funnel = h('div', 'vd-funnel', ...[['TAM', 'Total market', m.tam], ['SAM', 'Serviceable', m.sam], ['SOM', 'Obtainable', m.som]].map(([label, name, c]) => h('div', 'vd-funnel-row',
      h('div', 'vd-stack', el('strong', label), el('span', name, 'vd-sub')),
      h('div', 'vd-track wide tall', barOf(c.amount ? Math.max(4, Math.round(100 * Math.sqrt(c.amount / max))) : 0)),
      h('div', 'vd-stack vd-right', el('strong', usdShort(c.amount)), el('span', c.customers !== null && c.pricePerCustomer !== null ? `${compact(c.customers)} × ${usdShort(c.pricePerCustomer)}` : 'Input needed', 'vd-sub')))));
    const scenario = (label, c) => h('div', 'vd-scenario', el('span', label, 'vd-stat-label'), el('strong', usdShort(c.amount)), el('span', c.customers !== null ? `${compact(c.customers)} customers / ${units.period}` : 'Input needed', 'vd-sub'));
    return card('Market opportunity',
      el('p', `${units.geography} · US dollars per ${units.period}`, 'vd-muted vd-tight'),
      funnel,
      el('h3', 'Revenue scenarios'),
      h('div', 'vd-scenarios', scenario('Conservative', rev.conservative), scenario('Base', rev.base), scenario('Upside', rev.upside)),
      h('div', 'vd-two', h('div', '', el('h3', 'Customer pain'), claims(a.opportunity.customerPain, sources)), h('div', '', el('h3', 'Competition'), claims(a.opportunity.competition, sources))));
  }

  function founderFit(a, sources) {
    const f = a.founderFit;
    return card('Founder fit', h('div', 'vd-two',
      h('div', '', el('h3', 'Strengths'), claims(f.rationale, sources)),
      h('div', '', el('h3', 'Recommended changes'), claims(f.recommendedChanges, sources)),
      h('div', '', el('h3', 'Capability gaps'), claims(f.capabilityGaps, sources)),
      h('div', '', el('h3', 'Distribution gaps'), claims(f.distributionGaps, sources))));
  }

  function gtm(a, sources) {
    return card('Go-to-market',
      h('div', 'vd-two', h('div', '', el('h3', 'Target segment'), claims(a.gtm.targetSegment, sources)), h('div', '', el('h3', 'Channels'), claims(a.gtm.channels, sources))),
      el('h3', 'Experiments'),
      h('ul', 'vd-experiments', ...a.gtm.experiments.map(x => h('li', '', el('span', x.experiment.text), x.suggestedBudget !== null ? el('span', usd(x.suggestedBudget), 'vd-pill neutral') : null))));
  }

  // ---- detail: side column ------------------------------------------------
  function todos(data) {
    const section = card(data.isOwner ? 'Your to-dos' : 'Founder to-dos');
    if (!data.tasks.length) { section.append(el('p', 'The analyst sets commitments with the next assessment.', 'vd-muted')); return section; }
    const done = () => data.tasks.filter(t => t.done).length;
    const bar = barOf(Math.round(100 * done() / data.tasks.length));
    const count = el('span', `${done()} of ${data.tasks.length} done`, 'vd-sub');
    section.append(h('div', 'vd-progress-head', h('div', 'vd-track wide', bar), count));
    section.append(h('ul', 'vd-todos', ...data.tasks.map(t => {
      const box = el('input'); box.type = 'checkbox'; box.checked = t.done; box.disabled = !data.isOwner;
      box.onchange = async () => {
        box.disabled = true;
        try {
          await api(`/api/venture/tasks/${encodeURIComponent(t.id)}`, { method: 'PATCH', body: JSON.stringify({ done: box.checked }) });
          t.done = box.checked; const v = ventures.find(x => x.id === selected); if (v) v.tasks.done += box.checked ? 1 : -1;
          bar.style.width = `${Math.round(100 * done() / data.tasks.length)}%`; count.textContent = `${done()} of ${data.tasks.length} done`;
        } catch (error) { box.checked = !box.checked; alert(errorText(error)); }
        finally { box.disabled = false; }
      };
      return h('li', '', h('label', '', box, h('div', '', el('strong', t.action), el('span', [t.dueWeek !== null ? `Week ${t.dueWeek}` : null, t.successSignal].filter(Boolean).join(' · '), 'vd-sub'))));
    })));
    return section;
  }

  function decisionForm(data, r, reload) {
    const form = el('form', '', 'vd-card vd-decide');
    const choice = el('select'); choice.setAttribute('aria-label', 'Decision');
    [['approved', 'Approve tranche'], ['needs_more_info', 'Needs more info'], ['declined', 'Decline'], ['prohibited', 'Prohibited (illegal / harmful)']].forEach(([v, l]) => choice.append(new Option(l, v)));
    const amount = el('input'); amount.type = 'number'; amount.min = '0'; amount.step = '1000'; amount.setAttribute('aria-label', 'Tokens approved');
    const suggested = { fund: 'approved', needs_more_info: 'needs_more_info', decline: 'declined', prohibited: 'prohibited' };
    choice.value = suggested[r?.verdict] || 'needs_more_info';
    // Start from what LFG already decided, else from the analyst's recommendation.
    if (data.decision) choice.value = data.decision.decision;
    amount.value = String(data.decision?.decision === 'approved' ? data.decision.tokensApproved : r?.verdict === 'fund' ? r.tokenTranche.totalTokens : 0);
    const dollars = el('span', '', 'vd-sub');
    const deal = termFields(data.agreements.current ?? r?.deal ?? {});
    const dealBox = h('div', 'vd-deal-terms', el('span', 'Deal terms (the agreement both sides sign)', 'vd-stat-label'), deal.node);
    const sync = () => { amount.disabled = choice.value !== 'approved'; dealBox.hidden = amount.disabled; if (amount.disabled) amount.value = '0'; dollars.textContent = Number(amount.value) ? `≈ ${cost(Number(amount.value))}` : ''; };
    choice.onchange = sync; amount.oninput = sync; sync();
    const note = el('textarea'); note.rows = 2; note.maxLength = 2000; note.placeholder = 'Note to the founder (they’ll see this)';
    const internal = el('textarea'); internal.rows = 2; internal.maxLength = 4000; internal.placeholder = 'Internal note (LFG only)';
    const submit = el('button', data.decision ? 'Update decision' : 'Record decision', 'vd-btn primary'); submit.type = 'submit';
    const feedback = el('p', '', 'vd-muted'); feedback.setAttribute('role', 'status');
    const field = (label, input, extra) => h('label', 'vd-field', el('span', label), input, extra || null);
    form.append(el('h2', 'Record LFG decision'), el('p', [data.owner?.name, data.owner?.email].filter(Boolean).join(' · '), 'vd-sub'),
      field('Decision', choice), field('Tokens approved', amount, dollars), dealBox, note, internal,
      el('p', 'Approving generates the agreement. Work starts only after the founder and LFG both sign it.', 'vd-sub'), submit, feedback);
    form.onsubmit = async e => {
      e.preventDefault(); submit.disabled = true; feedback.textContent = 'Saving…';
      try {
        await api(`/api/venture/admin/conversations/${encodeURIComponent(data.conversation.id)}/decision`, { method: 'POST', body: JSON.stringify({ decision: choice.value, tokensApproved: Number(amount.value) || 0, founderNote: note.value.trim() || undefined, internalNote: internal.value.trim() || undefined, ...(choice.value === 'approved' ? { deal: deal.read() } : {}) }) });
        await reload(true);
      } catch (error) { feedback.textContent = errorText(error); submit.disabled = false; }
    };
    if (data.decisions.length > 1) {
      const hist = h('details', 'vd-history', el('summary', `Decision history (${data.decisions.length})`));
      for (const d of data.decisions) hist.append(el('p', `${date(d.createdAt)} · ${DECISION[d.decision][0]} · ${tokens(d.tokensApproved)}${d.internalNote ? ` · ${d.internalNote}` : ''}`, 'vd-sub'));
      form.append(hist);
    }
    return form;
  }

  function transcript(data, sources) {
    const box = h('details', 'vd-card vd-transcript', el('summary', 'Conversation transcript'));
    let fetched = false;
    box.ontoggle = async () => {
      if (!box.open || fetched) return; fetched = true;
      const body = el('div', 'Loading…', 'vd-muted'); box.append(body);
      try {
        const { messages } = await api(`/api/venture/conversations/${encodeURIComponent(data.conversation.id)}`);
        body.replaceChildren(); body.className = 'vd-messages';
        for (const m of messages.filter(m => m.content)) {
          const bubble = el('div', m.role === 'user' ? m.content : '', `va-message ${m.role === 'user' ? 'user' : ''}`);
          if (m.role !== 'user') window.ventureMarkdown ? window.ventureMarkdown.into(bubble, m.content, sources) : (bubble.textContent = m.content);
          body.append(bubble);
        }
        if (!body.childElementCount) body.append(el('p', 'No messages yet.', 'vd-muted'));
      } catch (error) { body.textContent = errorText(error); fetched = false; }
    };
    return box;
  }

  // ---- detail view --------------------------------------------------------
  async function renderDetail(id) {
    const back = link('← All ventures', url(null), 'vd-back');
    back.onclick = e => { e.preventDefault(); go(null); };
    if (!root.querySelector('.vd-detail-head')) root.replaceChildren(back, el('p', 'Loading venture…', 'vd-loading'));
    const reload = async keepDealOpen => { if (keepDealOpen) openDeal = true; await refreshList(); await renderDetail(id); };
    try {
      const data = await api(`/api/venture/conversations/${encodeURIComponent(id)}/overview`);
      if (id !== selected) return;
      rate = data.usdPerMillionTokens || rate;
      document.title = `${data.conversation.title} | LFG`;
      const sources = new Map(data.sources.map(s => [s.id, s]));
      const a = data.assessment?.contentJson, r = a?.recommendation;
      const tags = h('div', 'vd-head-tags',
        data.decision ? pill(DECISION[data.decision.decision]) : pill(r ? ['Awaiting review', 'neutral'] : ['Not assessed', 'muted']),
        r ? dot(VERDICT[r.verdict]) : null, r ? el('span', `Analyst${r.tier ? ` · ${TIER[r.tier]}` : ''}`, 'vd-sub') : null,
        el('span', [data.owner ? (data.owner.name || data.owner.email) : null, data.assessment ? `Assessment v${data.assessment.version}, ${date(data.assessment.createdAt)}` : null].filter(Boolean).join(' · '), 'vd-sub'));
      const head = h('div', 'vd-detail-head',
        h('div', '', el('h1', data.conversation.title), tags),
        data.isOwner ? link('Open chat', `/venture-analyst/chat?c=${encodeURIComponent(id)}`, 'vd-btn primary') : null);

      const main = h('div', 'vd-main'), side = h('aside', 'vd-side');
      main.append(...[building(data, r, reload), (data.progress.total || data.metrics.length) ? results(data, reload) : null, timeline(data)].filter(Boolean));
      if (a) {
        main.append(h('div', 'vd-divider', el('span', 'Assessment'), el('span', `by the analyst · v${data.assessment.version}`, 'vd-sub')));
        if (r) {
          main.append(card('Why this verdict', el('p', r.summary, 'vd-lead'), claims(r.rationale, sources)));
          if (r.complianceFlags?.length) main.append(h('section', 'vd-card vd-flags', el('h2', 'Compliance flags'), claims(r.complianceFlags, sources)));
          main.append(tranche(r, sources));
        }
        main.append(market(a, sources), founderFit(a, sources), gtm(a, sources), card('Risks and uncertainties', claims(a.uncertainties, sources)));
      }
      if (isAdmin && (scope === 'all' || !data.isOwner)) side.append(decisionForm(data, r, reload));
      if (r) side.append(todos(data), card('Next steps', h('ol', 'vd-steps', ...r.nextSteps.map(s => el('li', s)))));
      if (a?.missingInputs.length) side.append(card('Missing inputs', h('ul', 'vd-plain', ...a.missingInputs.map(m => el('li', m)))));
      if (isAdmin) side.append(transcript(data, sources));

      root.replaceChildren(back, head, decisionNote(data, r), stateStrip(data, r), dealCard(data, r, reload) || '',
        main.childElementCount ? h('div', 'vd-detail-grid', main, side) : side,
        el('p', `Dollar figures convert tokens at ${usd(rate, 2)} per million. Market figures, token sizes and timelines in the assessment are scenarios, not promises.`, 'vd-footnote'));
    } catch (error) {
      if (id !== selected) return;
      root.replaceChildren(back, h('div', 'vd-state', el('p', errorText(error), 'vd-error'), btn('Retry', () => renderDetail(id))));
    }
  }

  load();
})();
