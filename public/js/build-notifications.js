(() => {
    function init() {
        const nav = document.querySelector('#sidebar .sidebar-nav');
        if (!nav || document.getElementById('build-inbox')) return;
        const css = document.createElement('link');
        css.rel = 'stylesheet'; css.href = '/public/css/build-notifications.css?v=4';
        if (!document.querySelector('link[href*="build-notifications.css"]')) document.head.appendChild(css);
        const button = document.getElementById('build-inbox-button') || document.createElement('button');
        button.id = 'build-inbox-button'; button.className = 'nav-link'; button.type = 'button';
        button.removeAttribute('title'); button.setAttribute('aria-label', 'Notifications'); button.setAttribute('aria-expanded', 'false');
        button.setAttribute('aria-controls', 'build-inbox');
        if (!button.childElementCount) button.innerHTML = '<i class="fas fa-bell" aria-hidden="true"></i><span class="nav-text">Notifications</span><span class="build-unread" hidden></span>';
        if (!button.isConnected) nav.prepend(button);
        const panel = document.createElement('section');
        panel.id = 'build-inbox'; panel.hidden = true; panel.setAttribute('aria-label', 'Notifications');
        panel.innerHTML = '<header><strong>Notifications</strong><button type="button" class="build-read-all">Mark all read</button><button type="button" class="build-close" aria-label="Close notifications">×</button></header><div class="build-inbox-list"></div><footer><button type="button" class="build-desktop">Enable desktop notifications</button><span class="build-inbox-status" role="status"></span></footer>';
        document.body.appendChild(panel);
        const live = document.createElement('div');
        live.className = 'build-toast'; live.setAttribute('role', 'status'); live.hidden = true;
        document.body.appendChild(live);
        const badge = button.querySelector('.build-unread');
        const list = panel.querySelector('.build-inbox-list');
        const status = panel.querySelector('.build-inbox-status');
        const desktop = panel.querySelector('.build-desktop');
        const seen = new Set();
        let initialized = false, loading = false, refreshPending = false, toastTimer;
        function setOpen(open) {
            panel.hidden = !open; button.setAttribute('aria-expanded', String(open));
            if (open) {
                positionPanel(); refresh(); panel.querySelector('.build-close').focus();
            }
        }
        function positionPanel() {
            const rail = document.getElementById('sidebar')?.getBoundingClientRect();
            const trigger = button.getBoundingClientRect();
            panel.style.left = window.innerWidth <= 600 ? '12px' : Math.max(12, Math.min((rail?.right || 0) + 12, window.innerWidth - 414)) + 'px';
            panel.style.top = Math.max(16, Math.min(trigger.top, window.innerHeight - 520)) + 'px';
        }
        window.addEventListener('resize', () => { if (!panel.hidden) positionPanel(); });
        button.onclick = () => setOpen(panel.hidden);
        panel.querySelector('.build-close').onclick = () => { setOpen(false); button.focus(); };
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden) { setOpen(false); button.focus(); } });
        document.addEventListener('click', e => { if (!panel.hidden && !panel.contains(e.target) && !button.contains(e.target)) setOpen(false); });
        function safeLink(n) {
            return typeof n.link === 'string' && n.link.startsWith('/projects/') ? n.link : '/projects';
        }
        async function markRead(id) {
            const response = await fetch('/api/projects/build-notifications/read', {
                method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(id ? { id } : {})
            });
            if (!response.ok) throw new Error('Could not mark notifications read.');
        }
        function linkFor(n) {
            const link = document.createElement('a'); link.href = safeLink(n); link.textContent = n.message;
            link.onclick = () => { void markRead(n.id).catch(() => {}); };
            return link;
        }
        function announce(n) {
            live.replaceChildren(linkFor(n)); live.hidden = false;
            clearTimeout(toastTimer); toastTimer = setTimeout(() => { live.hidden = true; }, 10000);
            if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
                try {
                    const notice = new Notification(n.type === 'build_complete' ? 'Build ready for review' : 'Build update', { body: n.message, tag: n.id });
                    notice.onclick = () => { window.focus(); window.location.assign(safeLink(n)); notice.close(); };
                } catch (_) { /* Some browsers require a service worker; the inbox still works. */ }
            }
        }
        async function refresh() {
            if (loading) { refreshPending = true; return; }
            loading = true;
            try {
                const response = await fetch('/api/projects/build-notifications', { cache: 'no-store' });
                if (!response.ok) throw new Error('Notifications unavailable. Retrying…');
                const data = await response.json();
                list.replaceChildren();
                for (const n of data.notifications) {
                    if (initialized && !seen.has(n.id) && !n.readAt) announce(n);
                    seen.add(n.id);
                    const row = document.createElement('article'); row.className = n.readAt ? '' : 'unread'; row.dataset.state = n.type;
                    const label = document.createElement('strong');
                    label.textContent = ({build_complete:'Ready for review',build_failed:'Build failed',build_queued:'Queued',build_started:'Building',build_stopped:'Stopped',build_attention:'Needs your input',build_update:'Build update'})[n.type] || 'Build update';
                    const time = document.createElement('time'); time.textContent = new Date(n.createdAt).toLocaleString();
                    row.append(label, linkFor(n), time);
                    if (!n.readAt) {
                        const read = document.createElement('button'); read.type = 'button'; read.textContent = 'Mark read';
                        read.onclick = async () => { try { await markRead(n.id); await refresh(); } catch (e) { status.textContent = e.message; } };
                        row.appendChild(read);
                    }
                    list.appendChild(row);
                }
                if (!data.notifications.length) list.innerHTML = '<div class="build-inbox-empty"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" stroke-linecap="round" stroke-linejoin="round"/></svg><h3>You’re all caught up</h3><p>Build results will appear here.<br>We’ll keep you posted while you work.</p></div>';
                badge.hidden = !data.unread; badge.textContent = data.unread > 99 ? '99+' : data.unread;
                button.setAttribute('aria-label', `Notifications, ${data.unread} unread`);
                status.textContent = ''; initialized = true;
            } catch (e) { status.textContent = e.message; }
            finally { loading = false; if (refreshPending) { refreshPending = false; void refresh(); } }
        }
        panel.querySelector('.build-read-all').onclick = async () => {
            try { await markRead(); await refresh(); } catch (e) { status.textContent = e.message; }
        };
        function desktopLabel() {
            desktop.hidden = !('Notification' in window);
            if (!desktop.hidden) {
                desktop.disabled = Notification.permission !== 'default';
                desktop.textContent = Notification.permission === 'granted' ? 'Desktop notifications enabled' : Notification.permission === 'denied' ? 'Desktop notifications blocked in browser settings' : 'Enable desktop notifications';
            }
        }
        desktop.onclick = async () => { try { await Notification.requestPermission(); desktopLabel(); } catch (_) { status.textContent = 'Desktop notifications unavailable.'; } };
        desktopLabel();
        window.addEventListener('focus', refresh);
        window.addEventListener('online', refresh);
        // A user-scoped socket has no conversation, so it never loads chat history.
        let socket, reconnectTimer, stopped = false, retry = 1000, lastMessage = Date.now();
        function connect() {
            if (stopped || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
            clearTimeout(reconnectTimer);
            socket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/chat');
            socket.onopen = () => { retry = 1000; lastMessage = Date.now(); refresh(); };
            socket.onmessage = event => {
                lastMessage = Date.now();
                try { const data = JSON.parse(event.data); if (data.type === 'notification') refresh(); } catch (_) {}
            };
            socket.onerror = () => socket.close();
            socket.onclose = () => {
                if (!stopped) { reconnectTimer = setTimeout(connect, retry + Math.random() * 500); retry = Math.min(retry * 2, 30000); }
            };
        }
        const heartbeat = setInterval(() => {
            if (socket?.readyState === WebSocket.OPEN && Date.now() - lastMessage > 90000) socket.close();
        }, 30000);
        window.addEventListener('pagehide', () => { stopped = true; clearTimeout(reconnectTimer); socket?.close(); });
        window.addEventListener('pageshow', event => { if (event.persisted) { stopped = false; connect(); } });
        window.addEventListener('online', connect);
        connect();
        refresh();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
