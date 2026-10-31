/* Git workspace. Provider and model text is always rendered with textContent. */
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
    function focusWorkspace() { const heading = root.querySelector('h2'); if (heading) { heading.tabIndex = -1; heading.focus(); } }
    const apiBase = `/api/projects/${encodeURIComponent(root.dataset.projectId)}/git`;
    let pollTimer;
    async function api(path, payload, method) {
      const response = await fetch(apiBase + path, { credentials: 'same-origin', method: method || (payload ? 'POST' : 'GET'), headers: payload ? { 'Content-Type': 'application/json' } : {}, body: payload ? JSON.stringify(payload) : undefined });
      const body = await response.json();
      if (!response.ok) throw new Error(`${body.error || 'Operation failed. Retry after checking access.'} (${body.code || response.status}) · Correlation ID: ${body.correlationId || response.headers.get('X-Correlation-ID')}`);
      return body;
    }
    function dialog(title) {
      clearTimeout(pollTimer);
      const previous = document.activeElement;
      const d = el('dialog', undefined, 'git-review-dialog');
      d.setAttribute('aria-label', title);
      const header = el('div', undefined, 'git-heading');
      header.append(el('h2', title), button('Close', () => d.close()));
      const content = el('div'); content.setAttribute('aria-live', 'polite');
      d.append(header, content); root.append(d);
      d.addEventListener('close', () => { clearTimeout(pollTimer); d.remove(); previous?.focus(); });
      d.showModal();
      return { d, content };
    }
    async function startReview(headRef, baseRef) {
      const { d, content } = dialog('Detailed review before creating a PR');
      content.append(el('code', `${headRef} → ${baseRef}`), el('p', 'Saving review request… Provider creation is only sent on explicit final confirmation.'));
      try {
        const body = await api('/reviews', { headRef, baseRef });
        if (d.open) showReview(d, content, body.review.id);
      } catch (e) { if (d.open) content.append(el('p', e.message, 'git-notice')); }
    }
    async function savedReviews() {
      const { d, content } = dialog('Saved reviews'); content.append(el('p', 'Loading saved progress and results…'));
      try {
        const body = await api('/reviews'); if (!d.open) return;
        content.replaceChildren();
        for (const r of body.reviews) {
          const card = el('div', undefined, 'git-finding');
          card.append(el('code', `${r.headRef} → ${r.baseRef}`), el('small', `${r.status} · ${r.headSha.slice(0, 12)} / ${r.baseSha.slice(0, 12)} · ${new Date(r.createdAt).toLocaleString()}`), button('Open saved review', () => showReview(d, content, r.id))); content.append(card);
        }
        if (!body.reviews.length) content.append(el('p', 'No saved reviews. Start from a source branch.'));
      } catch (e) { if (d.open) content.replaceChildren(el('p', e.message, 'git-notice')); }
    }
    async function showReview(d, content, id) {
      clearTimeout(pollTimer);
      try {
        const body = await api(`/reviews/${encodeURIComponent(id)}`); if (!d.open) return;
        const r = body.review; content.replaceChildren();
        content.append(el('h3', 'Step 1 of 2 · Detailed change review'), el('code', `${r.headRef} → ${r.baseRef}`), el('p', `Source ${r.headSha}\nBase ${r.baseSha}`, 'git-revisions'));
        const status = el('p', `${r.status} · Attempt ${r.attempt} · ${r.modelProvider || 'Model pending'} / ${r.model || 'Configured account model'}`, 'git-notice');
        status.setAttribute('role', 'status'); content.append(status);
        if (body.stale) { const stale = el('p', body.freshness === 'unavailable' ? `Revision freshness is unavailable (${body.freshnessError}). Saved findings remain available, but creation is blocked. Check Git access and reload. Correlation ID: ${body.correlationId}` : 'Stale review: source or destination changed. A new review is required before PR creation.', 'git-notice'); stale.setAttribute('role', 'alert'); content.append(stale); }
        if (r.summary) content.append(el('h3', 'Summary'), el('p', r.summary));
        for (const f of JSON.parse(r.findings || '[]')) {
          const finding = el('article', undefined, 'git-finding'); finding.append(el('b', f.severity.toUpperCase()), el('code', `${f.file}${f.line ? ':' + f.line : ''}`), el('p', f.explanation), el('p', `Recommendation: ${f.recommendation}`)); content.append(finding);
        }
        if (r.coverage) {
          const coverage = JSON.parse(r.coverage);
          content.append(el('h3', 'Coverage & scope'));
          for (const key of ['correctness', 'security', 'reliability', 'tests']) content.append(el('p', `${key}: ${coverage[key]}`));
          content.append(el('p', `Reviewed files: ${(coverage.files || []).join(', ')}`));
          for (const key of ['included', 'excluded', 'unknown']) content.append(el('p', `${key} ticket scope: ${(coverage.scope?.[key] || []).join(', ') || 'None identified'}`));
          if (coverage.scope?.note) content.append(el('p', coverage.scope.note));
          for (const item of coverage.excluded || []) content.append(el('p', `Excluded file: ${item.file} — ${item.reason}`));
        }
        content.append(el('h3', 'Validation & limitations'));
        for (const text of JSON.parse(r.limitations || '["Static review only. Runtime tests were not executed."]')) content.append(el('p', text));
        if (r.errorCode) {
          const error = el('p', `${r.errorCode}: ${r.status === 'blocked' ? 'Review blocked. Connect the selected model in Settings → LLM Keys or Integrations and check team/project model access, then retry.' : r.status === 'incomplete' ? 'Incomplete coverage blocks PR creation. Remove excluded secret/binary changes from this proposal or use a fully reviewable source revision and run a new review.' : 'Review did not complete. Check provider access, reduce oversized changes if needed, and retry.'} Correlation ID: ${r.correlationId}`, 'git-notice'); error.setAttribute('role', 'alert'); content.append(error);
        }
        if (['queued', 'running'].includes(r.status)) { content.append(el('p', r.status === 'queued' ? 'Waiting for a durable runner claim; not yet executing.' : 'Analyzing immutable changes with the configured AI model…')); pollTimer = setTimeout(() => showReview(d, content, id), 2500); }
        if (data?.canManageCode && ['failed', 'blocked', 'incomplete'].includes(r.status) && !body.stale) content.append(button('Retry review', async () => { try { await api(`/reviews/${encodeURIComponent(id)}/retry`, {}); showReview(d, content, id); } catch (e) { content.append(el('p', e.message, 'git-notice')); } }));
        if (body.freshness === 'unavailable') content.append(button('Reload revision freshness', () => showReview(d, content, id)));
        else if (data?.canManageCode && body.stale) content.append(button('Run new review for current revisions', () => { d.close(); startReview(r.headRef, r.baseRef); }));
        if (r.status === 'completed' && !body.stale && data?.canManageCode) {
          const label = el('label'), check = el('input'); check.type = 'checkbox';
          label.append(check, document.createTextNode(' I have read the findings, excluded scope and limitations.'));
          const next = button('Continue to PR details →', () => prDetails(d, content, r, body.suggestedBody)); next.disabled = true;
          check.addEventListener('change', () => { next.disabled = !check.checked; }); content.append(label, next);
        }
      } catch (e) { if (d.open) { content.replaceChildren(el('p', e.message, 'git-notice'), button('Reload saved review', () => showReview(d, content, id))); } }
    }
    function prDetails(d, content, r, suggestedBody) {
      content.replaceChildren(el('h3', 'Step 2 of 2 · Confirm pull request'), el('code', `${r.headRef} (${r.headSha.slice(0, 12)}) → ${r.baseRef} (${r.baseSha.slice(0, 12)})`));
      const titleLabel = el('label', 'Title'), title = el('input'); title.type = 'text'; title.maxLength = 250; title.value = r.headRef; titleLabel.append(title);
      const bodyLabel = el('label', 'Body'), body = el('textarea'); body.value = suggestedBody; body.maxLength = 40000; body.rows = 12; bodyLabel.append(body);
      const error = el('p', '', 'git-notice'); error.setAttribute('role', 'alert');
      const create = button('Create pull request', async () => {
        create.disabled = true; error.textContent = 'Rechecking both revisions and duplicate pull requests…';
        try {
          const result = await api('/pull-requests', { reviewId: r.id, acknowledged: true, title: title.value, body: body.value });
          if (!d.open) return;
          content.replaceChildren(el('h3', result.existing ? 'Open existing pull request' : 'Pull request created'), link(result.pullRequest));
          api('/branches').then(fresh => {
            data = fresh; refreshedAt = new Date().toLocaleTimeString();
            if (d.open) d.addEventListener('close', () => { render(); focusWorkspace(); }, { once: true }); else { render(); focusWorkspace(); }
          }).catch(e => { if (d.open) content.append(el('p', `PR confirmed, but refresh failed: ${e.message}`, 'git-notice')); });
        } catch (e) { if (d.open) { error.textContent = e.message; create.disabled = false; } }
      });
      content.append(titleLabel, bodyLabel, el('p', 'Creation does not approve or merge this branch. The saved review and limitations are retained in the PR body.'), error, button('Back to review', () => showReview(d, content, r.id)), create); title.focus();
    }
    async function mergePR(p) {
      const { d, content } = dialog('Review & merge');
      content.append(el('p', 'Refreshing provider checks, reviews, conflicts and repository policy…'));
      try {
        const state = await api(`/pull-requests/${p.id}/merge-state`); if (!d.open) return;
        const pr = state.pullRequest;
        content.replaceChildren(el('h3', `Merge ${pr.source} into ${pr.destination}`), el('code', `${pr.sourceRepo || 'Fork'}: ${pr.source} → ${pr.destination}`), el('p', `Exact source revision: ${pr.headSha}`, 'git-revisions'), link(pr));
        content.append(el('p', `Draft: ${pr.draft ? 'yes' : 'no'} · Provider policy: ${state.policy || 'unknown'}`));
        for (const key of ['conflicts', 'checks', 'reviews', 'protection']) content.append(el('p', `${key}: ${state.states?.[key] || 'unknown — refresh or inspect provider'}`));
        content.append(el('p', 'Merging into an epic is not delivery to main. This action does not approve an epic or delete its branch.'));
        const error = el('p', state.blockers.length ? `Blocked: ${(state.blockerMessages || state.blockers).join(' ')} · Correlation ID: ${state.correlationId}` : 'Provider reports eligible. State is rechecked on confirmation.', 'git-notice'); error.setAttribute('role', 'alert');
        const confirm = button(`Confirm merge into ${pr.destination}`, async () => {
          confirm.disabled = true; error.textContent = 'Confirming current revision and provider result…';
          try {
            await api(`/pull-requests/${pr.id}/merge`, { confirmation: pr.source, destination: pr.destination, expectedSha: pr.headSha });
            d.close(); await load(true, true);
          } catch (e) { if (d.open) { error.textContent = e.message; confirm.disabled = false; } }
        });
        confirm.disabled = !!state.blockers.length;
        content.append(error, confirm, button('Refresh confirmation', () => { d.close(); mergePR(pr); }));
      } catch (e) { if (d.open) content.replaceChildren(el('p', e.message, 'git-notice'), link(p)); }
    }
    function deleteBranch(r) {
      const { d, content } = dialog('Delete branch?');
      content.append(el('code', r.branch), el('p', `Expected revision: ${r.headSha}`, 'git-revisions'), el('p', 'No cascading deletion. Default/protected, active preview/build, open-PR and dependent branches are blocked by the server.'));
      const warning = el('label'), unmerged = el('input'); unmerged.type = 'checkbox';
      warning.append(unmerged, document.createTextNode(' I understand this may contain work not in the default branch, and explicitly confirm deleting that unmerged work.'));
      const label = el('label', 'Type the exact branch name'), typed = el('input'); typed.type = 'text'; typed.autocomplete = 'off'; label.append(typed);
      const error = el('p', '', 'git-notice'); error.setAttribute('role', 'alert');
      const confirm = button('Delete branch', async () => {
        confirm.disabled = true; error.textContent = 'Rechecking fresh remote ref and active use…';
        try { await api('/branches', { branch: r.branch, expectedSha: r.headSha, confirmation: typed.value, confirmUnmerged: unmerged.checked }, 'DELETE'); d.close(); await load(true, true); }
        catch (e) { if (d.open) { error.textContent = e.message; confirm.disabled = typed.value !== r.branch; } }
      });
      confirm.disabled = true; typed.addEventListener('input', () => { confirm.disabled = typed.value !== r.branch; });
      content.append(warning, label, error, confirm); typed.focus();
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
      if (data.canManageCode && !r.missingRef && r.branch && r.destination && !r.pullRequests.length) n.append(button('Create PR · review first', () => startReview(r.branch, r.destination)));
      if (data.canManageCode && !r.missingRef && r.branch) n.append(button('Delete branch…', () => deleteBranch(r)));
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
        content.append(el('p', 'All open pull requests, including drafts, forks and PRs created outside LFG.'));
        const prs = data.pullRequests.filter(p => `${p.title} ${p.source} ${p.destination}`.toLowerCase().includes(query.toLowerCase()));
        for (const p of prs) {
          const n = el('article', undefined, 'git-card git-pr');
          n.append(link(p), el('code', `${p.sourceRepo || 'Fork / external repository'}: ${p.source} → ${p.destination}`));
          const epic = data.epics.find(e => (p.sourceRepo?.toLowerCase() === data.repository.toLowerCase() && e.branch === p.source) || (p.sourceRepo?.toLowerCase() === data.repository.toLowerCase() && e.tickets.some(t => t.branch === p.source)));
          n.append(el('span', epic ? `${epic.name} · ${epic.branch === p.source ? 'Epic → Base' : 'Ticket → Epic'}` : 'No epic', 'git-badge'));
          if (data.canManageCode) n.append(button(p.draft ? 'Draft · inspect blockers' : 'Review & merge', () => mergePR(p)));
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
      const header = el('div', undefined, 'git-heading'); header.append(el('h2', 'Branches & pull requests'), button('Saved reviews', savedReviews), button('Refresh', () => load(true))); root.append(header);
      notice('Ticket branches merge into their epic. Epics deliver into their declared base. Integration into an epic does not mean delivery to the default branch.');
      if (!data) return;
      notice(`${data.canManageCode ? 'Review-first PR creation' : 'Read-only access'} · ${data.repository} · Refreshed ${refreshedAt}. Merge and deletion remain separate workflows.`);
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
    async function load(force, focusAfter) {
      if (loading || (data && !force)) return;
      loading = true; root.setAttribute('aria-busy', 'true'); root.replaceChildren(el('p', 'Loading repository branches and pull requests…', 'git-notice'));
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(root.dataset.projectId)}/git/branches`, { credentials: 'same-origin' });
        const body = await response.json();
        if (!response.ok) throw new Error(`${body.error || 'Unable to load repository. Reconnect Git in Settings and refresh.'} · Correlation ID: ${body.correlationId || response.headers.get('X-Correlation-ID') || 'unavailable'}`);
        data = body; refreshedAt = new Date().toLocaleTimeString(); render();
        if (focusAfter) focusWorkspace();
      } catch (e) { root.replaceChildren(el('p', e.message || 'Network unavailable. Check your connection and retry.', 'git-notice')); root.append(button('Retry', () => load(true)), button('Saved reviews', savedReviews)); }
      finally { loading = false; root.setAttribute('aria-busy', 'false'); }
    }
    root.setAttribute('aria-live', 'polite');
    new MutationObserver(() => { if (pane.classList.contains('active')) load(true); }).observe(pane, { attributes: true, attributeFilter: ['class'] });
    if (pane.classList.contains('active')) load(false);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
