// Venture dashboard: founders see their verdict, market, tranche and to-dos;
// LFG reviewers see every founder and record the binding funding decision.
// All server content is rendered with textContent except sanitized Markdown.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const list = $('vd-list'), detail = $('vd-detail'), scopeTabs = $('vd-scope'), title = $('vd-title');
  const params = new URLSearchParams(location.search);
  let scope = params.get('scope') === 'all' ? 'all' : 'mine', selected = params.get('v'), isAdmin = false, ventures = [];

  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null && text !== '') node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const btn = (text, action, className = 'va-quiet') => { const b = el('button', text, className); b.type = 'button'; b.onclick = action; return b; };
  const link = (text, href, className = 'va-quiet va-link') => { const a = el('a', text, className); a.href = href; return a; };
  const VERDICTS = {
    fund: ['Fund', 'good'], needs_more_info: ['Needs more info', 'warn'], decline: ['Decline', 'bad'], prohibited: ['Prohibited', 'bad'],
    approved: ['Approved', 'good'], declined: ['Declined', 'bad'],
  };
  const TIERS = { micro: 'Micro business', small_business: 'Small business', venture_scale: 'Venture scale' };
  const badge = key => { const [label, tone] = VERDICTS[key] || [key, '']; return el('span', label, `vd-badge ${tone}`); };
  const tokens = n => n === null || n === undefined ? '—' : `${new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n)} tokens`;
  const money = (n, units) => {
    if (n === null || n === undefined) return 'Unknown';
    try { return `${new Intl.NumberFormat('en', { style: 'currency', currency: units?.currency || 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(n)}${units?.period ? ` / ${units.period}` : ''}`; }
    catch { return String(n); }
  };
  const when = d => d ? new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';

  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...options.headers } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || 'Request failed. Please retry.'), { status: response.status, code: data.code, requestId: data.requestId });
    return data;
  }
  const errorText = e => `${e.message}${e.requestId ? ` Correlation ID: ${e.requestId}` : ''}`;
  function syncUrl() {
    const q = new URLSearchParams();
    if (scope === 'all') q.set('scope', 'all');
    if (selected) q.set('v', selected);
    history.replaceState(null, '', `${location.pathname}${q.size ? `?${q}` : ''}`);
  }

  function signIn(error) {
    // Signed-out visitors sign in on the analyst page, then come straight back here.
    if (error?.status === 401 || error?.code === 'GOOGLE_LINK_REQUIRED') { location.replace('/venture-analyst?chat=open&next=dashboard'); return; }
    list.replaceChildren(); title.textContent = 'Your ventures';
    const card = el('div', '', 'vd-card vd-empty');
    card.append(el('h2', 'Sign in to see your ventures'), el('p', 'Your dashboard shows the analyst’s verdict, your market opportunity, token tranche and next steps.', 'va-muted'));
    if (error && error.status !== 401) card.append(el('p', errorText(error), 'va-error'));
    card.append(link('Continue with Google', '/venture-analyst?chat=open', 'va-pill'));
    detail.replaceChildren(card);
  }

  // ---- List ---------------------------------------------------------------
  function startForm() {
    const form = el('form', '', 'vd-card vd-start');
    const input = el('textarea'); input.rows = 3; input.maxLength = 4000; input.required = true;
    input.placeholder = 'Describe your idea, who it helps, and what you bring to it…'; input.setAttribute('aria-label', 'Describe a new venture');
    const go = el('button', 'Start with the analyst', 'va-send'); go.type = 'submit';
    const feedback = el('p', '', 'va-muted'); feedback.setAttribute('role', 'status');
    form.append(el('h2', 'Start a new venture'), input, go, feedback);
    input.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } };
    form.onsubmit = async e => {
      e.preventDefault(); const text = input.value.trim(); if (!text) return;
      go.disabled = true; feedback.textContent = 'Creating your conversation…';
      try {
        const { conversation } = await api('/api/venture/conversations', { method: 'POST', body: JSON.stringify({ title: text.replace(/\s+/g, ' ').slice(0, 80) }) });
        // The chat page sends this once as the first message, then forgets it.
        try { sessionStorage.setItem(`va-pending:${conversation.id}`, text); } catch { /* storage unavailable: founder retypes */ }
        location.assign(`/venture-analyst?chat=open&c=${encodeURIComponent(conversation.id)}`);
      } catch (error) { go.disabled = false; feedback.textContent = errorText(error); }
    };
    return form;
  }

  function renderList() {
    list.replaceChildren();
    if (scope === 'mine') list.append(startForm());
    if (!ventures.length) { list.append(el('p', scope === 'all' ? 'No founder has started a venture yet.' : 'No ventures yet. Describe your idea above to begin.', 'va-muted vd-pad')); return; }
    const items = el('ul', '', 'vd-items');
    for (const v of ventures) {
      const li = el('li'), b = el('button', '', `vd-item${v.id === selected ? ' active' : ''}`); b.type = 'button';
      b.onclick = () => { selected = v.id; syncUrl(); renderList(); loadDetail(); };
      const top = el('div', '', 'vd-item-top'); top.append(el('strong', v.title));
      const meta = el('div', '', 'vd-item-meta');
      if (v.owner) meta.append(el('span', v.owner.name || v.owner.email));
      if (v.assessment?.verdict) meta.append(badge(v.assessment.verdict)); else meta.append(el('span', v.assessment ? 'Assessed (no verdict)' : 'Not assessed yet'));
      meta.append(el('span', v.decision ? `LFG: ${(VERDICTS[v.decision.decision] || [v.decision.decision])[0]}${v.decision.decision === 'approved' ? ` · ${tokens(v.decision.tokensApproved)}` : ''}` : v.assessment?.verdict ? 'Pending LFG review' : ''));
      if (v.tasks.total) meta.append(el('span', `${v.tasks.done}/${v.tasks.total} to-dos`));
      b.append(top, meta, el('small', `Updated ${when(v.updatedAt)}`)); li.append(b); items.append(li);
    }
    list.append(items);
  }

  async function loadList() {
    list.replaceChildren(el('p', 'Loading ventures…', 'va-muted vd-pad'));
    try {
      const data = await api(`/api/venture/dashboard${scope === 'all' ? '?scope=all' : ''}`);
      isAdmin = data.isAdmin; ventures = data.ventures;
      scopeTabs.hidden = !isAdmin;
      if (isAdmin) {
        scopeTabs.replaceChildren(...[['mine', 'My ventures'], ['all', 'All founders']].map(([key, label]) => {
          const b = btn(label, () => { if (scope !== key) { scope = key; selected = null; syncUrl(); loadList(); } }, `vd-tab${scope === key ? ' active' : ''}`);
          b.setAttribute('aria-pressed', String(scope === key)); return b;
        }));
      }
      title.textContent = scope === 'all' ? 'Venture review' : 'Your ventures';
      if (!ventures.some(v => v.id === selected)) selected = ventures[0]?.id || null;
      syncUrl(); renderList(); loadDetail();
    } catch (error) {
      if (error.status === 401 || error.status === 403 && error.code !== 'ADMIN_REQUIRED') return signIn(error);
      list.replaceChildren(el('p', errorText(error), 'va-error vd-pad'), btn('Retry', loadList));
    }
  }

  // ---- Detail -------------------------------------------------------------
  function section(heading, ...children) {
    const s = el('section', '', 'vd-card'); s.append(el('h2', heading), ...children.filter(Boolean)); return s;
  }
  function claimList(claims, sources) {
    if (!claims?.length) return el('p', 'None recorded.', 'va-muted');
    const ul = el('ul', '', 'vd-claims');
    for (const c of claims) {
      const li = el('li'); li.append(el('span', c.kind, `vd-kind ${c.kind}`), document.createTextNode(` ${c.text}`));
      for (const id of c.sourceIds || []) {
        const src = sources.get(id); if (!src) continue;
        try { const url = new URL(src.url); if (!['http:', 'https:'].includes(url.protocol)) continue; const a = link(` ${src.title || url.hostname}`, url.href, 'va-source'); a.target = '_blank'; a.rel = 'noopener noreferrer'; li.append(a); } catch { /* skip invalid */ }
      }
      ul.append(li);
    }
    return ul;
  }
  function stat(label, value, hint) {
    const box = el('div', '', 'vd-stat'); box.append(el('small', label), el('strong', value)); if (hint) box.append(el('p', hint, 'va-muted')); return box;
  }
  function stats(...boxes) { const row = el('div', '', 'vd-stats'); row.append(...boxes); return row; }

  function verdictCards(data, r) {
    const row = el('div', '', 'vd-verdicts');
    const analyst = el('div', '', 'vd-card vd-verdict');
    analyst.append(el('small', 'ANALYST RECOMMENDATION', 'va-label'));
    if (r) {
      const head = el('div', '', 'vd-verdict-head'); head.append(badge(r.verdict), el('span', r.tier ? TIERS[r.tier] : '', 'va-muted'));
      analyst.append(head, el('div', r.verdict === 'fund' ? tokens(r.tokenTranche.totalTokens) : 'No tokens recommended', 'vd-big'), el('p', r.summary));
    } else analyst.append(el('p', data.assessment ? 'This assessment predates verdicts. Regenerate it from the chat to get a verdict and token tranche.' : 'No assessment yet. Keep talking with the analyst, then generate one from the Assessment tab.', 'va-muted'));

    const lfg = el('div', '', 'vd-card vd-verdict'); lfg.append(el('small', 'LFG DECISION', 'va-label'));
    const d = data.decision;
    if (d) {
      const head = el('div', '', 'vd-verdict-head'); head.append(badge(d.decision), el('span', `${when(d.createdAt)}${d.assessmentVersion ? ` · on assessment v${d.assessmentVersion}` : ''}`, 'va-muted'));
      lfg.append(head, el('div', d.decision === 'approved' ? tokens(d.tokensApproved) : '—', 'vd-big'));
      if (d.founderNote) lfg.append(el('p', d.founderNote));
      if (isAdmin && d.internalNote) lfg.append(el('p', `Internal: ${d.internalNote}`, 'va-muted'));
    } else lfg.append(el('p', r ? 'Pending review by LFG’s venture team. The analyst’s verdict is a recommendation, not a commitment.' : 'LFG reviews ventures once an assessment with a verdict exists.', 'va-muted'));
    row.append(analyst, lfg);
    return row;
  }

  function tranche(r, sources) {
    if (r.verdict !== 'fund' || !r.tokenTranche.lineItems.length) return section('Token tranche', el('p', 'No first tranche is recommended at this stage.', 'va-muted'), r.tokenTranche.expectedReturn && claimList([r.tokenTranche.expectedReturn], sources));
    const table = el('table', '', 'vd-table');
    const head = el('tr'); ['What LFG’s agents build', 'Tokens', 'Why'].forEach(h => head.append(el('th', h))); table.append(head);
    for (const item of r.tokenTranche.lineItems) { const tr = el('tr'); tr.append(el('td', item.item), el('td', tokens(item.tokens)), el('td', item.rationale)); table.append(tr); }
    const total = el('tr', '', 'vd-total'); total.append(el('td', 'First tranche'), el('td', tokens(r.tokenTranche.totalTokens)), el('td', r.checkInWeeks ? `Next check-in in ${r.checkInWeeks} week${r.checkInWeeks === 1 ? '' : 's'}` : '')); table.append(total);
    const wrap = el('div', '', 'vd-scroll'); wrap.append(table);
    return section('Token tranche', wrap, el('h3', 'Expected return'), claimList([r.tokenTranche.expectedReturn], sources));
  }

  function market(a, sources) {
    const { market: m, revenue: rev, units, opportunity } = a;
    const hint = c => c.customers !== null && c.pricePerCustomer !== null ? `${new Intl.NumberFormat('en').format(c.customers)} customers × ${money(c.pricePerCustomer, { currency: units.currency })}` : 'Input needed';
    return section('Market opportunity',
      el('p', `${units.geography} · ${units.currency} per ${units.period}`, 'va-muted'),
      stats(stat('TAM', money(m.tam.amount, units), hint(m.tam)), stat('SAM', money(m.sam.amount, units), hint(m.sam)), stat('SOM', money(m.som.amount, units), hint(m.som))),
      el('h3', 'Revenue scenarios'),
      stats(stat('Conservative', money(rev.conservative.amount, units), hint(rev.conservative)), stat('Base', money(rev.base.amount, units), hint(rev.base)), stat('Upside', money(rev.upside.amount, units), hint(rev.upside))),
      el('h3', 'Customer pain'), claimList(opportunity.customerPain, sources),
      el('h3', 'Competition'), claimList(opportunity.competition, sources));
  }

  function todos(data) {
    const s = section(data.isOwner ? 'Your to-dos' : 'Founder to-dos');
    if (!data.tasks.length) { s.append(el('p', 'The analyst sets your commitments with the next assessment.', 'va-muted')); return s; }
    const ul = el('ul', '', 'vd-todos');
    for (const t of data.tasks) {
      const li = el('li'), label = el('label'), box = el('input'); box.type = 'checkbox'; box.checked = t.done; box.disabled = !data.isOwner;
      const text = el('div'); text.append(el('strong', t.action), el('span', `${t.dueWeek !== null ? `Due week ${t.dueWeek} · ` : ''}Success: ${t.successSignal || '—'}`, 'va-muted'));
      label.append(box, text); li.append(label); ul.append(li);
      box.onchange = async () => {
        box.disabled = true;
        try { await api(`/api/venture/tasks/${encodeURIComponent(t.id)}`, { method: 'PATCH', body: JSON.stringify({ done: box.checked }) }); t.done = box.checked; const v = ventures.find(x => x.id === selected); if (v) { v.tasks.done += box.checked ? 1 : -1; renderList(); } }
        catch (error) { box.checked = !box.checked; alert(errorText(error)); }
        finally { box.disabled = false; }
      };
    }
    s.append(ul);
    if (!data.isOwner) s.append(el('p', 'Only the founder can tick off to-dos.', 'va-muted'));
    return s;
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
    const note = el('textarea'); note.rows = 2; note.maxLength = 2000; note.placeholder = 'Note to the founder (they will see this)';
    const internal = el('textarea'); internal.rows = 2; internal.maxLength = 4000; internal.placeholder = 'Internal note (LFG reviewers only)';
    const submit = el('button', 'Record decision', 'va-send'); submit.type = 'submit';
    const feedback = el('p', '', 'va-muted'); feedback.setAttribute('role', 'status');
    const row = el('div', '', 'vd-row'); const amountLabel = el('label', 'Tokens approved'); amountLabel.append(amount); const choiceLabel = el('label', 'Decision'); choiceLabel.append(choice); row.append(choiceLabel, amountLabel);
    form.append(el('h2', 'Record LFG decision'), el('p', `Owner: ${data.owner?.name || ''} · ${data.owner?.email || ''}`, 'va-muted'), row, note, internal, submit, feedback);
    form.onsubmit = async e => {
      e.preventDefault(); submit.disabled = true; feedback.textContent = 'Saving…';
      try {
        await api(`/api/venture/admin/conversations/${encodeURIComponent(data.conversation.id)}/decision`, { method: 'POST', body: JSON.stringify({ decision: choice.value, tokensApproved: Number(amount.value) || 0, founderNote: note.value.trim() || undefined, internalNote: internal.value.trim() || undefined }) });
        await loadList();
      } catch (error) { feedback.textContent = errorText(error); submit.disabled = false; }
    };
    if (data.decisions.length > 1) {
      const hist = el('details'); hist.append(el('summary', `Decision history (${data.decisions.length})`));
      for (const d of data.decisions) hist.append(el('p', `${when(d.createdAt)} · ${(VERDICTS[d.decision] || [d.decision])[0]} · ${tokens(d.tokensApproved)}${d.internalNote ? ` · ${d.internalNote}` : ''}`, 'va-muted'));
      form.append(hist);
    }
    return form;
  }

  function transcript(data, sources) {
    const box = el('details', '', 'vd-card vd-transcript'); box.append(el('summary', 'Conversation transcript'));
    let loaded = false;
    box.ontoggle = async () => {
      if (!box.open || loaded) return; loaded = true;
      const body = el('div', 'Loading…', 'va-muted'); box.append(body);
      try {
        const { messages } = await api(`/api/venture/conversations/${encodeURIComponent(data.conversation.id)}`);
        body.replaceChildren(); body.className = 'vd-messages';
        for (const m of messages.filter(m => m.content)) {
          const bubble = el('div', m.role === 'user' ? m.content : '', `va-message ${m.role === 'user' ? 'user' : ''}`);
          if (m.role !== 'user') window.ventureMarkdown ? window.ventureMarkdown.into(bubble, m.content, sources) : (bubble.textContent = m.content);
          body.append(bubble);
        }
        if (!body.childElementCount) body.append(el('p', 'No messages yet.', 'va-muted'));
      } catch (error) { body.textContent = errorText(error); loaded = false; }
    };
    return box;
  }

  async function loadDetail() {
    if (!selected) { detail.replaceChildren(scope === 'mine' ? el('div', '', 'vd-card vd-empty') : el('p', 'Select a venture.', 'va-muted')); if (scope === 'mine') detail.firstChild.append(el('h2', 'Your dashboard'), el('p', 'Start a venture on the left. After the analyst assesses it, you’ll see the verdict, market opportunity, token tranche and your to-dos here.', 'va-muted')); return; }
    const id = selected;
    detail.replaceChildren(el('p', 'Loading venture…', 'va-muted'));
    try {
      const data = await api(`/api/venture/conversations/${encodeURIComponent(id)}/overview`);
      if (id !== selected) return;
      const sources = new Map(data.sources.map(s => [s.id, s]));
      const a = data.assessment?.contentJson, r = a?.recommendation;
      const head = el('div', '', 'vd-head');
      const h = el('div'); h.append(el('h2', data.conversation.title), el('p', `${data.owner ? `${data.owner.name || data.owner.email} · ` : ''}${data.assessment ? `${data.assessment.status} assessment v${data.assessment.version} · ${when(data.assessment.createdAt)}` : 'Not assessed yet'}`, 'va-muted'));
      const actions = el('div', '', 'vd-actions');
      if (data.isOwner) actions.append(link(data.assessment ? 'Continue with the analyst' : 'Continue the conversation', `/venture-analyst?chat=open&c=${encodeURIComponent(id)}`, 'va-pill'));
      head.append(h, actions);
      const parts = [head, verdictCards(data, r)];
      if (isAdmin && scope === 'all' || isAdmin && !data.isOwner) parts.push(decisionForm(data, r));
      if (r?.complianceFlags?.length) parts.push(section('Compliance flags', claimList(r.complianceFlags, sources)));
      if (r) {
        parts.push(todos(data));
        const next = el('ol', '', 'vd-next'); r.nextSteps.forEach(step => next.append(el('li', step)));
        parts.push(section('Next steps', next, a.missingInputs.length ? el('h3', 'Missing inputs') : null, a.missingInputs.length ? (() => { const ul = el('ul'); a.missingInputs.forEach(m => ul.append(el('li', m))); return ul; })() : null));
        parts.push(tranche(r, sources));
        parts.push(section('Why this verdict', claimList(r.rationale, sources)));
      }
      if (a) {
        parts.push(market(a, sources));
        parts.push(section('Founder fit', el('h3', 'Strengths and fit'), claimList(a.founderFit.rationale, sources), el('h3', 'Capability gaps'), claimList(a.founderFit.capabilityGaps, sources), el('h3', 'Distribution gaps'), claimList(a.founderFit.distributionGaps, sources), el('h3', 'Recommended changes'), claimList(a.founderFit.recommendedChanges, sources)));
        const exps = el('ul', '', 'vd-claims'); a.gtm.experiments.forEach(x => { const li = el('li', x.experiment.text); if (x.suggestedBudget !== null) li.append(el('span', ` · budget ${money(x.suggestedBudget, { currency: a.units.currency })}`, 'va-muted')); exps.append(li); });
        parts.push(section('Go-to-market experiments', claimList(a.gtm.targetSegment, sources), exps));
        parts.push(section('Uncertainties', claimList(a.uncertainties, sources)));
      }
      if (isAdmin) parts.push(transcript(data, sources));
      parts.push(el('p', 'Financial figures, token sizes and timelines are scenarios, not promises. The LFG decision is the binding one.', 'va-muted'));
      detail.replaceChildren(...parts);
    } catch (error) {
      if (id !== selected) return;
      detail.replaceChildren(el('p', errorText(error), 'va-error'), btn('Retry', loadDetail));
    }
  }

  loadList();
})();
