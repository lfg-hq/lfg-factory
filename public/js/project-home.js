/*
 * Project Home dashboard: a queue of what needs the viewer, what is building, and
 * where each epic stands. Rows open a side panel so a decision can be made without
 * leaving the page. All data comes from GET /api/projects/:id/home (`dash`).
 */
(() => {
    const GROUPS = [['all', 'All'], ['review', 'Reviews'], ['question', 'Questions'], ['problem', 'Problems']];
    const KIND_ICON = { epic_review: 'fa-check', epic_merge: 'fa-code-merge', ticket_review: 'fa-code-pull-request', question: 'fa-circle-question', mention: 'fa-at', failed: 'fa-triangle-exclamation' };
    const KIND_TONE = { epic_review: 'ok', epic_merge: 'ok', ticket_review: 'tint', question: 'tint', mention: 'plain', failed: 'bad' };
    const STATE_LABEL = { ready: 'Ready', building: 'Building', queued: 'Queued', failed: 'Needs attention', waiting: 'Waiting', open: 'Not started' };
    const STATE_TONE = { ready: 'ok', building: 'tint', queued: 'plain', failed: 'bad', waiting: 'warn', open: 'plain' };
    const MAX_PATCH_LINES = 60, MAX_FILES = 12;
    let dash = null, filter = 'all', openItem = null, lastFocus = null;

    const host = () => document.querySelector('.home-dashboard');
    const pid = () => encodeURIComponent(host().dataset.project);
    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
    function rel(ts) {
        if (!ts) return '';
        const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
        if (s < 60) return 'just now';
        if (s < 3600) return Math.floor(s / 60) + 'm ago';
        if (s < 86400) return Math.floor(s / 3600) + 'h ago';
        if (s < 604800) return Math.floor(s / 86400) + 'd ago';
        return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }
    function safeUrl(value) {
        if (typeof value !== 'string' || !value.trim()) return null;
        try { const url = new URL(value, location.origin); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; } catch (_) { return null; }
    }
    function ticketState(t) {
        if (t.queueStatus === 'queued') return 'queued';
        if (['executing', 'running', 'stopping'].includes(t.queueStatus) || t.status === 'in_progress') return 'building';
        if (['review', 'done', 'merged', 'archived'].includes(t.status)) return 'ready';
        if (['failed', 'blocked'].includes(t.status)) return 'failed';
        return 'open';
    }
    const bar = (states) => '<span class="dash-bar" aria-hidden="true">' + (states.length ? states : ['open']).map((s) => '<i class="' + s + '"></i>').join('') + '</span>';
    const tag = (text, tone) => '<span class="dash-tag ' + (tone || 'plain') + '">' + esc(text) + '</span>';
    const ticketUrl = (id) => '/projects/' + pid() + '/tickets?ticket=' + encodeURIComponent(id);
    const diffUrl = (id) => '/projects/' + pid() + '/tickets/' + encodeURIComponent(id) + '/diff';
    const epicUrl = (id) => '/projects/' + pid() + '/epics?epic=' + encodeURIComponent(id);
    async function api(path, options) {
        const res = await fetch(path, options ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body || {}) } : undefined);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'That did not work. Try again.');
        return data;
    }

    // ── Dashboard ────────────────────────────────────────────────────────
    window.renderHomeDash = function (data) {
        if (!host() || !data) return;
        dash = data;
        const status = $('home-refresh-status'); if (status) status.hidden = true;
        host().classList.toggle('is-new', !data.hasWork && host().dataset.chats === '0');
        renderStatus(); renderQueue(); renderProgress(); renderEpics(); renderSide();
    };

    function renderStatus() {
        const s = dash.stats, parts = [];
        parts.push('<span><b>' + s.needsYou + '</b> need' + (s.needsYou === 1 ? 's' : '') + ' you</span>');
        if (s.building) parts.push('<span><i class="dash-dot"></i><b>' + s.building + '</b> building</span>');
        if (s.queued) parts.push('<span><b>' + s.queued + '</b> queued</span>');
        if (s.waiting) parts.push('<span><b>' + s.waiting + '</b> waiting</span>');
        if (s.total) parts.push('<span><b>' + s.ready + '</b> of ' + s.total + ' tickets ready</span>');
        $('dash-status').innerHTML = parts.join('') + '<span class="dash-status-time">Updated ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '</span>';
    }

    function renderQueue() {
        const count = (g) => dash.queue.filter((i) => g === 'all' || i.group === g).length;
        if (filter !== 'all' && !count(filter)) filter = 'all';
        $('dash-queue-count').textContent = dash.queue.length || '';
        $('dash-filters').innerHTML = dash.queue.length > 1 ? GROUPS.filter(([g]) => g === 'all' || count(g)).map(([g, label]) =>
            '<button type="button" class="dash-chip' + (filter === g ? ' on' : '') + '" data-filter="' + g + '" aria-pressed="' + (filter === g) + '">' + label + ' · ' + count(g) + '</button>').join('') : '';
        const items = dash.queue.filter((i) => filter === 'all' || i.group === filter);
        $('dash-queue').innerHTML = items.length ? items.map((i) =>
            '<button type="button" class="dash-row" data-open="' + esc(i.id) + '">' +
            '<span class="dash-ico ' + KIND_TONE[i.kind] + '"><i class="fas ' + KIND_ICON[i.kind] + '" aria-hidden="true"></i></span>' +
            '<span class="dash-row-body"><span class="dash-row-title">' + esc(i.title) + '</span><span class="dash-row-detail">' + esc(i.detail) + '</span></span>' +
            '<span class="dash-row-time">' + esc(rel(i.at)) + '</span><span class="dash-action' + (i.kind === 'epic_review' || i.kind === 'epic_merge' ? ' primary' : '') + '">' + esc(i.action) + '</span></button>').join('')
            : '<div class="dash-caught"><span class="dash-ico ok"><i class="fas fa-check" aria-hidden="true"></i></span><strong>You are all caught up</strong><p>Reviews, questions and problems that need you will appear here.</p></div>';
    }

    function renderProgress() {
        const rows = dash.inProgress.map((t) =>
            '<a class="dash-row" href="' + ticketUrl(t.id) + '">' + (t.active ? '<span class="dash-live"><i class="dash-dot"></i></span>' : '<span class="dash-ico plain"><i class="far fa-clock" aria-hidden="true"></i></span>') +
            '<span class="dash-row-body"><span class="dash-row-title">' + esc(t.name) + (t.key ? ' <span class="dash-key">' + esc(t.key) + '</span>' : '') + '</span>' +
            '<span class="dash-row-detail">' + esc(t.update || t.epic || (t.active ? 'Working…' : 'Starts when the current ticket finishes')) + '</span></span>' +
            '<span class="dash-row-time">' + esc(rel(t.at)) + '</span>' + tag(t.label, t.active ? 'tint' : 'plain') + '</a>');
        dash.waiting.forEach((t) => rows.push(
            '<a class="dash-row" href="' + ticketUrl(t.id) + '"><span class="dash-ico warn"><i class="fas fa-link-slash" aria-hidden="true"></i></span>' +
            '<span class="dash-row-body"><span class="dash-row-title">' + esc(t.name) + (t.key ? ' <span class="dash-key">' + esc(t.key) + '</span>' : '') + '</span>' +
            '<span class="dash-row-detail">Waiting behind a ticket that needs attention</span></span>' + tag('Waiting', 'warn') + '</a>'));
        $('dash-progress-section').hidden = !rows.length;
        $('dash-progress').innerHTML = rows.join('');
    }

    function epicMessage(e) {
        const n = (s) => e.states.filter((x) => x === s).length;
        if (e.status === 'merged') return ['Merged to main', 'plain'];
        if (e.review === 'merge') return ['Approved', 'ok'];
        if (e.review === 'review') return ['Ready for review', 'ok'];
        if (n('failed')) return ['Needs attention', 'bad'];
        if (n('building')) return [n('building') + ' building', 'tint'];
        if (n('queued')) return [n('queued') + ' queued', 'plain'];
        if (!e.total) return ['No tickets yet', 'plain'];
        return [n('ready') ? 'In progress' : 'Not started', 'plain'];
    }
    function renderEpics() {
        $('dash-epics-section').hidden = !dash.epics.length;
        $('dash-epics').innerHTML = dash.epics.map((e) => {
            const ready = e.states.filter((s) => s === 'ready').length, [message, tone] = epicMessage(e);
            return '<button type="button" class="dash-row" data-epic="' + esc(e.id) + '"><span class="dash-row-body"><span class="dash-row-title">' + esc(e.name) +
                (e.epicKey ? ' <span class="dash-key">' + esc(e.epicKey) + '</span>' : '') + '</span><span class="dash-row-detail">' + (e.total ? ready + ' of ' + plural(e.total, 'ticket') + ' ready' : 'Planned, no tickets yet') + '</span></span>' +
                bar(e.states) + '<span class="dash-epic-state">' + tag(message, tone) + '</span></button>';
        }).join('');
    }

    function renderSide() {
        const preview = dash.preview && safeUrl(dash.preview.url);
        $('dash-preview-section').hidden = !preview;
        if (preview) $('dash-preview').innerHTML = '<div class="dash-preview-name">' + esc(dash.preview.name) + '</div><p class="home-muted">Updated ' + esc(rel(dash.preview.at)) + '</p>' +
            '<a class="dash-btn wide" href="' + esc(preview) + '" target="_blank" rel="noopener noreferrer">Open preview <i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i></a>';
        renderCalls();
        $('dash-docs').innerHTML = dash.docs.map((d) =>
            '<a class="dash-doc" href="/projects/' + pid() + '?tab=documents&doc=' + encodeURIComponent(d.id) + '&docName=' + encodeURIComponent(d.name) + '"><i class="far fa-file-lines" aria-hidden="true"></i><span>' + esc(d.name) + '</span><small>' + esc(rel(d.at)) + '</small></a>').join('');
    }

    // Calls LFG was in: the recap where it left off, with the full recap (its chat) and transcript a click away.
    function renderCalls() {
        const calls = dash.calls || [];
        $('dash-calls-section').hidden = !calls.length;
        $('dash-calls').innerHTML = calls.map((c) => {
            const when = c.live ? '<span class="dash-call-live">Live now</span>' : esc(rel(c.at)) + (c.minutes ? ' · ' + esc(c.minutes) + ' min' : '');
            const summary = c.live ? 'LFG is taking notes. Say "Hey LFG" or type @LFG in the call to ask for something.'
                : (c.recap || 'No recap: too little was said.');
            const links = [
                c.conversationId ? '<a href="/chat/project/' + pid() + '/conversation/' + encodeURIComponent(c.conversationId) + '">' + (c.recap && !c.live ? 'Recap' : 'Chat') + '</a>' : '',
                '<a href="/projects/' + pid() + '/meetings#call-' + encodeURIComponent(c.id) + '">Transcript</a>',
            ].filter(Boolean).join('');
            return '<div class="dash-call"><div class="dash-call-top"><span class="dash-row-title">' + esc(c.title) + '</span><span class="dash-row-detail">' + when + '</span></div>' +
                '<p class="dash-call-recap">' + esc(summary) + '</p><div class="dash-call-links">' + links + '</div></div>';
        }).join('');
    }

    // ── Panel ────────────────────────────────────────────────────────────
    function panelShell(kicker, title, sub) {
        return '<header class="dash-panel-head"><button type="button" class="dash-panel-close" data-close aria-label="Close"><i class="fas fa-xmark" aria-hidden="true"></i></button>' +
            '<p class="dash-kicker">' + esc(kicker) + '</p><h2 id="dash-panel-title">' + esc(title) + '</h2>' + (sub ? '<p class="home-muted">' + esc(sub) + '</p>' : '') + '</header>';
    }
    function showPanel(html) {
        const root = $('dash-panel-root');
        if (!root.firstChild) lastFocus = document.activeElement;
        root.innerHTML = '<div class="dash-scrim" data-close></div><aside class="dash-panel" role="dialog" aria-modal="true" aria-labelledby="dash-panel-title" tabindex="-1">' + html + '</aside>';
        document.documentElement.classList.add('dash-panel-open');
        root.querySelector('.dash-panel').focus({ preventScroll: true });
    }
    function closePanel() {
        $('dash-panel-root').replaceChildren(); openItem = null;
        document.documentElement.classList.remove('dash-panel-open');
        if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
    }
    const loading = (kicker, title) => showPanel(panelShell(kicker, title) + '<div class="dash-panel-body"><p class="home-muted">Loading…</p></div>');
    const section = (label, html) => html ? '<section class="dash-block"><h3>' + esc(label) + '</h3>' + html + '</section>' : '';
    const panelError = (message) => { const el = document.querySelector('.dash-panel-error'); if (el) { el.textContent = message; el.hidden = false; } };
    const footer = (html) => '<p class="dash-panel-error" role="alert" hidden></p><footer class="dash-panel-foot">' + html + '</footer>';

    function patchHtml(file) {
        const lines = file.patch.split('\n').map((line) => {
            const cls = line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : '';
            return '<span class="' + cls + '">' + esc(line || ' ') + '</span>';
        }).join('');
        return '<details class="dash-file"><summary><i class="far fa-file-code" aria-hidden="true"></i><span>' + esc(file.file) + '</span><small><b class="add">+' + file.additions + '</b> <b class="del">−' + file.deletions + '</b></small></summary><pre>' + lines +
            (file.truncated ? '<span class="hunk">… more lines in the full diff</span>' : '') + '</pre></details>';
    }
    /** The ticket diff endpoint returns one unified diff; split it into the per-file shape the panel draws. */
    function fromUnifiedDiff(data) {
        if (data.error) return { files: [], unavailable: data.error };
        const stats = new Map((data.files || []).map((f) => [f.path, f]));
        const all = String(data.diff || '').split(/^diff --git /m).slice(1).map((chunk) => {
            const lines = chunk.split('\n'), name = (/ b\/(.+)$/.exec(lines[0]) || [])[1] || lines[0];
            const start = lines.findIndex((l) => l.startsWith('@@')), body = start < 0 ? [] : lines.slice(start), stat = stats.get(name);
            return { file: name, additions: stat ? stat.added : body.filter((l) => l[0] === '+').length, deletions: stat ? stat.removed : body.filter((l) => l[0] === '-').length,
                patch: body.slice(0, MAX_PATCH_LINES).join('\n'), truncated: body.length > MAX_PATCH_LINES };
        });
        return { files: all.slice(0, MAX_FILES), hidden: Math.max(0, all.length - MAX_FILES) };
    }
    async function loadChanges(path, fullDiff) {
        const el = $('dash-changes'); if (!el) return;
        let data;
        try { data = await api(path); if (fullDiff) data = fromUnifiedDiff(data); } catch (_) { data = { files: [], unavailable: 'The changed lines could not be loaded.' }; }
        if (!$('dash-changes')) return;
        const more = fullDiff ? ' <a class="home-quiet-link" href="' + fullDiff + '">Open the full diff →</a>' : '';
        el.innerHTML = data.files.length ? data.files.map(patchHtml).join('') + (data.hidden ? '<p class="home-muted">' + plural(data.hidden, 'file') + ' not shown here.' + more + '</p>' : '')
            : '<p class="home-muted">' + esc(data.unavailable || 'No changed lines to show.') + more + '</p>';
        const first = el.querySelector('details'); if (first) first.open = true;
    }

    async function openEpic(epicId) {
        loading('Epic', 'Loading…');
        let data;
        try { data = await api('/api/epics/' + encodeURIComponent(epicId)); } catch (error) { return showPanel(panelShell('Epic', 'This epic could not be loaded') + '<div class="dash-panel-body"><p class="home-muted">' + esc(error.message) + '</p></div>'); }
        const e = data.epic, tickets = data.tickets || [], states = tickets.map(ticketState);
        const ready = states.filter((s) => s === 'ready').length, failed = tickets.filter((t) => ticketState(t) === 'failed');
        const reviewable = !['approved', 'merged', 'rejected'].includes(e.status) && (e.status === 'in_review' || (tickets.length > 0 && ready === tickets.length));
        const preview = safeUrl(e.previewUrl);
        const counts = ['ready', 'building', 'queued', 'failed', 'open'].map((s) => [s, states.filter((x) => x === s).length]).filter((x) => x[1]).map((x) => x[1] + ' ' + STATE_LABEL[x[0]].toLowerCase()).join(' · ');
        const kicker = (reviewable ? 'Review' : e.status === 'approved' ? 'Ready to merge' : 'Epic status') + (e.epicKey ? ' · ' + e.epicKey : '');
        const body =
            section('What this delivers', e.goal ? '<p class="dash-note">' + esc(e.goal) + '</p>' : '') +
            section('Progress', bar(states) + '<p class="home-muted">' + esc(counts || 'No tickets yet') + '</p>') +
            (data.mergeBlockers && data.mergeBlockers.length && e.status === 'approved' ? section('Before this can merge', '<ul class="dash-list warn">' + data.mergeBlockers.map((b) => '<li>' + esc(b.message || b) + '</li>').join('') + '</ul>') : '') +
            (preview ? section('Try it', '<a class="dash-btn wide" href="' + esc(preview) + '" target="_blank" rel="noopener noreferrer">Open live preview <i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i></a>') : '') +
            section('Tickets', tickets.length ? '<div class="dash-box">' + tickets.map((t) => { const s = ticketState(t);
                return '<div class="dash-box-row"><a class="dash-box-main" href="' + ticketUrl(t.id) + '">' + esc(t.name) + (t.ticketKey ? ' <span class="dash-key">' + esc(t.ticketKey) + '</span>' : '') + '</a>' + tag(STATE_LABEL[s], STATE_TONE[s]) +
                    (t.githubBranch ? '<a class="home-quiet-link" href="' + diffUrl(t.id) + '">Code</a>' : '') + '</div>'; }).join('') + '</div>' : '<p class="home-muted">The agent has not created tickets for this epic yet.</p>') +
            (data.docs && data.docs.length ? section('Docs', '<div class="dash-box">' + data.docs.map((d) => '<div class="dash-box-row"><a class="dash-box-main" href="/projects/' + pid() + '?tab=documents&doc=' + encodeURIComponent(d.id) + '&docName=' + encodeURIComponent(d.name) + '"><i class="far fa-file-lines" aria-hidden="true"></i> ' + esc(d.name) + '</a></div>').join('') + '</div>') : '') +
            (e.branch ? section('Changed lines', '<div id="dash-changes"><p class="home-muted">Loading changes…</p></div>') : '') +
            '<section class="dash-block" id="dash-change-request" hidden><h3>What should change?</h3><textarea id="dash-change-text" rows="4" placeholder="Describe what to change. It opens as a new chat with the agent."></textarea></section>';
        let actions = '<a class="home-quiet-link dash-foot-link" href="' + epicUrl(e.id) + '">Open full epic →</a>';
        if (reviewable) actions = '<button type="button" class="dash-btn primary" data-act="approve">Approve</button><button type="button" class="dash-btn" data-act="changes">Ask for changes</button>' + actions;
        else if (e.status === 'approved') actions = '<button type="button" class="dash-btn primary" data-act="merge">Merge to main</button>' + actions;
        else if (failed.length) actions = '<button type="button" class="dash-btn primary" data-open="failed:' + esc(failed[0].id) + '">View the issue</button>' + actions;
        openItem = { kind: 'epic', epic: e };
        showPanel(panelShell(kicker, e.name, plural(tickets.length, 'ticket') + (e.branch ? ' · ' + e.branch : '')) + '<div class="dash-panel-body">' + body + '</div>' + footer(actions));
        if (e.branch) loadChanges('/api/projects/' + pid() + '/epics/' + encodeURIComponent(e.id) + '/changes', null);
    }

    async function openTicketReview(item) {
        loading('Code review', item.title);
        let data;
        try { data = await api('/api/projects/' + pid() + '/tickets/' + encodeURIComponent(item.targetId)); } catch (error) { return showPanel(panelShell('Code review', item.title) + '<div class="dash-panel-body"><p class="home-muted">' + esc(error.message) + '</p></div>'); }
        const t = data.ticket, note = (data.logs || []).find((l) => l.logType === 'ai_response' && l.command);
        const criteria = Array.isArray(t.acceptanceCriteria) ? t.acceptanceCriteria.map((c) => typeof c === 'string' ? c : c && (c.text || c.description || c.criterion)).filter(Boolean) : [];
        const pr = safeUrl(t.githubPrUrl);
        const body = section('What was asked', '<p class="dash-note plain">' + esc((t.description || '').slice(0, 600)) + '</p>') +
            (note ? section('What the agent reported', '<p class="dash-note">' + esc(note.command.slice(0, 700)) + '</p>') : '') +
            (criteria.length ? section('Acceptance criteria', '<ul class="dash-list">' + criteria.slice(0, 8).map((c) => '<li>' + esc(c) + '</li>').join('') + '</ul>') : '') +
            section('Changed lines', '<div id="dash-changes"><p class="home-muted">Loading changes…</p></div>') +
            '<section class="dash-block" id="dash-change-request" hidden><h3>What should change?</h3><textarea id="dash-change-text" rows="4" placeholder="Tell the agent what to change on this ticket."></textarea></section>';
        openItem = { kind: 'ticket', item };
        showPanel(panelShell('Code review' + (t.ticketKey ? ' · ' + t.ticketKey : ''), t.name, t.githubBranch ? 'Branch ' + t.githubBranch : '') + '<div class="dash-panel-body">' + body + '</div>' +
            footer('<a class="dash-btn primary" href="' + diffUrl(t.id) + '">Open full diff</a><button type="button" class="dash-btn" data-act="ticket-changes">Ask for changes</button>' +
                (pr ? '<a class="dash-btn" href="' + esc(pr) + '" target="_blank" rel="noopener noreferrer">Pull request</a>' : '') + '<a class="home-quiet-link dash-foot-link" href="' + ticketUrl(t.id) + '">Open ticket →</a>'));
        loadChanges('/api/projects/' + pid() + '/tickets/' + encodeURIComponent(t.id) + '/git/diff', diffUrl(t.id));
    }

    function openQuestion(item) {
        const options = (item.options || []).map((o) => '<button type="button" class="dash-option" data-option>' + esc(o) + '</button>').join('');
        openItem = { kind: 'question', item };
        showPanel(panelShell('Question from the agent', item.title, 'Asked ' + rel(item.at)) + '<div class="dash-panel-body">' +
            section('The question', '<p class="dash-note">' + esc(item.body || item.detail) + '</p>') +
            (options ? section('Pick an answer', '<div class="dash-options">' + options + '</div>') : '') +
            section(options ? 'Or answer in your own words' : 'Your answer', '<textarea id="dash-answer" rows="4" placeholder="Type your answer…"></textarea>') + '</div>' +
            footer('<button type="button" class="dash-btn primary" data-act="answer">Send answer</button><a class="home-quiet-link dash-foot-link" href="' + ticketUrl(item.targetId) + '">Open ticket →</a>'));
    }

    function openMention(item) {
        const link = item.link && safeUrl(item.link);
        openItem = { kind: 'mention', item };
        showPanel(panelShell(item.detail, 'From your team', rel(item.at)) + '<div class="dash-panel-body">' + section('Message', '<p class="dash-note plain">' + esc(item.title) + '</p>') + '</div>' +
            footer((link ? '<a class="dash-btn primary" href="' + esc(link) + '" data-act="mention-open">Open and reply</a>' : '') + '<button type="button" class="dash-btn" data-act="mention-read">Mark as read</button>'));
    }

    async function openFailed(item) {
        loading('Problem', item.title);
        let logs = [];
        try { logs = await api('/api/projects/' + pid() + '/tickets/' + encodeURIComponent(item.targetId) + '/logs?limit=12'); } catch (_) {}
        const lines = logs.map((l) => (l.message || '').split('\n')[0].slice(0, 200)).filter(Boolean).slice(-10);
        const waiting = item.waiting || [];
        openItem = { kind: 'failed', item };
        showPanel(panelShell('Problem', item.title, 'Stopped ' + rel(item.at)) + '<div class="dash-panel-body">' +
            section('What happened', item.detail ? '<p class="dash-note">' + esc(item.detail) + '</p>' : '') +
            (lines.length ? section('Last lines of the run', '<pre class="dash-log">' + lines.map((l) => '<span>' + esc(l) + '</span>').join('') + '</pre>') : '') +
            (waiting.length ? section('Fixing this also unblocks', '<div class="dash-box">' + waiting.map((w) => '<div class="dash-box-row"><a class="dash-box-main" href="' + ticketUrl(w.id) + '">' + esc(w.name) + (w.key ? ' <span class="dash-key">' + esc(w.key) + '</span>' : '') + '</a>' + tag('Waiting', 'warn') + '</div>').join('') + '</div>') : '') +
            section('Note for the retry (optional)', '<textarea id="dash-retry-note" rows="3" placeholder="Anything the agent should do differently this time"></textarea>') + '</div>' +
            footer('<button type="button" class="dash-btn primary" data-act="retry">Retry build</button><a class="dash-btn" href="' + ticketUrl(item.targetId) + '">Open ticket</a>'));
    }

    function open(id) {
        const item = dash && dash.queue.find((i) => i.id === id);
        if (id.startsWith('failed:') && !item) return openFailed({ id, kind: 'failed', targetId: id.slice(7), title: 'Ticket needs attention', detail: '', at: null });
        if (!item) return;
        if (item.kind === 'epic_review' || item.kind === 'epic_merge') return openEpic(item.targetId);
        if (item.kind === 'ticket_review') return openTicketReview(item);
        if (item.kind === 'question') return openQuestion(item);
        if (item.kind === 'mention') return openMention(item);
        if (item.kind === 'failed') return openFailed(item);
    }

    function done(message, removeId) {
        if (removeId && dash) { dash.queue = dash.queue.filter((i) => i.id !== removeId); dash.stats.needsYou = dash.queue.length; renderStatus(); renderQueue(); }
        if (window.__refreshHome) window.__refreshHome();
        const next = dash && dash.queue[0];
        openItem = null;
        showPanel(panelShell('Done', 'Decision recorded') + '<div class="dash-panel-body"><div class="dash-done"><span class="dash-ico ok big"><i class="fas fa-check" aria-hidden="true"></i></span><p>' + esc(message) + '</p></div>' +
            (next ? section('Next up · ' + dash.queue.length + ' left', '<div class="dash-box"><button type="button" class="dash-row" data-open="' + esc(next.id) + '"><span class="dash-ico ' + KIND_TONE[next.kind] + '"><i class="fas ' + KIND_ICON[next.kind] + '" aria-hidden="true"></i></span><span class="dash-row-body"><span class="dash-row-title">' + esc(next.title) + '</span><span class="dash-row-detail">' + esc(next.detail) + '</span></span><span class="dash-action primary">' + esc(next.action) + '</span></button></div>') : '<p class="home-muted" style="text-align:center">Nothing else needs you right now.</p>') +
            '</div>' + footer('<button type="button" class="dash-btn" data-close>Back to dashboard</button>'));
    }

    function startChat(text) {
        const key = 'home-chat-draft:' + host().dataset.project;
        try { if (text) sessionStorage.setItem(key, text); else sessionStorage.removeItem(key); } catch (_) {}
        location.href = '/chat/project/' + pid() + '?new=1';
    }

    // ── Attachments ──────────────────────────────────────────────────────
    // Files picked here travel to the new chat through IndexedDB (it stores File
    // objects as they are); the chat page attaches and uploads them on arrival.
    const MAX_ATTACHMENTS = 4;
    let picked = [];
    function handoffFiles(files) {
        return new Promise((resolve) => {
            let open;
            try { open = indexedDB.open('lfg-home-handoff', 1); } catch (_) { return resolve(false); }
            open.onupgradeneeded = () => open.result.createObjectStore('files');
            open.onerror = () => resolve(false);
            open.onsuccess = () => {
                const tx = open.result.transaction('files', 'readwrite');
                tx.objectStore('files').put(files, host().dataset.project);
                tx.oncomplete = () => { open.result.close(); resolve(true); };
                tx.onerror = tx.onabort = () => resolve(false);
            };
        });
    }
    function renderFiles(note) {
        $('dash-files').innerHTML = picked.map((f, i) => '<span class="dash-file-chip"><i class="far fa-file" aria-hidden="true"></i><span>' + esc(f.name) + '</span><button type="button" data-unattach="' + i + '" aria-label="Remove ' + esc(f.name) + '"><i class="fas fa-xmark" aria-hidden="true"></i></button></span>').join('') +
            (note ? '<span class="dash-files-note" role="alert">' + esc(note) + '</span>' : '');
    }
    document.addEventListener('change', (event) => {
        if (event.target.id !== 'dash-file-input') return;
        const chosen = Array.from(event.target.files || []), room = MAX_ATTACHMENTS - picked.length;
        picked = picked.concat(chosen.slice(0, room));
        event.target.value = '';
        renderFiles(chosen.length > room ? 'You can attach up to ' + MAX_ATTACHMENTS + ' files.' : '');
        $('dash-compose-input').focus();
    });

    async function act(name, button) {
        const state = openItem, project = '/api/projects/' + pid();
        const busy = (on) => { if (button) { button.disabled = on; button.classList.toggle('busy', on); } };
        const reveal = () => { const box = $('dash-change-request'); if (box.hidden) { box.hidden = false; $('dash-change-text').focus(); button.textContent = 'Send to the agent'; return true; } return false; };
        try {
            if (name === 'approve') {
                busy(true); await api('/api/epics/' + encodeURIComponent(state.epic.id) + '/approve', { body: {} });
                done(state.epic.name + ' is approved. It can now be merged to main.', 'epic:' + state.epic.id);
            } else if (name === 'merge') {
                if (button.dataset.confirm !== '1') { button.dataset.confirm = '1'; button.textContent = 'Confirm merge to main'; return; }
                busy(true); const result = await api('/api/epics/' + encodeURIComponent(state.epic.id) + '/merge', { body: {} });
                if (result.merged === false) throw new Error((result.blockers && result.blockers[0] && result.blockers[0].message) || 'This epic cannot be merged yet.');
                done(state.epic.name + ' is merged to main.', 'epic:' + state.epic.id);
            } else if (name === 'changes') {
                if (reveal()) return;
                const text = $('dash-change-text').value.trim(); if (!text) return panelError('Describe what should change first.');
                startChat('Changes for epic ' + (state.epic.epicKey ? state.epic.epicKey + ' ' : '') + state.epic.name + ':\n' + text);
            } else if (name === 'ticket-changes') {
                if (reveal()) return;
                const text = $('dash-change-text').value.trim(); if (!text) return panelError('Describe what should change first.');
                busy(true); await api(project + '/tickets/' + encodeURIComponent(state.item.targetId) + '/chat', { body: { message: text } });
                done('Sent to the agent. The ticket comes back for review when the change is built.', state.item.id);
            } else if (name === 'answer') {
                const text = $('dash-answer').value.trim(); if (!text) return panelError('Pick an answer or type one first.');
                busy(true); await api(project + '/tickets/' + encodeURIComponent(state.item.targetId) + '/chat', { body: { message: text } });
                done('Answer sent. The agent is carrying on.', state.item.id);
            } else if (name === 'retry') {
                busy(true); await api(project + '/tickets/' + encodeURIComponent(state.item.targetId) + '/queue', { body: { notes: $('dash-retry-note').value.trim() || undefined } });
                done('The build is queued again. Tickets waiting behind it start when it passes.', state.item.id);
            } else if (name === 'mention-read' || name === 'mention-open') {
                const request = api(project + '/notifications/read', { body: { id: state.item.targetId } });
                if (name === 'mention-open') return; // the link navigates; the read mark is best-effort
                busy(true); await request; done('Marked as read.', state.item.id);
            }
        } catch (error) { busy(false); panelError(error.message); }
    }

    document.addEventListener('click', (event) => {
        if (!host()) return;
        const target = event.target.closest('[data-filter],[data-open],[data-epic],[data-close],[data-act],[data-option],[data-fill],[data-attach],[data-unattach]');
        if (!target) return;
        if (target.dataset.filter) { filter = target.dataset.filter; renderQueue(); }
        else if (target.dataset.open) open(target.dataset.open);
        else if (target.dataset.epic) openEpic(target.dataset.epic);
        else if ('close' in target.dataset) closePanel();
        else if (target.dataset.act) act(target.dataset.act, target);
        else if ('option' in target.dataset) { target.parentNode.querySelectorAll('.dash-option').forEach((o) => o.classList.toggle('on', o === target)); $('dash-answer').value = target.textContent; }
        else if ('attach' in target.dataset) $('dash-file-input').click();
        else if (target.dataset.unattach) { picked.splice(Number(target.dataset.unattach), 1); renderFiles(''); }
        else if (target.dataset.fill) { const input = $('dash-compose-input'); input.value = target.dataset.fill; input.focus(); }
    });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && $('dash-panel-root') && $('dash-panel-root').firstChild) closePanel(); });
    document.addEventListener('submit', (event) => {
        if (event.target.id !== 'dash-compose') return;
        event.preventDefault();
        const text = $('dash-compose-input').value.trim();
        if (!text && !picked.length) return $('dash-compose-input').focus();
        if (!picked.length) return startChat(text);
        handoffFiles(picked).then((stored) => { if (stored) startChat(text); else renderFiles('These files could not be carried over. Attach them in the chat instead.'); });
    });
})();
