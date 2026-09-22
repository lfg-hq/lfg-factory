(() => {
    function state(ticket) {
        if (['executing', 'running', 'queued'].includes(ticket.queueStatus)) return ticket.queueStatus === 'queued' ? 'queued' : 'building';
        if (ticket.status === 'in_progress') return 'building';
        if (ticket.status === 'review') return 'review';
        if (['failed', 'blocked'].includes(ticket.status)) return 'blocked';
        return ticket.status;
    }
    const labels = { review: 'Ready for review', blocked: 'Needs attention', building: 'Building', queued: 'Queued', done: 'Completed', open: 'Planned' };
    function element(tag, cls, text) { const el = document.createElement(tag); el.className = cls; if (text) el.textContent = text; return el; }
    let latestTickets = [];
    window.renderHomeWork = function(tickets) {
        latestTickets = tickets;
        const host = document.querySelector('.home-overview'); if (!host) return;
        const project = host.dataset.project;
        const storageKey = 'ignored-attention:' + host.dataset.user + ':' + project;
        let ignored = {};
        try { ignored = JSON.parse(localStorage.getItem(storageKey) || '{}') || {}; } catch (_) {}
        const version = t => t.status + ':' + (t.updatedAt || '');
        const allAttention = tickets.filter(t => ['review', 'blocked'].includes(state(t)));
        const attention = allAttention.filter(t => ignored[t.id] !== version(t));
        const hidden = allAttention.filter(t => ignored[t.id] === version(t));
        function ignore(t, restore = false) {
            if (restore) delete ignored[t.id]; else ignored[t.id] = version(t);
            try { localStorage.setItem(storageKey, JSON.stringify(ignored)); }
            catch (_) { window.alert('Could not save this preference. Please enable browser storage and try again.'); return; }
            window.renderHomeWork(latestTickets);
        }
        const active = tickets.filter(t => ['building', 'queued'].includes(state(t)));
        const stats = document.getElementById('home-work-stats'); stats.replaceChildren();
        [['review', 'Ready for review'], ['blocked', 'Needs attention'], ['building', 'Building'], ['queued', 'Queued']].forEach(([key, label]) => {
            const card = element('div', 'home-stat'); card.dataset.state = key;
            card.append(element('strong', '', String(tickets.filter(t => state(t) === key).length)), element('span', '', label)); stats.append(card);
        });
        document.getElementById('home-work-summary').textContent = attention.length ? `${attention.length} ticket${attention.length === 1 ? '' : 's'} waiting for your review or input.` : active.length ? 'Work is underway. We’ll notify you when a build finishes.' : 'Your project is up to date. Continue a conversation or start something new.';
        function row(t) {
            const s = state(t), link = element('a', 'home-work-row');
            link.href = `/projects/${encodeURIComponent(project)}/tickets?ticket=${encodeURIComponent(t.id)}`;
            const icon = element('span', 'home-work-icon', s === 'review' ? '✓' : s === 'blocked' ? '!' : '◷'); icon.dataset.state = s; icon.setAttribute('aria-hidden', 'true');
            const body = element('span', 'home-work-body');
            body.append(element('strong', '', (t.ticketKey ? t.ticketKey + ' · ' : '') + t.name));
            body.append(element('small', '', t.status === 'failed' && s === 'blocked' ? 'Build failed · Check the logs before retrying' : t.status === 'blocked' && s === 'blocked' ? 'Blocked · Open the ticket to resolve it' : labels[s]));
            link.append(icon, body, element('span', 'home-work-cta', s === 'review' ? 'Review changes →' : s === 'blocked' ? 'View issue →' : 'View progress →'));
            return link;
        }
        function attentionRow(t, restore = false) {
            const wrapper = element('div', 'home-attention-row');
            const action = element('button', 'home-attention-ignore', restore ? 'Restore' : 'Ignore');
            action.type = 'button'; action.setAttribute('aria-label', (restore ? 'Restore ' : 'Ignore ') + t.name);
            action.title = restore ? 'Show in your attention list again' : 'Hide on this browser until the ticket changes';
            action.onclick = () => ignore(t, restore);
            wrapper.append(row(t), action); return wrapper;
        }
        const list = document.getElementById('home-ticket-attention'); list.replaceChildren();
        attention.slice(0, 3).forEach(t => list.append(attentionRow(t)));
        if (!attention.length) {
            const empty = element('div', 'home-work-empty');
            empty.append(element('span', 'home-work-icon', '✓'), element('span', '', 'Nothing needs your attention right now.')); list.append(empty);
        }
        let dialog = document.getElementById('home-attention-dialog');
        if (!dialog) {
            dialog = element('dialog', 'home-attention-dialog'); dialog.id = 'home-attention-dialog';
            dialog.setAttribute('aria-labelledby', 'home-attention-dialog-title');
            document.body.append(dialog);
        }
        const focusedLabel = dialog.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') : null;
        const ignoredOpen = dialog.querySelector('details')?.open || false;
        const scrollTop = dialog.querySelector('.home-attention-expanded')?.scrollTop || 0;
        dialog.replaceChildren();
        const heading = element('header', 'home-attention-dialog-head');
        const title = element('h2', '', 'Needs your attention'); title.id = 'home-attention-dialog-title';
        const close = element('button', 'home-attention-close', '×'); close.type = 'button'; close.setAttribute('aria-label', 'Close attention list'); close.onclick = () => dialog.close();
        heading.append(title, close); dialog.append(heading);
        dialog.append(element('p', 'home-attention-explainer', 'Ignore hides an item on this browser until the ticket changes. It does not change ticket status.'));
        const expanded = element('div', 'home-attention-expanded');
        attention.forEach(t => expanded.append(attentionRow(t)));
        if (!attention.length) expanded.append(element('p', 'home-muted', 'You’re all caught up.'));
        if (hidden.length) {
            const details = element('details', 'home-attention-hidden');
            details.open = ignoredOpen;
            details.append(element('summary', '', `Ignored (${hidden.length})`));
            hidden.forEach(t => details.append(attentionRow(t, true))); expanded.append(details);
        }
        dialog.append(expanded); expanded.scrollTop = scrollTop;
        if (focusedLabel && dialog.open) {
            const match = Array.from(dialog.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === focusedLabel);
            (match || close).focus({ preventScroll: true });
        }
        const footer = element('div', 'home-attention-footer');
        footer.append(element('span', 'home-muted', attention.length ? `Showing ${Math.min(3, attention.length)} of ${attention.length}` : (hidden.length ? `${hidden.length} ignored` : '')));
        const more = element('button', 'home-quiet-link', 'Open full list' + (attention.length ? ` (${attention.length})` : '') + ' →');
        more.type = 'button'; more.onclick = () => dialog.showModal(); footer.append(more); list.append(footer);
        const builds = document.getElementById('home-builds'); builds.hidden = !active.length;
        const buildList = document.getElementById('home-builds-list'); buildList.replaceChildren(); active.slice(0, 4).forEach(t => buildList.append(row(t)));
        document.querySelectorAll('[data-home-conversation]').forEach(link => {
            const related = tickets.filter(t => t.conversationId === link.dataset.homeConversation);
            const relevant = related.find(t => ['blocked', 'building', 'queued', 'review'].includes(state(t))) || related[0];
            let badge = link.querySelector('.home-chat-state');
            if (!badge) { badge = element('span', 'home-chat-state'); link.append(badge); }
            badge.textContent = relevant ? (labels[state(relevant)] || 'Ticket updated') : 'Continue chat';
        });
    };
    document.addEventListener('DOMContentLoaded', () => {
        const form = document.getElementById('home-start-form'); if (!form) return;
        form.addEventListener('submit', e => {
            e.preventDefault();
            const draft = document.getElementById('home-start-input').value.trim(); if (!draft) return;
            try {
                sessionStorage.setItem('home-chat-draft:' + form.dataset.project, draft);
                location.assign('/chat/project/' + encodeURIComponent(form.dataset.project) + '?new=1');
            } catch (_) { document.getElementById('home-start-error').textContent = 'Could not save your draft. Please enable browser storage and try again.'; }
        });
    });
})();
