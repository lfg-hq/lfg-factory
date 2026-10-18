(() => {
    function state(ticket) {
        if (['executing', 'running', 'queued'].includes(ticket.queueStatus)) return ticket.queueStatus === 'queued' ? 'queued' : 'building';
        if (ticket.status === 'in_progress') return 'building';
        if (ticket.status === 'review') return 'review';
        if (['failed', 'blocked'].includes(ticket.status)) return 'blocked';
        return ticket.status;
    }
    function element(tag, cls, text) { const el = document.createElement(tag); el.className = cls; if (text) el.textContent = text; return el; }
    window.renderHomeWork = function(tickets, epics = []) {
        const host = document.querySelector('.home-dashboard'); if (!host) return;
        const project = encodeURIComponent(host.dataset.project);
        const list = document.getElementById('home-epics');
        const status = document.getElementById('home-refresh-status'); if (status) status.hidden = true;
        const focused = list.contains(document.activeElement) ? document.activeElement.getAttribute('href') : null;
        list.replaceChildren();
        if (!epics.length) {
            const empty = element('div', 'home-epics-empty');
            const icon=element('i','far fa-file-lines');icon.setAttribute('aria-hidden','true');
            empty.append(icon,element('strong','','No epics yet'),element('p','home-muted','Your planned features will appear here.'));
            list.append(empty);
            return;
        }
        epics.forEach(epic => {
            const related = tickets.filter(t => t.epicId === epic.id);
            const ready = related.filter(t => ['review', 'done'].includes(state(t))).length;
            const blocked = related.filter(t => state(t) === 'blocked');
            const building = related.filter(t => state(t) === 'building').length;
            const queued = related.filter(t => state(t) === 'queued').length;
            const allReady = related.length > 0 && ready === related.length;
            const epicUrl = '/projects/' + project + '/epics?epic=' + encodeURIComponent(epic.id);
            const row = element('article', 'home-epic-row');
            const body = element('div', 'home-epic-body');
            const heading = element('div', 'home-epic-heading');
            const title = element('a', '', epic.name); title.href = epicUrl;
            heading.append(title, element('span', 'home-epic-key', epic.epicKey || ''));
            const progress = element('div', 'home-epic-progress');
            const track = element('div', 'home-epic-track');
            track.setAttribute('role','progressbar'); track.setAttribute('aria-label',epic.name + ': tickets ready for review or completed');
            track.setAttribute('aria-valuemin','0'); track.setAttribute('aria-valuemax',String(related.length || 1)); track.setAttribute('aria-valuenow',String(ready));
            track.setAttribute('aria-valuetext',related.length ? ready + ' of ' + related.length + ' ready or complete' : 'No tickets yet');
            const fill = element('div','home-epic-fill'); fill.style.width = (related.length ? ready / related.length * 100 : 0) + '%'; track.append(fill);
            progress.append(track,element('span','home-epic-fraction',related.length ? ready + ' of ' + related.length + ' ready' : 'No tickets yet'));
            let message = 'Not built yet', tone = '';
            if (epic.status === 'rejected') message = 'Rejected';
            else if (blocked.length) {message = blocked.length === 1 ? (blocked[0].ticketKey || 'One ticket') + ' needs attention' : blocked.length + ' tickets need attention';tone = 'warning';}
            else if (building) message = building + ' ticket' + (building === 1 ? '' : 's') + ' building';
            else if (queued) message = queued + ' ticket' + (queued === 1 ? '' : 's') + ' queued';
            else if (epic.status === 'merged') {message = 'Merged to main';tone = 'success';}
            else if (epic.status === 'approved') {message = 'Approved · Awaiting merge';tone = 'success';}
            else if (allReady) {message = 'Ready for your review';tone = 'success';}
            else if (ready) message = 'Partially ready for review';
            const stateLine = element('div','home-epic-state ' + tone);
            const icon = element('i', 'fas ' + (tone === 'warning' ? 'fa-circle-exclamation' : tone === 'success' ? 'fa-check' : 'fa-circle-dot'));icon.setAttribute('aria-hidden','true');
            stateLine.append(icon,element('span','',message));
            body.append(heading,progress,stateLine);
            const actions = element('div','home-epic-actions');
            let preview = null;
            try { const url = new URL(epic.previewUrl); if (['https:', 'http:'].includes(url.protocol) && epic.status !== 'rejected') preview = url.href; } catch (_) {}
            if (preview) {
                const link = element('a','home-epic-preview', allReady ? 'Test preview ↗' : 'Test partial preview ↗');
                link.href = preview; link.target = '_blank'; link.rel = 'noopener noreferrer'; actions.append(link);
            } else actions.append(element('span','home-muted','Preview unavailable'));
            const action = element('a','home-quiet-link',blocked.length ? 'View issue →' : allReady && !['approved','merged','rejected'].includes(epic.status) ? 'Review changes →' : 'Open epic →');
            action.href = blocked.length ? '/projects/' + project + '/tickets?ticket=' + encodeURIComponent(blocked[0].id) : allReady && !['approved','merged','rejected'].includes(epic.status) ? '/projects/' + project + '/tickets?epic=' + encodeURIComponent(epic.id) : epicUrl;
            actions.append(action); row.append(body,actions); list.append(row);
        });
        if (focused) Array.from(list.querySelectorAll('a')).find(a => a.getAttribute('href') === focused)?.focus({preventScroll:true});
    };
})();
