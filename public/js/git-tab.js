/* Git workspace. Provider and model text is always rendered with textContent. */
(function () {
  function init() {
    const root = document.getElementById('git-root'), pane = document.getElementById('git');
    if (!root || !pane) return;
    let data, refreshedAt, loading = false, view = 'branches', query = '', filter = 'all';
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
      n.append(el('b', r.name), el('code', `${r.branch || 'No branch recorded'} → ${r.destination || 'Unknown destination'}`));
      const state = r.integration.status;
      n.append(el('span', `${state === 'integrated' ? 'Integrated into' : state === 'not_integrated' ? 'Not integrated into' : 'Unknown integration into'} ${r.destination || 'unknown'}`, `git-badge git-${state}`));
      n.append(el('small', !r.branch ? 'No branch recorded' : r.refState === 'absent' ? 'Branch not found in complete remote listing' : r.refState === 'unavailable' ? 'Remote ref unavailable · provider listing incomplete; refresh to verify' : `${r.integration.ahead ?? '?'} ahead · ${r.integration.behind ?? '?'} behind ${r.destination || 'unknown'}`));
      if (r.branch) n.append(el('small', r.integration.evidence));
      if (r.activeUse.preview) n.append(el('span', 'Selected for preview', 'git-badge'));
      if (r.activeUse.execution) n.append(el('span', 'Execution active', 'git-badge'));
      if (r.activeUse.queued) n.append(el('span', 'Queued · not executing', 'git-badge'));
      for (const pr of r.pullRequests) n.append(link(pr));
      if (data.canManageCode && r.headSha && r.branch && r.destination && !r.pullRequests.length) n.append(button('Create PR · review first', () => { root.querySelector('dialog')?.close(); startReview(r.branch, r.destination); }));
      if (data.canManageCode && r.headSha && r.branch) n.append(button('Delete branch…', () => { root.querySelector('dialog')?.close(); deleteBranch(r); }));
      return n;
    }
    function inspect(r, historyHead) {
      const { content } = dialog(r.branch || r.name);
      if (historyHead?.historical) content.append(el('p', 'Selected historical PR head · not the current branch revision or proof of current integration.'), el('code', historyHead.sha));
      content.append(row(r, 'details'));
    }
    const svgEl = (tag, attrs, text) => {
      const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, String(v));
      if (text !== undefined) n.textContent = text;
      return n;
    };
    function allRows() { return [...data.epics.flatMap(e => [e, ...e.tickets]), ...data.other]; }
    async function moreHistory(head, trigger) {
      trigger.disabled = true;
      try {
        const result = await api(`/history?sha=${encodeURIComponent(head.sha)}&page=${head.history?.nextPage || 1}`);
        const nodes = new Map(data.graph.nodes.map(n => [n.sha, n]));
        for (const n of result.items) nodes.set(n.sha, n);
        data.graph.nodes = [...nodes.values()];
        for (const h of data.graph.heads.filter(h => h.sha === head.sha)) h.history = result;
        render();
      } catch (e) { trigger.after(el('p', e.message, 'git-notice')); trigger.disabled = false; }
    }
    function tree(scopeId, rows) {
      const wrap = el('div', undefined, 'git-tree');
      const graph = data.graph;
      if (!graph) {
        wrap.append(el('p', 'Commit history unavailable. Refresh to load provider history.'));
        for (const r of rows.filter(r => r.branch)) wrap.append(button(`Inspect ${r.branch} · history unavailable`, () => inspect(r)));
      }
      else {
        const scope = graph.scopes.find(s => s.id === scopeId);
        const heads = graph.heads.filter(h => scope?.rowIds.includes(h.rowId) && (h.rowId === 'default' && rows.length > 0 || rows.some(r => r.id === h.rowId))).sort((a, b) => Number(b.rowId === 'default') - Number(a.rowId === 'default') || a.branch.localeCompare(b.branch) || (a.sha || '').localeCompare(b.sha || ''));
        const known = new Map(graph.nodes.map(n => [n.sha, n]));
        const selected = new Map(), lanes = new Map(), laneColors = new Map(); let nextLane = 0;
        // A head owns its first-parent lane until reaching an already shared node.
        function walk(sha, lane) {
          if (selected.has(sha) || !known.has(sha)) return;
          const c = known.get(sha); selected.set(sha, c); lanes.set(sha, lane);
          c.parents.forEach((p, i) => walk(p, i === 0 ? lane : nextLane++));
        }
        heads.forEach(h => {
          if (h.sha && !selected.has(h.sha)) {
            const start = nextLane;
            walk(h.sha, nextLane++);
            const hash = [...h.branch].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0);
            for (let lane = start; lane < nextLane; lane++) laneColors.set(lane, h.rowId === 'default' ? 4 : (hash + lane - start) % 4);
          }
        });
        const ranks = new Map(), visiting = new Set();
        function rank(sha) {
          if (ranks.has(sha)) return ranks.get(sha);
          if (visiting.has(sha)) return 0;
          visiting.add(sha);
          const parents = selected.get(sha).parents.filter(p => selected.has(p));
          const value = parents.length ? 1 + Math.max(...parents.map(rank)) : 0;
          visiting.delete(sha); ranks.set(sha, value); return value;
        }
        [...selected.keys()].forEach(rank);
        const maxRank = Math.max(0, ...ranks.values()), step = Math.max(70, 660 / Math.max(1, maxRank)), labelX = 90 + maxRank * step;
        const labelSlots = new Set();
        const labels = heads.filter(h => h.sha && selected.has(h.sha)).map(h => {
          let lane = lanes.get(h.sha);
          while (labelSlots.has(lane)) lane++;
          labelSlots.add(lane);
          return { h, lane };
        });
        const height = Math.max(130, (Math.max(nextLane, ...[...labelSlots].map(l => l + 1)) + 1) * 58);
        const width = Math.max(1000, labelX + Math.max(320, ...heads.map(h => h.branch.length * 8 + 80)));
        const viewport = el('div', undefined, 'git-graph-viewport'); viewport.tabIndex = 0;
        viewport.setAttribute('aria-label', 'Commit history. Scroll horizontally for later commits.');
        const svg = svgEl('svg', { width, height, role: 'group', 'aria-label': 'Horizontal commit ancestry: earlier to latest' });
        const x = sha => 40 + ranks.get(sha) * step, y = sha => 35 + lanes.get(sha) * 58;
        const color = lane => `var(--git-lane-${laneColors.get(lane) ?? 0})`;
        for (const c of selected.values()) for (const p of c.parents) {
          if (!selected.has(p)) continue; // Unobserved parents are boundaries, never fabricated nodes.
          const mid = (x(p) + x(c.sha)) / 2;
          svg.append(svgEl('path', { d: `M${x(p)} ${y(p)} C${mid} ${y(p)} ${mid} ${y(c.sha)} ${x(c.sha)} ${y(c.sha)}`, fill: 'none', stroke: color(lanes.get(c.sha)), 'stroke-width': 3, 'data-parent-sha': p, 'data-child-sha': c.sha }));
        }
        for (const c of selected.values()) {
          const pick = svgEl('g', { tabindex: 0, role: 'button', 'aria-label': `Commit ${c.sha}`, class: 'git-commit' });
          pick.append(svgEl('circle', { cx: x(c.sha), cy: y(c.sha), r: 5, stroke: color(lanes.get(c.sha)), 'stroke-width': 3 }), svgEl('title', {}, c.sha));
          const action = () => { const r = rows.find(r => r.headSha === c.sha); if (r) inspect(r); else { const { content } = dialog('Commit'); content.append(el('code', c.sha), el('p', `Observed parents: ${c.parents.join(', ') || 'Root commit'}`)); } };
          pick.addEventListener('click', action); pick.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); action(); } });
          svg.append(pick);
        }
        for (const { h, lane } of labels) {
          const r = rows.find(r => r.id === h.rowId), labelY = 35 + lane * 58;
          const label = svgEl('g', { tabindex: 0, role: 'button', 'aria-label': `Inspect ${h.branch}${h.historical ? ' historical PR head' : ''}`, class: 'git-graph-label' });
          // Muted leaders attach labels, not commit ancestry.
          label.append(svgEl('path', { d: `M${x(h.sha) + 8} ${y(h.sha)} L${labelX - 10} ${labelY}`, class: 'git-label-leader' }));
          label.append(svgEl('text', { x: labelX, y: labelY }, h.branch), svgEl('text', { x: labelX, y: labelY + 17, class: 'git-graph-hint' }, `${h.sha.slice(0, 10)} · ${h.historical ? 'Historical PR head' : r?.integration.status || 'Shared history · context only'}`));
          const action = () => { if (r) inspect(r, h); else { const { content } = dialog(h.branch); content.append(el('code', h.sha), el('p', 'Default branch · shared historical context')); } };
          label.addEventListener('click', action); label.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); action(); } });
          svg.append(label);
        }
        viewport.append(svg); if (selected.size) wrap.append(viewport);
        else wrap.append(el('p', 'No observed commits in this scope. Missing or unavailable refs are not ancestry.'));
        const boundaries = [...selected.values()].some(c => c.parents.some(p => !selected.has(p)));
        if (boundaries) wrap.append(el('small', 'Partial history boundary · earlier parents not loaded. No connection is inferred across this boundary.'));
        for (const h of heads) {
          if (!h.sha || !selected.has(h.sha)) {
            const r = rows.find(r => r.id === h.rowId);
            wrap.append(r ? button(`${h.branch} · ${h.refState}${h.sha ? ' · history unavailable / not loaded' : ''}`, () => inspect(r)) : el('small', `${h.branch} · ${h.refState}`));
          }
          if (h.sha && (!h.history || !h.history.complete)) {
            wrap.append(button(`${h.history?.errors?.length ? 'Retry history' : 'Load further history'} · ${h.branch}${h.historical ? ' (historical)' : ''}`, e => moreHistory(h, e.currentTarget)));
            if (h.history?.errors?.length) wrap.append(el('small', `${h.history.errors.map(e => e.code).join(', ')} · Check Git access and retry. Correlation ID: ${h.history.correlationId || data.correlationId}`));
          }
        }
      }
      // Associations without refs remain discoverable, but never become graph nodes.
      for (const r of rows.filter(r => !r.branch)) wrap.append(button(`${r.name} · No branch recorded`, () => inspect(r)));
      return wrap;
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
      const pending = allRows().filter(r => matches(r) && r.branch && r.integration.status !== 'integrated');
      content.append(el('h3', 'Pending branches'), el('small', 'Earlier commits → Latest · Select a branch to inspect'), tree('pending', pending));
      content.append(el('p', '● Commit · Curves show observed splits / joins only · Scroll horizontally for history', 'git-legend'));
      for (const epic of data.epics) {
        const rows = [epic, ...epic.tickets].filter(matches);
        if (!rows.length) continue;
        const section = el('section', undefined, 'git-epic-tree'), header = el('div', undefined, 'git-heading');
        const title = el('div'); title.append(el('h3', `${epic.epicKey || 'Epic'} · ${epic.name}`), el('small', `${epic.ticketCounts.integrated} ticket branches integrated · ${epic.ticketCounts.notIntegrated} pending · ${epic.ticketCounts.unknown} unknown`));
        header.append(title);
        if (epic.branch) {
          if (epic.pullRequests.length) header.append(button('View open PR', () => inspect(epic)));
          else if (data.canManageCode && epic.headSha && epic.destination) header.append(button('Review & create PR', () => startReview(epic.branch, epic.destination)));
          else header.append(button('Branch details', () => inspect(epic)));
        }
        section.append(header, tree(epic.id, rows)); content.append(section);
      }
      const other = data.other.filter(matches), section = el('section', undefined, 'git-epic-tree');
      section.append(el('h3', 'Other branches · No epic'), tree('other', other)); content.append(section);
    }
    function render() {
      root.replaceChildren();
      const header = el('div', undefined, 'git-heading'), actions = el('div', undefined, 'git-header-actions');
      actions.append(button('Saved reviews', savedReviews), button('Refresh', () => load(true)));
      header.append(el('h2', 'Git'), actions); root.append(header);
      if (!data) return;
      root.append(el('small', `${data.repository} · ${data.canManageCode ? 'Review-first actions' : 'Read-only access'} · Refreshed ${refreshedAt}`));
      if (!data.completeness.complete) notice(`Partial / unknown data — check access and refresh. ${data.completeness.errors.map(e => e.code).join(', ')} · Correlation ID: ${data.correlationId}`);
      const controls = el('div', undefined, 'git-controls');
      const branches = button('Branch trees', () => { view = 'branches'; render(); }); branches.setAttribute('aria-pressed', String(view === 'branches'));
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
