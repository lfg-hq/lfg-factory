// Venture dashboard. Two views rendered into #vd:
//  - list (default): every venture at a glance, with filters;
//  - detail (?v=id): one venture's verdict, tranche, market, to-dos and steps.
// Founders see their own ventures; LFG reviewers can switch to all founders and
// record the binding decision. Server content is rendered with textContent,
// except sanitized Markdown in the transcript.
(() => {
  'use strict';
  const root = document.getElementById('vd');
  const params = new URLSearchParams(location.search);
  let scope = params.get('scope') === 'all' ? 'all' : 'mine';
  let selected = params.get('v'), filter = 'all', isAdmin = false, ventures = [];

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
  const barOf = pct => { const bar = el('span'); bar.style.width = `${pct}%`; return bar; };

  // ---- formatting ---------------------------------------------------------
  const VERDICT = { fund: ['Fund', 'good'], needs_more_info: ['Needs more info', 'warn'], decline: ['Decline', 'bad'], prohibited: ['Prohibited', 'bad'] };
  const DECISION = { approved: ['Approved', 'good'], needs_more_info: ['Needs more info', 'warn'], declined: ['Declined', 'bad'], prohibited: ['Prohibited', 'bad'] };
  const TIER = { micro: 'Micro business', small_business: 'Small business', venture_scale: 'Venture scale' };
  const dot = ([label, tone]) => el('span', label, `vd-dot ${tone}`);
  const pill = ([label, tone]) => el('span', label, `vd-pill ${tone}`);
  const compact = n => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  const tokens = n => n === null || n === undefined ? '—' : `${compact(n)} tokens`;
  const money = (n, units) => {
    if (n === null || n === undefined) return 'Unknown';
    try { return new Intl.NumberFormat('en', { style: 'currency', currency: units?.currency || 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(n); }
    catch { return String(n); }
  };
  const date = d => d ? new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  function ago(d) {
    const days = Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000);
    return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : days < 30 ? `${days} days ago` : date(d);
  }
  const lfgStatus = v => v.decision ? DECISION[v.decision.decision] : v.assessment?.verdict ? ['Awaiting review', 'neutral'] : ['Not assessed', 'muted'];

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
  function go(id) { selected = id; history.pushState(null, '', url()); render(); window.scrollTo(0, 0); }
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

  async function load() {
    root.replaceChildren(el('p', 'Loading…', 'vd-loading'));
    try {
      const data = await api(`/api/venture/dashboard${scope === 'all' ? '?scope=all' : ''}`);
      isAdmin = data.isAdmin; ventures = data.ventures; showViewer(data.viewer);
      render();
    } catch (error) {
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
    ['review', 'Awaiting review', v => !v.decision && Boolean(v.assessment?.verdict)],
    ['approved', 'Approved', v => v.decision?.decision === 'approved'],
    ['info', 'Needs info', v => (v.decision?.decision || v.assessment?.verdict) === 'needs_more_info'],
    ['closed', 'Declined', v => ['declined', 'prohibited', 'decline'].includes(v.decision?.decision || v.assessment?.verdict)],
    ['draft', 'Not assessed', v => !v.assessment],
  ];

  function stats() {
    const approved = ventures.filter(v => v.decision?.decision === 'approved');
    const committed = approved.reduce((sum, v) => sum + v.decision.tokensApproved, 0);
    const openTodos = ventures.reduce((sum, v) => sum + v.tasks.total - v.tasks.done, 0);
    const stat = (label, value, hint) => h('div', 'vd-stat', el('span', label, 'vd-stat-label'), el('strong', value), el('span', hint, 'vd-sub'));
    return h('div', 'vd-stats',
      stat('Ventures', String(ventures.length), `${ventures.filter(v => v.assessment).length} assessed`),
      stat('Awaiting review', String(ventures.filter(FILTERS[1][2]).length), scope === 'all' ? 'Need an LFG decision' : 'With LFG’s team'),
      stat('Approved', String(approved.length), `${tokens(committed)} committed`),
      stat(scope === 'all' ? 'Open founder to-dos' : 'Your open to-dos', String(openTodos), 'Across all ventures'));
  }

  function row(v) {
    const r = v.assessment, verdict = r?.verdict ? VERDICT[r.verdict] : null;
    const item = el('a', '', 'vd-row');
    item.href = url(v.id);
    item.onclick = e => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; e.preventDefault(); go(v.id); };
    const progress = v.tasks.total ? h('div', 'vd-progress', h('div', 'vd-track', barOf(Math.round(100 * v.tasks.done / v.tasks.total))), el('span', `${v.tasks.done}/${v.tasks.total}`, 'vd-sub')) : el('span', '—', 'vd-faint');
    const approved = v.decision?.decision === 'approved';
    const tokenCell = approved ? h('div', 'vd-stack', el('strong', tokens(v.decision.tokensApproved)), el('span', 'approved', 'vd-sub'))
      : r?.recommendedTokens ? h('div', 'vd-stack', el('span', tokens(r.recommendedTokens)), el('span', 'recommended', 'vd-sub')) : el('span', '—', 'vd-faint');
    const subtitle = [v.owner ? (v.owner.name || v.owner.email) : null, r?.summary || (r ? 'Assessed before verdicts existed' : 'In conversation with the analyst')].filter(Boolean).join(' · ');
    item.append(
      h('div', 'vd-cell vd-cell-main', el('strong', v.title, 'vd-row-title'), el('span', subtitle, 'vd-sub vd-clamp')),
      h('div', 'vd-cell vd-stack', verdict ? dot(verdict) : el('span', '—', 'vd-faint'), r?.tier ? el('span', TIER[r.tier], 'vd-sub') : null),
      h('div', 'vd-cell', tokenCell),
      h('div', 'vd-cell', pill(lfgStatus(v))),
      h('div', 'vd-cell', progress),
      h('div', 'vd-cell vd-cell-end', el('span', ago(v.updatedAt), 'vd-sub')));
    return item;
  }

  function renderList() {
    document.title = 'Ventures | LFG';
    const head = h('div', 'vd-pagehead',
      h('div', '', el('h1', scope === 'all' ? 'Venture review' : 'Your ventures'), el('p', scope === 'all' ? 'Every founder’s venture, with the analyst’s verdict and LFG’s decision.' : 'The analyst’s verdict, LFG’s decision and your next steps for each idea.', 'vd-muted')),
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
      h('div', 'vd-row vd-row-head', ...['Venture', 'Analyst verdict', 'Tokens', 'LFG decision', 'To-dos', 'Updated'].map((t, i) => el('span', t, `vd-cell${i === 5 ? ' vd-cell-end' : ''}`))),
      ...shown.map(row));
    root.replaceChildren(head, stats(), chips, table);
  }

  // ---- detail view --------------------------------------------------------
  const card = (title, ...children) => h('section', 'vd-card', title ? el('h2', title) : null, ...children);
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

  function metrics(data, r) {
    const d = data.decision;
    const m = (label, value, sub) => h('div', 'vd-metric', el('span', label, 'vd-stat-label'), value, sub ? el('span', sub, 'vd-sub') : null);
    return h('div', 'vd-metrics',
      m('Analyst verdict', r ? dot(VERDICT[r.verdict]) : el('strong', '—'), r?.tier ? TIER[r.tier] : null),
      m('Recommended tranche', el('strong', r?.verdict === 'fund' ? tokens(r.tokenTranche.totalTokens) : '—'), r?.verdict === 'fund' ? `${r.tokenTranche.lineItems.length} line items` : null),
      m('LFG decision', d ? pill(DECISION[d.decision]) : pill(r ? ['Awaiting review', 'neutral'] : ['Not assessed', 'muted']), d ? (d.decision === 'approved' ? `${tokens(d.tokensApproved)} · ${date(d.createdAt)}` : date(d.createdAt)) : null),
      m('Next check-in', el('strong', r?.checkInWeeks ? `In ${r.checkInWeeks} week${r.checkInWeeks === 1 ? '' : 's'}` : '—'), data.assessment ? `from ${date(data.assessment.createdAt)}` : null));
  }

  function decisionNote(data, r) {
    const d = data.decision;
    const note = (tone, title, text, extra) => h('div', `vd-callout ${tone}`, el('strong', title), text ? el('p', text) : null, extra || null);
    if (d) {
      const [label, tone] = DECISION[d.decision];
      return note(tone, d.decision === 'approved' ? `LFG approved ${tokens(d.tokensApproved)}` : `LFG decision: ${label}`, d.founderNote ? `“${d.founderNote}”` : null, isAdmin && d.internalNote ? el('p', `Internal: ${d.internalNote}`, 'vd-sub') : null);
    }
    if (!data.assessment) return note('neutral', 'Not assessed yet', data.isOwner ? 'Keep talking with the analyst, then generate an assessment from the Assessment tab in chat.' : 'The founder hasn’t generated an assessment yet.');
    if (!r) return note('neutral', 'This assessment predates verdicts', 'Regenerate it from the chat to get a verdict and token tranche.');
    return note('neutral', 'Awaiting LFG review', 'The analyst’s verdict is a recommendation. LFG’s venture team makes the funding decision.');
  }

  function tranche(r, sources) {
    if (r.verdict !== 'fund' || !r.tokenTranche.lineItems.length) return card('Token tranche', el('p', 'No tranche is recommended at this stage.', 'vd-muted'), el('h3', 'Reasoning'), claims([r.tokenTranche.expectedReturn], sources));
    const total = r.tokenTranche.totalTokens;
    return card('Token tranche',
      h('div', 'vd-total', el('span', 'First tranche', 'vd-stat-label'), el('strong', tokens(total))),
      h('div', 'vd-lines', ...r.tokenTranche.lineItems.map(item => h('div', 'vd-line',
        h('div', 'vd-line-top', el('strong', item.item), el('span', tokens(item.tokens), 'vd-line-amount')),
        h('div', 'vd-track wide', barOf(Math.max(3, Math.round(100 * item.tokens / total)))),
        el('p', item.rationale, 'vd-sub')))),
      el('h3', 'Expected return'), claims([r.tokenTranche.expectedReturn], sources));
  }

  function market(a, sources) {
    const { market: m, revenue: rev, units } = a;
    const max = Math.max(...[m.tam, m.sam, m.som].map(c => c.amount || 0), 1);
    const funnel = h('div', 'vd-funnel', ...[['TAM', 'Total market', m.tam], ['SAM', 'Serviceable', m.sam], ['SOM', 'Obtainable', m.som]].map(([label, name, c]) => h('div', 'vd-funnel-row',
      h('div', 'vd-stack', el('strong', label), el('span', name, 'vd-sub')),
      h('div', 'vd-track wide tall', barOf(c.amount ? Math.max(4, Math.round(100 * Math.sqrt(c.amount / max))) : 0)),
      h('div', 'vd-stack vd-right', el('strong', money(c.amount, units)), el('span', c.customers !== null && c.pricePerCustomer !== null ? `${compact(c.customers)} × ${money(c.pricePerCustomer, units)}` : 'Input needed', 'vd-sub')))));
    const scenario = (label, c) => h('div', 'vd-scenario', el('span', label, 'vd-stat-label'), el('strong', money(c.amount, units)), el('span', c.customers !== null ? `${compact(c.customers)} customers / ${units.period}` : 'Input needed', 'vd-sub'));
    return card('Market opportunity',
      el('p', `${units.geography} · ${units.currency} per ${units.period}`, 'vd-muted vd-tight'),
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
      h('ul', 'vd-experiments', ...a.gtm.experiments.map(x => h('li', '', el('span', x.experiment.text), x.suggestedBudget !== null ? el('span', money(x.suggestedBudget, { currency: a.units.currency }), 'vd-pill neutral') : null))));
  }

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

  function decisionForm(data, r) {
    const form = el('form', '', 'vd-card vd-decide');
    const choice = el('select'); choice.setAttribute('aria-label', 'Decision');
    [['approved', 'Approve tranche'], ['needs_more_info', 'Needs more info'], ['declined', 'Decline'], ['prohibited', 'Prohibited (illegal / harmful)']].forEach(([v, l]) => choice.append(new Option(l, v)));
    const amount = el('input'); amount.type = 'number'; amount.min = '0'; amount.step = '1000'; amount.setAttribute('aria-label', 'Tokens approved');
    const suggested = { fund: 'approved', needs_more_info: 'needs_more_info', decline: 'declined', prohibited: 'prohibited' };
    choice.value = suggested[r?.verdict] || 'needs_more_info';
    amount.value = String(r?.verdict === 'fund' ? r.tokenTranche.totalTokens : 0);
    const sync = () => { amount.disabled = choice.value !== 'approved'; if (amount.disabled) amount.value = '0'; };
    choice.onchange = sync; sync();
    const note = el('textarea'); note.rows = 2; note.maxLength = 2000; note.placeholder = 'Note to the founder (they’ll see this)';
    const internal = el('textarea'); internal.rows = 2; internal.maxLength = 4000; internal.placeholder = 'Internal note (LFG only)';
    const submit = el('button', data.decision ? 'Update decision' : 'Record decision', 'vd-btn primary'); submit.type = 'submit';
    const feedback = el('p', '', 'vd-muted'); feedback.setAttribute('role', 'status');
    const field = (label, input) => h('label', 'vd-field', el('span', label), input);
    form.append(el('h2', 'Record LFG decision'), el('p', [data.owner?.name, data.owner?.email].filter(Boolean).join(' · '), 'vd-sub'),
      field('Decision', choice), field('Tokens approved', amount), note, internal, submit, feedback);
    form.onsubmit = async e => {
      e.preventDefault(); submit.disabled = true; feedback.textContent = 'Saving…';
      try {
        await api(`/api/venture/admin/conversations/${encodeURIComponent(data.conversation.id)}/decision`, { method: 'POST', body: JSON.stringify({ decision: choice.value, tokensApproved: Number(amount.value) || 0, founderNote: note.value.trim() || undefined, internalNote: internal.value.trim() || undefined }) });
        ventures = (await api(`/api/venture/dashboard${scope === 'all' ? '?scope=all' : ''}`)).ventures;
        renderDetail(data.conversation.id);
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

  async function renderDetail(id) {
    const back = link('← All ventures', url(null), 'vd-back');
    back.onclick = e => { e.preventDefault(); go(null); };
    root.replaceChildren(back, el('p', 'Loading venture…', 'vd-loading'));
    try {
      const data = await api(`/api/venture/conversations/${encodeURIComponent(id)}/overview`);
      if (id !== selected) return;
      document.title = `${data.conversation.title} | LFG`;
      const sources = new Map(data.sources.map(s => [s.id, s]));
      const a = data.assessment?.contentJson, r = a?.recommendation;
      const meta = [data.owner ? (data.owner.name || data.owner.email) : null, data.assessment ? `Assessment v${data.assessment.version}, ${data.assessment.status}, ${date(data.assessment.createdAt)}` : 'Not assessed yet'].filter(Boolean).join(' · ');
      const head = h('div', 'vd-detail-head',
        h('div', '', el('h1', data.conversation.title), el('p', meta, 'vd-muted')),
        data.isOwner ? link('Open chat', `/venture-analyst/chat?c=${encodeURIComponent(id)}`, 'vd-btn primary') : null);

      const main = h('div', 'vd-main'), side = h('aside', 'vd-side');
      if (r) {
        main.append(card('Why this verdict', el('p', r.summary, 'vd-lead'), claims(r.rationale, sources)));
        if (r.complianceFlags?.length) main.append(h('section', 'vd-card vd-flags', el('h2', 'Compliance flags'), claims(r.complianceFlags, sources)));
        main.append(tranche(r, sources));
      }
      if (a) main.append(market(a, sources), founderFit(a, sources), gtm(a, sources), card('Risks and uncertainties', claims(a.uncertainties, sources)));
      if (isAdmin && (scope === 'all' || !data.isOwner)) side.append(decisionForm(data, r));
      if (r) side.append(todos(data), card('Next steps', h('ol', 'vd-steps', ...r.nextSteps.map(s => el('li', s)))));
      if (a?.missingInputs.length) side.append(card('Missing inputs', h('ul', 'vd-plain', ...a.missingInputs.map(m => el('li', m)))));
      if (isAdmin) side.append(transcript(data, sources));

      root.replaceChildren(back, head, decisionNote(data, r), metrics(data, r),
        main.childElementCount ? h('div', 'vd-detail-grid', main, side) : side,
        el('p', 'Financial figures, token sizes and timelines are scenarios, not promises. LFG’s decision is the binding one.', 'vd-footnote'));
    } catch (error) {
      if (id !== selected) return;
      root.replaceChildren(back, h('div', 'vd-state', el('p', errorText(error), 'vd-error'), btn('Retry', () => renderDetail(id))));
    }
  }

  load();
})();
