/* Read-only Git workspace. Provider text is always rendered with textContent. */
(function () {
  function init() {
    const root = document.getElementById('git-root'), pane = document.getElementById('git');
    if (!root || !pane) return;
    let data, refreshedAt, loading = false, view = 'branches', query = '', filter = 'all';
    const collapsed = new Set();
    const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
    const button = (text, action) => { const b = el('button', text); b.type = 'button'; b.addEventListener('click', action); return b; };
    const notice = (text) => root.append(el('p', text, 'git-notice'));
    function link(pr) {
      const a = el('a', `#${pr.id} · ${pr.title}${pr.draft ? ' · Draft' : ''}`);
      try { const url = new URL(pr.url); if (url.protocol === 'https:' && !url.username && !url.password) { a.href = url.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; } } catch { /* invalid provider URL remains text */ }
      return a;
    }
    function matches(r) {
      return (filter === 'all' || r.integration.status === filter) && `${r.name} ${r.branch || ''} ${r.destination || ''}`.toLowerCase().includes(query.toLowerCase());
    }
    function row(r, kind) {
      const n = el('div', undefined, `git-branch git-${kind}`);
      n.append(el('b', r.name), el('code', `${r.branch || 'No stored branch'} → ${r.destination || 'Unknown destination'}`));
      const state = r.integration.status;
      n.append(el('span', `${state === 'integrated' ? 'Integrated into' : state === 'not_integrated' ? 'Not integrated into' : 'Unknown integration into'} ${r.destination || 'unknown'}`, `git-badge git-${state}`));
      n.append(el('small', r.missingRef ? 'Missing/deleted or unavailable ref' : `${r.integration.ahead ?? '?'} ahead · ${r.integration.behind ?? '?'} behind ${r.destination || 'unknown'}`));
      n.append(el('small', r.integration.evidence));
      if (r.activeUse.preview) n.append(el('span', 'Selected for preview', 'git-badge'));
      if (r.activeUse.execution) n.append(el('span', 'Execution active', 'git-badge'));
      if (r.activeUse.queued) n.append(el('span', 'Queued · not executing', 'git-badge'));
      for (const pr of r.pullRequests) n.append(link(pr));
      return n;
    }
    function map(r, children) {
      const n = el('div', undefined, 'git-map');
      n.append(el('small', 'Intended merge destinations · not commit ancestry. Solid = integrated; dashed = pending; dotted = unknown.'));
      for (const t of [...children, r]) {
        const edge = el('div', undefined, `git-edge git-${t.integration.status}`);
        edge.append(el('code', t.branch || '(missing branch)'), el('span', ' → ', 'git-arrow'), el('code', t.destination || '(unknown destination)'));
        edge.setAttribute('aria-label', `${t.branch || 'missing branch'} to ${t.destination || 'unknown'}: ${t.integration.status}`);
        n.append(edge);
      }
      return n;
    }
    function renderContent(content) {
      content.replaceChildren();
      if (view === 'prs') {
        content.append(el('p', 'All open pull requests, including drafts, forks and PRs created outside LFG. Read-only.'));
        const prs = data.pullRequests.filter(p => `${p.title} ${p.source} ${p.destination}`.toLowerCase().includes(query.toLowerCase()));
        for (const p of prs) {
          const n = el('article', undefined, 'git-card git-pr');
          n.append(link(p), el('code', `${p.sourceRepo || 'Fork / external repository'}: ${p.source} → ${p.destination}`));
          content.append(n);
        }
        if (!prs.length) content.append(el('p', 'No matching open pull requests.'));
        content.append(el('small', `${prs.length} matching · ${data.pullRequests.length} loaded repository PRs${data.completeness.pullRequests ? '' : ' · incomplete'}`));
        return;
      }
      const d = data.defaultBranch;
      content.append(el('div', `${d.branch} · Default branch${d.protected ? ' · Protected' : ''}${d.missingRef ? ' · Ref unavailable' : ''}`, 'git-notice'));
      let visible = 0;
      for (const epic of data.epics) {
        const children = epic.tickets.filter(matches);
        if (!matches(epic) && !children.length) continue;
        visible++;
        const card = el('details', undefined, 'git-card'); card.open = !collapsed.has(epic.id);
        card.addEventListener('toggle', () => card.open ? collapsed.delete(epic.id) : collapsed.add(epic.id));
        const summary = el('summary', `${epic.epicKey || 'Epic'} · ${epic.name}`);
        const integrated = epic.tickets.filter(t => t.integration.status === 'integrated').length;
        summary.append(el('small', `${epic.tickets.length} ticket branches · ${integrated} integrated into epic · ${epic.tickets.filter(t => t.integration.status === 'unknown').length} unknown`));
        card.append(summary, map(epic, children), row(epic, 'epic'));
        const nested = el('div', undefined, 'git-children');
        children.forEach(t => nested.append(row(t, 'ticket'))); card.append(nested); content.append(card);
      }
      const other = data.other.filter(matches);
      const otherCard = el('details', undefined, 'git-card'); otherCard.open = !collapsed.has('other');
      otherCard.addEventListener('toggle', () => otherCard.open ? collapsed.delete('other') : collapsed.add('other'));
      otherCard.append(el('summary', `Other branches · No epic (${other.length} matching / ${data.other.length} loaded)`));
      other.forEach(r => otherCard.append(row(r, 'other'))); content.append(otherCard);
      if (!visible && !other.length) content.append(el('p', 'No matching branches. Stored associations with missing refs remain visible when filters are cleared.'));
      content.append(el('small', `${visible} matching epic groups · ${other.length} matching other rows. Stats above are unfiltered loaded totals.`));
    }
    function render() {
      root.replaceChildren();
      const header = el('div', undefined, 'git-heading'); header.append(el('h2', 'Branches & pull requests'), button('Refresh', () => load(true))); root.append(header);
      notice('Ticket branches merge into their epic. Epics deliver into their declared base. Integration into an epic does not mean delivery to the default branch.');
      if (!data) return;
      notice(`Read-only · ${data.repository} · Refreshed ${refreshedAt}. PR creation, AI review, merge and deletion are pending implementation.`);
      if (!data.completeness.complete) notice(`Partial / unknown data — totals are loaded results, not confirmed complete repository totals. Check access and refresh. ${data.completeness.errors.map(e => e.code).join(', ')} · Correlation ID: ${data.correlationId}`);
      const stats = el('div', undefined, 'git-stats');
      for (const [key, title] of [['epics', 'Epics'], ['tickets', 'Ticket branches'], ['other', 'Other branches · No epic']]) {
        const total = data.totals[key], n = el('div');
        n.append(el('strong', String(total.total)), el('span', title), el('small', `${total.integrated} integrated · ${total.notIntegrated} not integrated · ${total.unknown} unknown`)); stats.append(n);
      }
      const prStat = el('div'); prStat.append(el('strong', String(data.pullRequests.length)), el('span', 'Open pull requests'), el('small', `${data.pullRequests.filter(p => p.draft).length} drafts${data.completeness.pullRequests ? '' : ' · partial'}`)); stats.append(prStat); root.append(stats);
      const controls = el('div', undefined, 'git-controls');
      const branches = button('Branches by epic', () => { view = 'branches'; render(); }); branches.setAttribute('aria-pressed', String(view === 'branches'));
      const prs = button('All open PRs', () => { view = 'prs'; render(); }); prs.setAttribute('aria-pressed', String(view === 'prs'));
      const search = el('input'); search.type = 'search'; search.placeholder = 'Search branches or pull requests'; search.setAttribute('aria-label', search.placeholder); search.value = query;
      const select = el('select'); select.setAttribute('aria-label', 'Integration status filter');
      for (const [value, title] of [['all', 'All statuses'], ['integrated', 'Integrated'], ['not_integrated', 'Not integrated'], ['unknown', 'Unknown']]) { const o = el('option', title); o.value = value; select.append(o); }
      select.value = filter; select.hidden = view === 'prs';
      const content = el('section');
      search.addEventListener('input', () => { query = search.value; renderContent(content); });
      select.addEventListener('change', () => { filter = select.value; renderContent(content); });
      controls.append(branches, prs, search, select); root.append(controls, content); renderContent(content);
    }
    async function load(force) {
      if (loading || (data && !force)) return;
      loading = true; root.setAttribute('aria-busy', 'true'); root.replaceChildren(el('p', 'Loading repository branches and pull requests…', 'git-notice'));
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(root.dataset.projectId)}/git/branches`, { credentials: 'same-origin' });
        const body = await response.json();
        if (!response.ok) throw new Error(`${body.error || 'Unable to load repository. Reconnect Git in Settings and refresh.'} · Correlation ID: ${body.correlationId || response.headers.get('X-Correlation-ID') || 'unavailable'}`);
        data = body; refreshedAt = new Date().toLocaleTimeString(); render();
      } catch (e) { root.replaceChildren(el('p', e.message || 'Network unavailable. Check your connection and retry.', 'git-notice')); root.append(button('Retry', () => load(true))); }
      finally { loading = false; root.setAttribute('aria-busy', 'false'); }
    }
    root.setAttribute('aria-live', 'polite');
    new MutationObserver(() => { if (pane.classList.contains('active')) load(true); }).observe(pane, { attributes: true, attributeFilter: ['class'] });
    if (pane.classList.contains('active')) load(false);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
