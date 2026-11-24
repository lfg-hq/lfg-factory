/* Inline saved-document and ticket references. No mutations or automatic panel opening. */
(function () {
    'use strict';
    const models = new WeakMap();
    const el = (tag, text, cls) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (cls) node.className = cls; return node; };
    const button = (text, action) => { const b = el('button', text); b.type = 'button'; b.addEventListener('click', action); return b; };
    const encoded = encodeURIComponent;
    async function json(url) { const r = await fetch(url); if (!r.ok) throw new Error('Unavailable'); return r.json(); }
    // Allow document formatting without executable HTML, remote media, or unsafe links.
    // `diagrams` keeps Mermaid fences recognizable so the shared renderer draws them.
    function markdown(content, {diagrams = false} = {}) {
        const out = el('div', null, 'ca-markdown');
        if (!window.marked) { out.textContent = content; return out; }
        const parsed = new DOMParser().parseFromString(window.marked.parse(String(content)), 'text/html');
        const tags = new Set(['P','BR','H1','H2','H3','H4','H5','H6','UL','OL','LI','STRONG','EM','DEL','BLOCKQUOTE','PRE','CODE','HR','TABLE','THEAD','TBODY','TR','TH','TD','A']);
        function clean(source, target) {
            for (const n of source.childNodes) {
                if (n.nodeType === 3) { target.append(document.createTextNode(n.textContent)); continue; }
                if (n.nodeType !== 1) continue;
                if (['SCRIPT','STYLE','IFRAME','OBJECT','SVG','FORM'].includes(n.tagName)) continue;
                if (!tags.has(n.tagName)) { clean(n, target); continue; }
                const copy = document.createElement(n.tagName.toLowerCase());
                if (diagrams && n.tagName === 'CODE' && n.classList.contains('language-mermaid')) copy.className = 'language-mermaid';
                if (n.tagName === 'A') {
                    const href = n.getAttribute('href') || '';
                    if (/^(https?:\/\/|mailto:|\/(?!\/)|#)/i.test(href)) { copy.setAttribute('href', href); copy.setAttribute('rel', 'noopener noreferrer'); copy.setAttribute('target', '_blank'); }
                }
                clean(n, copy); target.append(copy);
            }
        }
        clean(parsed.body, out); return out;
    }
    function dialog(title) {
        const opener = document.activeElement;
        const modal = el('dialog', null, 'ca-dialog');
        modal.setAttribute('aria-label', title);
        const head = el('header', null, 'ca-dialog-head'); head.append(el('strong', title));
        const close = button('×', () => modal.close());
        close.className = 'ca-dialog-close'; close.title = 'Close'; close.setAttribute('aria-label', 'Close');
        head.append(close);
        const body = el('div', null, 'ca-dialog-body'); modal.append(head, body); document.body.append(modal);
        modal.addEventListener('close', () => { modal.remove(); if (opener?.isConnected) opener.focus(); });
        modal.showModal(); return { modal, body };
    }
    async function readDocument(m, target) {
        target.replaceChildren(el('p', 'Loading document…', 'ca-muted'));
        try {
            const result = await json('/projects/' + encoded(m.projectId) + '/api/files/' + encoded(m.artifact.id) + '/content');
            m.content = String(result.content || '');
            target.replaceChildren(markdown(m.content || 'This document is empty.', {diagrams: true}));
        } catch (_) {
            target.replaceChildren(el('p', 'This document could not be loaded. It may have been removed, or access has changed.'));
            target.append(button('Retry', () => readDocument(m, target)));
        }
    }
    function showDocument(m) {
        if (m.dialog?.open) { m.dialog.focus(); return; }
        const { modal, body } = dialog(m.artifact.name);
        m.dialog = modal;
        modal.addEventListener('close', () => { if (m.dialog === modal) { m.dialog = null; m.reader = null; } });
        if (m.saved) readDocument(m, body);
        else { m.reader = body; body.append(el('p', 'Draft · not saved', 'ca-muted'), markdown(m.content || 'Writing document…')); }
    }
    // Line diff (LCS). Documents are a few hundred lines, so the table stays small.
    function diffLines(before, after) {
        const a = before.split('\n'), b = after.split('\n');
        const n = a.length, w = b.length + 1, dp = new Uint32Array((n + 1) * w);
        for (let i = n - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
            dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
        const ops = []; let i = 0, j = 0;
        while (i < n && j < b.length) {
            if (a[i] === b[j]) { ops.push({t:'=', text:a[i]}); i++; j++; }
            else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) ops.push({t:'-', text:a[i++]});
            else ops.push({t:'+', text:b[j++]});
        }
        while (i < n) ops.push({t:'-', text:a[i++]});
        while (j < b.length) ops.push({t:'+', text:b[j++]});
        let hunk = -1, inChange = false;
        for (const op of ops) { if (op.t === '=') inChange = false; else { if (!inChange) hunk++; inChange = true; op.hunk = hunk; } }
        return {ops, hunks: hunk + 1};
    }
    // Rebuild the current document with one change (or all, when hunk is null) undone.
    function revert(ops, hunk) {
        return ops.filter(op => op.t === '=' || (hunk === null || op.hunk === hunk ? op.t === '-' : op.t === '+')).map(op => op.text).join('\n');
    }
    async function saveContent(m, content) {
        const query = '?type=' + encoded(m.artifact.fileType || 'document') + '&name=' + encoded(m.artifact.name);
        const r = await fetch('/projects/' + encoded(m.projectId) + '/api/files' + query, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({content})});
        if (!r.ok) throw new Error('Save failed');
    }
    async function showChanges(m) {
        const { body } = dialog('Changes · ' + m.artifact.name);
        body.classList.add('ca-diff-body');
        let before;
        const draw = async () => {
            body.replaceChildren(el('p', 'Loading changes…', 'ca-muted'));
            try {
                if (before == null) {
                    const old = await json('/projects/' + encoded(m.projectId) + '/api/files/' + encoded(m.artifact.id) + '/versions/' + encoded(m.artifact.previousVersion));
                    before = String(old.version?.content || '');
                }
                const current = await json('/projects/' + encoded(m.projectId) + '/api/files/' + encoded(m.artifact.id) + '/content');
                m.content = String(current.content || '');
                const {ops, hunks} = diffLines(before, m.content);
                const added = ops.filter(o => o.t === '+').length, removed = ops.filter(o => o.t === '-').length;
                const summary = el('div', null, 'ca-diff-summary');
                summary.append(el('span', hunks ? hunks + (hunks === 1 ? ' change' : ' changes') + ' since version ' + m.artifact.previousVersion : 'No differences from version ' + m.artifact.previousVersion),
                    el('span', '+' + added, 'ca-diff-added-count'), el('span', '−' + removed, 'ca-diff-removed-count'));
                if (hunks > 1) summary.append(button('Undo all changes', () => apply(revert(ops, null))));
                body.replaceChildren(summary);
                for (let h = 0; h < hunks; h++) {
                    const first = ops.findIndex(o => o.hunk === h), last = ops.findLastIndex(o => o.hunk === h);
                    const block = el('section', null, 'ca-diff-hunk');
                    const head = el('header', null, 'ca-diff-hunk-head');
                    head.append(el('strong', 'Change ' + (h + 1)), button('Undo this change', () => apply(revert(ops, h))));
                    block.append(head);
                    for (let k = Math.max(0, first - 2); k <= Math.min(ops.length - 1, last + 2); k++) {
                        const op = ops[k];
                        const line = el('div', op.text || ' ', 'ca-diff-line ' + (op.t === '+' ? 'is-added' : op.t === '-' ? 'is-removed' : 'is-context'));
                        line.dataset.sign = op.t === '=' ? ' ' : op.t === '+' ? '+' : '−';
                        block.append(line);
                    }
                    body.append(block);
                }
            } catch (_) {
                body.replaceChildren(el('p', 'Could not load the changes. The earlier version may have been removed.'), button('Retry', draw));
            }
        };
        const apply = async content => {
            body.querySelectorAll('button').forEach(b => { b.disabled = true; });
            try { await saveContent(m, content); m.content = content; paint(m); await draw(); }
            catch (_) { body.prepend(el('p', 'Could not save the document. Try again.', 'ca-diff-error')); body.querySelectorAll('button').forEach(b => { b.disabled = false; }); }
        };
        await draw();
    }
    function openSidebar(m) {
        if (!m.saved) return;
        m.dialog?.close();
        if (typeof window.viewFileContent === 'function') {
            window.viewFileContent(m.artifact.id, m.artifact.name);
        } else if (window.ArtifactsLoader?.loadFileBrowser) {
            window.ArtifactsPanel?.open();
            window.ArtifactsLoader.loadFileBrowser(m.projectId, {openFileId:m.artifact.id, openFileName:m.artifact.name});
        } else {
            m.status.textContent = 'Sidebar unavailable. Use Expand to read this document.';
        }
    }
    function paintDocument(m) {
        // One line: the agent's reply already summarises the document, so the card only
        // names it and opens it. Saved: the sidebar. Still being written: the live draft.
        if (!m.documentUI) {
            m.open = el('button', null, 'ca-doc-line'); m.open.type = 'button';
            m.open.addEventListener('click', () => (m.saved ? openSidebar(m) : showDocument(m)));
            const icon = el('span', '▤', 'ca-document-icon'); icon.setAttribute('aria-hidden','true');
            m.title = el('span', '', 'ca-doc-title');
            m.status = el('span', '', 'ca-doc-meta ca-muted');
            const arrow = el('span', '›', 'ca-doc-arrow'); arrow.setAttribute('aria-hidden','true');
            m.open.append(icon, m.title, m.status, arrow);
            m.review = button('Review changes', () => showChanges(m));
            m.review.className = 'ca-review-changes';
            m.card.replaceChildren(m.open, m.review);
            m.documentUI = true;
        }
        m.title.textContent = m.artifact.name;
        const updated = m.saved && m.artifact.previousVersion;
        m.status.textContent = updated ? 'Document updated' : m.saved ? '' : m.interrupted ? 'Interrupted · draft not saved' : 'Writing…';
        m.status.hidden = !m.status.textContent;
        m.card.classList.toggle('is-updated', !!updated);
        m.card.classList.toggle('is-draft', !m.saved);
        m.review.hidden = !updated;
        m.open.title = m.saved ? 'Open ' + m.artifact.name + ' in the sidebar' : 'Read the draft so far';
    }
    function ticketRow(ticket, m, open) {
        const row = button('', () => open(ticket)); row.className = 'ca-ticket-row';
        row.append(el('span', ticket.ticketKey || 'Ticket', 'ca-ticket-key'), el('span', ticket.name, 'ca-ticket-title'), el('span', '›', 'ca-muted'));
        row.setAttribute('aria-label', (ticket.ticketKey || 'Ticket') + ': ' + ticket.name);
        row.title = ticket.name; return row;
    }
    // Criteria arrive as an array, a JSON-encoded array, or plain text lines.
    function criteriaList(value) {
        if (typeof value === 'string') {
            const text = value.trim();
            if (text.startsWith('[')) { try { value = JSON.parse(text); } catch (_) { /* plain text */ } }
            if (typeof value === 'string') return text.split('\n').map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean);
        }
        return Array.isArray(value) ? value.map(item => String(typeof item === 'object' && item ? item.text || item.criterion || JSON.stringify(item) : item).trim()).filter(Boolean) : [];
    }
    async function showTickets(m, selected) {
        const { body } = dialog(m.artifact.name);
        let all = m.artifact.tickets || [];
        function list() { body.replaceChildren(el('h2', m.artifact.name)); all.forEach(t => body.append(ticketRow(t, m, detail))); }
        async function detail(ticket) {
            body.replaceChildren(el('p', 'Loading ticket…', 'ca-muted'));
            try {
                const result = await json('/api/projects/' + encoded(m.projectId) + '/tickets/' + encoded(ticket.id));
                const t = result.ticket; if (!t) throw new Error('Missing');
                body.replaceChildren(button('← All tickets', list), el('h2', t.name), el('p', [t.ticketKey, t.status].filter(Boolean).join(' · '), 'ca-muted'), markdown(t.description || 'No description.'));
                const criteria = criteriaList(t.acceptanceCriteria);
                if (criteria.length) {
                    const list = el('ul', null, 'ca-criteria');
                    criteria.forEach(item => list.append(el('li', item)));
                    body.append(el('h3', 'Acceptance criteria'), list);
                }
                body.append(el('h3', 'Dependencies'));
                let deps = t.dependencies || []; if (typeof deps === 'string') { try { deps = JSON.parse(deps); } catch (_) { deps = [deps]; } }
                if (!Array.isArray(deps) || !deps.length) body.append(el('p','No saved dependencies.'));
                else deps.forEach(dep => {
                    const id = typeof dep === 'string' ? dep : dep.ticketId || dep.id;
                    const match = all.find(x => x.id === id || x.ticketKey === id);
                    if (match) body.append(ticketRow(match, m, detail));
                    else body.append(el('p', String(id || 'Unresolved dependency')));
                });
            } catch (_) { body.replaceChildren(el('p','Could not load this ticket.'), button('Retry', () => detail(ticket)), button('All tickets', list)); }
        }
        if (selected) detail(selected); else list();
    }
    // ── Live build card: every ticket in the build, its stage and latest update ──
    const TERMINAL = new Set(['ready','failed','stopped','waiting']);
    function pollBuild(m) {
        if (m.polling) return;
        m.polling = true;
        const tick = async () => {
            m.poll = null;
            if (!m.card.isConnected) { m.polling = false; return; }
            try {
                m.progress = await json('/api/projects/' + encoded(m.projectId) + '/build-progress?tickets=' + m.artifact.ticketIds.map(encoded).join(','));
                paint(m);
                if (m.progress.active) m.poll = setTimeout(tick, document.hidden ? 15000 : 4000); else m.polling = false;
            } catch (_) { m.poll = setTimeout(tick, 15000); }
        };
        tick();
    }
    function paintBuild(m) {
        const tickets = m.progress?.tickets || (m.artifact.ticketIds || []).map(id => ({id, key:'', name:'Loading…', stage:'queued', label:'Queued'}));
        const ready = tickets.filter(t => t.stage === 'ready').length;
        const failed = tickets.find(t => t.stage === 'failed');
        const active = tickets.some(t => !TERMINAL.has(t.stage));
        const head = el('header', null, 'ca-head');
        const heading = el('div', null, 'ca-heading');
        heading.append(el('strong', active && tickets.every(t => t.stage === 'changing' || TERMINAL.has(t.stage)) ? 'Updating ' + (tickets.length === 1 ? (tickets[0].key || 'ticket') : tickets.length + ' tickets') : active ? 'Building ' + tickets.length + (tickets.length === 1 ? ' ticket' : ' tickets') : failed ? 'Build paused' : ready === tickets.length ? 'Build complete' : 'Build'),
            el('small', ready + ' of ' + tickets.length + ' ready', 'ca-muted'));
        head.append(heading);
        const bar = el('div', null, 'ca-build-bar'); bar.setAttribute('role', 'progressbar');
        bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', String(tickets.length)); bar.setAttribute('aria-valuenow', String(ready));
        const fill = el('span'); fill.style.width = (tickets.length ? Math.round(100 * ready / tickets.length) : 0) + '%'; bar.append(fill);
        const list = el('div', null, 'ca-build-list');
        for (const t of tickets) {
            const row = button('', () => window.TicketAgentChat?.open(String(t.id), t.key || '', t.name || '', {status: t.stage}));
            row.className = 'ca-build-row'; row.dataset.stage = t.stage;
            row.setAttribute('aria-label', (t.key || 'Ticket') + ' ' + t.name + ': ' + t.label + (t.update ? '. ' + t.update : ''));
            const dot = el('span', null, 'ca-build-dot'); dot.setAttribute('aria-hidden', 'true');
            const text = el('span', null, 'ca-build-text');
            const title = el('span', null, 'ca-build-title'); title.append(el('small', t.key || '', 'ca-ticket-key'), el('span', t.name));
            text.append(title);
            // The stage pill already says Ready; the note is only news while work runs or after a failure.
            const note = String(t.update || '').replace(/^[\u2600-\u27BF\u{1F300}-\u{1FAFF}\uFE0F\s]+/u, '');
            if (note && t.stage !== 'ready' && t.stage !== 'waiting') text.append(el('span', note, 'ca-build-update'));
            const stage = el('span', t.label + (t.sha && t.stage !== 'waiting' ? ' · ' + t.sha : ''), 'ca-build-stage');
            row.append(dot, text, stage); list.append(row);
        }
        const foot = el('footer', null, 'ca-foot');
        foot.append(el('small', active ? 'Updates live while the build runs' : failed ? (failed.key || 'A ticket') + ' needs attention; the rest wait for it' : 'Each ticket\'s code is committed to its branch', 'ca-muted'));
        m.card.replaceChildren(head, bar, list, foot);
    }
    // Build steps from the set's own dependencies: step 1 is what can start now, each
    // later step waits on an earlier one. A set saved without dependencies is one list.
    function buildSteps(tickets) {
        const ids = new Set(tickets.map(t => t.id));
        const step = new Map();
        const level = (t, seen = new Set()) => {
            if (step.has(t.id)) return step.get(t.id);
            if (seen.has(t.id)) return 0;
            seen.add(t.id);
            const deps = (t.dependsOn || []).filter(id => ids.has(id)).map(id => tickets.find(x => x.id === id));
            const n = deps.length ? 1 + Math.max(...deps.map(d => level(d, seen))) : 0;
            step.set(t.id, n); return n;
        };
        tickets.forEach(t => level(t));
        const groups = [];
        tickets.forEach(t => { const n = step.get(t.id); (groups[n] ||= []).push(t); });
        return groups.filter(Boolean);
    }
    function openTicket(m, t) {
        if (window.TicketAgentChat?.open) window.TicketAgentChat.open(String(t.id), t.ticketKey || '', t.name || '');
        else showTickets(m, t);
    }
    function openTicketsPanel(m) {
        try { window.ArtifactsPanel?.open?.(); } catch (_) {}
        if (window.switchTab) { window.switchTab('checklist'); window.ArtifactsLoader?.loadChecklist?.(m.projectId); }
        else showTickets(m);
    }
    // One card for the whole set: every ticket in build order, then the next step.
    function paintTickets(m, head, title) {
        const card = m.card; const a = m.artifact;
        const tickets = a.tickets || [];
        const groups = buildSteps(tickets);
        title.append(el('small', tickets.length + (tickets.length === 1 ? ' ticket' : ' tickets') + (groups.length > 1 ? ' · in build order' : ''), 'ca-muted'));
        const list = el('div', null, 'ca-ticket-set');
        // Up to four steps read well as headings; a longer chain would be all headings,
        // so then each row says which numbered tickets come before it instead.
        const headed = groups.length > 1 && groups.length <= 4;
        const number = new Map(groups.flat().map((t, i) => [t.id, i + 1]));
        let n = 0;
        groups.forEach((group, i) => {
            if (headed) list.append(el('div', i === 0 ? 'Step 1 · starts first' : 'Step ' + (i + 1) + ' · after step ' + i, 'ca-step-label'));
            group.forEach(t => {
                const row = button('', () => openTicket(m, t)); row.className = 'ca-set-row';
                const name = el('span', null, 'ca-set-title'); name.append(el('span', t.name));
                const after = (t.dependsOn || []).map(id => number.get(id)).filter(Boolean).sort((x, y) => x - y);
                if (!headed && after.length) name.append(el('small', ' · after ' + after.join(', '), 'ca-set-after'));
                row.append(el('span', String(++n), 'ca-set-num'), name, el('span', t.ticketKey || '', 'ca-set-key'));
                row.setAttribute('aria-label', (t.ticketKey ? t.ticketKey + ': ' : '') + t.name);
                row.title = t.name;
                list.append(row);
            });
        });
        const foot = el('footer', null, 'ca-foot');
        const actions = el('div', null, 'ca-foot-actions');
        // A build card after this one means the build was already asked for.
        const later = [...card.parentElement?.querySelectorAll('.chat-artifact-card[data-artifact-kind="build_run"]') || []].some(c => card.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING);
        if (!later && !m.buildRequested) {
            const start = button('Start building', () => {
                const input = document.getElementById('chat-input'); const form = document.getElementById('chat-form');
                if (!input || !form) return;
                input.value = 'Start building ' + (tickets.length === 1 ? (tickets[0].ticketKey || 'this ticket') : 'these ' + tickets.length + ' tickets') + ' (' + a.name + ').';
                input.dispatchEvent(new Event('input', {bubbles:true}));
                form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', {cancelable:true}));
                m.buildRequested = true; paint(m);
            });
            start.className = 'ca-primary';
            actions.append(start);
        }
        actions.append(button('Open in Tickets', () => openTicketsPanel(m)));
        foot.append(el('small', m.buildRequested ? 'Build requested' : 'Click a ticket to open it', 'ca-muted'), actions);
        card.replaceChildren(head, list, foot);
    }
    function paint(m) {
        const card = m.card; const a = m.artifact;
        if (m.reader?.isConnected) m.reader.replaceChildren(el('p', m.saved ? 'Saved to Docs' : 'Draft · not saved', 'ca-muted'), markdown(m.content || 'Writing document…'));
        const head = el('header', null, 'ca-head');
        const title = el('div', null, 'ca-heading'); title.append(el('strong', a.name));
        head.append(title);
        if (a.kind === 'build_run') { paintBuild(m); return; }
        if (a.kind === 'evals') {
            // An eval suite: models, a Run button and the live results table (public/js/evals.js).
            if (window.EvalsUI) window.EvalsUI.card(m);
            else { title.append(el('small', 'Evals', 'ca-muted')); card.replaceChildren(head); }
            return;
        }
        if (a.kind === 'board') {
            // A whiteboard the agent drew on: opens live in the Boards panel beside the chat.
            title.append(el('small', 'Whiteboard', 'ca-muted'));
            const open = () => { if (window.BoardsTab) window.BoardsTab.open(a.id); else window.open('/projects/' + encoded(m.projectId) + '/whiteboards/' + encoded(a.id), '_blank'); };
            const foot = el('footer', null, 'ca-foot'); foot.append(el('small', 'Drawn live on the board', 'ca-muted'), button('Open board ↗', open));
            card.replaceChildren(head, foot);
            if (!m.opened && !m.replayed) { m.opened = true; if (window.BoardsTab) window.BoardsTab.open(a.id, {quiet:true}); }
            return;
        }
        if (a.kind === 'tickets') paintTickets(m, head, title);
        else paintDocument(m);
    }
    function create(container, artifact, projectId, callId) {
        const card = el('article', null, 'chat-artifact-card');
        card.dataset.artifactId = artifact.id; card.dataset.artifactKind = artifact.kind;
        if (callId) card.dataset.callId = callId;
        const m = {card, artifact, projectId, content:'', saved: true, collapsed:false}; models.set(card,m); container.append(card); return m;
    }
    function render(container, artifact, projectId, opts = {}) {
        let card = opts.callId && [...container.querySelectorAll('.chat-artifact-card')].find(c => c.dataset.callId === opts.callId);
        // Replay can be delivered more than once during reconnect. Deduplicate references.
        if (!card) card = [...container.querySelectorAll('.chat-artifact-card')].find(c => c.dataset.artifactId === artifact.id && c.dataset.artifactKind === artifact.kind);
        const m = card ? models.get(card) : create(container, artifact, projectId, opts.callId);
        // The build card belongs under the reply that started the build, not above it.
        if (!card && artifact.kind === 'build_run' && !opts.replay) m.trailing = true;
        m.artifact = artifact; m.saved = true; m.interrupted = false; m.card.dataset.artifactId = artifact.id;
        if (opts.replay) m.replayed = true;
        paint(m);
        if (artifact.kind === 'build_run') {
            pollBuild(m);
            // The ticket sets above no longer need their Start building button.
            container.querySelectorAll('.chat-artifact-card[data-artifact-kind="tickets"]').forEach(c => { const t = models.get(c); if (t) paint(t); });
        }
        if (artifact.kind === 'document') {
            json('/projects/' + encoded(projectId) + '/api/files/' + encoded(artifact.id) + '/content').then(result => { m.content = String(result.content || ''); paint(m); }).catch(() => {});
        }
    }
    function stream(container, data, projectId) {
        if (!data.tool_call_id) return;
        let card = [...container.querySelectorAll('.chat-artifact-card')].find(c => c.dataset.callId === data.tool_call_id);
        const m = card ? models.get(card) : create(container, {kind:'document',id:'draft-' + data.tool_call_id,name:data.file_name || 'Document'}, projectId, data.tool_call_id);
        m.saved = false; if (data.file_name) m.artifact.name = data.file_name; m.content += data.content_chunk || ''; paint(m);
    }
    function finish(container) {
        container.querySelectorAll('.chat-artifact-card').forEach(card => {
            const m = models.get(card); if (!m) return;
            if (!m.saved) { m.interrupted = true; paint(m); }
            if (m.trailing) { m.trailing = false; container.append(card); }
        });
    }
    window.ChatArtifacts = {render, stream, finish};
})();
