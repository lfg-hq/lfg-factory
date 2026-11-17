/* Project Chats list: search, pin and delete, plus friendlier dates. */
(() => {
    const page = () => document.querySelector('.chats-page');
    function when(date) {
        const days = Math.floor((Date.now() - date.getTime()) / 86400000);
        if (days < 1) return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        if (days < 7) return date.toLocaleDateString([], { weekday: 'short' });
        return date.toLocaleDateString([], date.getFullYear() === new Date().getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
    }
    function fail(message) { const el = document.getElementById('chats-error'); if (el) { el.textContent = message; el.hidden = false; } }
    function filter(query) {
        const q = query.trim().toLowerCase(); let shown = 0;
        page().querySelectorAll('[data-chat-group]').forEach((group) => {
            let any = false;
            group.querySelectorAll('.chat-card').forEach((row) => { const match = !q || row.dataset.title.includes(q) || row.textContent.toLowerCase().includes(q); row.hidden = !match; if (match) { any = true; shown++; } });
            group.hidden = !any;
        });
        document.getElementById('chats-empty').hidden = shown > 0;
    }
    function resetDelete(button) { button.classList.remove('danger'); button.innerHTML = '<i class="far fa-trash-can" aria-hidden="true"></i>'; button.parentNode.classList.remove('confirming'); delete button.dataset.armed; }

    document.addEventListener('DOMContentLoaded', () => {
        if (!page()) return;
        page().querySelectorAll('time[data-relative]').forEach((el) => {
            const days = Math.floor((Date.now() - new Date(el.dateTime).getTime()) / 86400000);
            el.textContent = days < 1 ? 'today' : days < 2 ? 'yesterday' : days < 30 ? days + ' days ago' : new Date(el.dateTime).toLocaleDateString([], { month: 'short', day: 'numeric' });
        });
        page().querySelectorAll('time[datetime]:not([data-relative])').forEach((el) => { const date = new Date(el.dateTime); if (!isNaN(date)) { el.textContent = when(date); el.title = date.toLocaleString(); } });
    });
    document.addEventListener('input', (event) => { if (event.target.id === 'chats-search') filter(event.target.value); });
    document.addEventListener('click', async (event) => {
        if (!page()) return;
        const armed = page().querySelector('[data-chat-delete][data-armed]');
        const button = event.target.closest('[data-chat-pin],[data-chat-delete]');
        if (armed && armed !== button) resetDelete(armed);
        if (!button) return;
        const row = button.closest('.chat-card'), id = encodeURIComponent(row.dataset.chat);
        try {
            if ('chatPin' in button.dataset) {
                button.disabled = true;
                const res = await fetch('/api/conversations/' + id + '/pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: button.dataset.chatPin === '1' }) });
                if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'That chat could not be pinned.');
                location.reload();
            } else if (!button.dataset.armed) {
                // Deleting is permanent, so the first click only arms the button.
                button.dataset.armed = '1'; button.classList.add('danger'); button.textContent = 'Delete chat?'; button.parentNode.classList.add('confirming');
            } else {
                button.disabled = true;
                const res = await fetch('/api/conversations/' + id, { method: 'DELETE' });
                if (!res.ok) throw new Error('That chat could not be deleted.');
                row.remove();
                if (!page().querySelector('.chat-card')) location.reload();
            }
        } catch (error) { button.disabled = false; fail(error.message); }
    });
})();
