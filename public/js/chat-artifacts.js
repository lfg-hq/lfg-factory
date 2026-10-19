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
        // Preserve action nodes across streamed chunks and the draft-to-saved transition.
        if (!m.documentUI) {
            const head = el('header', null, 'ca-head');
            const icon = el('span', '▤', 'ca-document-icon'); icon.setAttribute('aria-hidden','true');
            const heading = el('div', null, 'ca-heading');
            m.title = el('strong'); m.subtitle = el('small', '', 'ca-muted');
            heading.append(m.title, m.subtitle);
            head.append(icon, heading, button('Expand ↗', () => showDocument(m)));
            m.excerpt = el('div', null, 'ca-excerpt');
            const foot = el('footer', null, 'ca-foot');
            m.status = el('small', '', 'ca-muted');
            m.sidebar = button('View in sidebar', () => openSidebar(m));
            m.review = button('Review changes', () => showChanges(m));
            m.review.className = 'ca-review-changes';
            const actions = el('div', null, 'ca-foot-actions'); actions.append(m.review, m.sidebar);
            foot.append(m.status, actions);
            m.card.replaceChildren(head, m.excerpt, foot);
            m.documentUI = true;
        }
        m.title.textContent = m.artifact.name;
        const updated = m.saved && m.artifact.previousVersion;
        m.subtitle.textContent = updated ? 'Document · updated' : m.saved ? 'Document' : 'Document · draft';
        m.card.classList.toggle('is-updated', !!updated);
        m.review.hidden = !updated;
        m.status.textContent = m.saved ? 'Saved to Docs' : m.interrupted ? 'Interrupted · draft not saved' : 'Writing…';
        m.sidebar.disabled = !m.saved;
        m.sidebar.title = m.saved ? 'Open this document in the sidebar' : 'Available once the document is saved';
        // Title already appears in the toolbar; show the document body beneath it.
        // Diagrams need the full view; a cut-off Mermaid fence would show as raw source.
        const text = m.content.replace(/^# [^\n]+\n*/, '').replace(/```mermaid[\s\S]*?(```|$)/g, '*Diagram · expand to view*');
        m.excerpt.replaceChildren(markdown(text ? text.slice(0,600) + (text.length > 600 ? '\n\n…' : '') : (m.saved ? 'Open to read the saved document.' : 'Writing document…')));
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
    function paint(m) {
        const card = m.card; const a = m.artifact;
        if (m.reader?.isConnected) m.reader.replaceChildren(el('p', m.saved ? 'Saved to Docs' : 'Draft · not saved', 'ca-muted'), markdown(m.content || 'Writing document…'));
        const head = el('header', null, 'ca-head');
        const title = el('div', null, 'ca-heading'); title.append(el('strong', a.name));
        head.append(title);
        if (a.kind === 'tickets') {
            const tickets = a.tickets || [];
            title.append(el('small', tickets.length + ' tickets', 'ca-muted'));
            const toggle = button(m.collapsed ? '⌄' : '⌃', () => { m.collapsed = !m.collapsed; paint(m); });
            toggle.setAttribute('aria-label', m.collapsed ? 'Show ticket preview' : 'Collapse ticket preview'); toggle.setAttribute('aria-expanded', String(!m.collapsed)); head.append(toggle);
            const rows = el('div'); rows.hidden = m.collapsed;
            tickets.slice(0,3).forEach(t => rows.append(ticketRow(t, m, ticket => showTickets(m, ticket))));
            const foot = el('footer', null, 'ca-foot'); foot.append(el('small', m.collapsed ? 'Saved to Tickets' : 'Showing ' + Math.min(3,tickets.length) + ' of ' + tickets.length, 'ca-muted'), button('View all ' + tickets.length + ' ↗', () => showTickets(m)));
            card.replaceChildren(head, rows, foot);
        } else {
            paintDocument(m);
        }
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
        m.artifact = artifact; m.saved = true; m.interrupted = false; m.card.dataset.artifactId = artifact.id;
        paint(m);
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
        container.querySelectorAll('.chat-artifact-card').forEach(card => { const m = models.get(card); if (m && !m.saved) {m.interrupted = true; paint(m);} });
    }
    window.ChatArtifacts = {render, stream, finish};
})();
