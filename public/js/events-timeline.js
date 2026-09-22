/** Project activity: latest 50 events, grouped by local date and kept current. */
(function () {
  const container = document.getElementById('events-timeline-container');
  const host = document.getElementById('events-tab-container');
  if (!container || !host?.dataset.projectId) return;
  const projectId = host.dataset.projectId;
  const sync = document.getElementById('activity-sync');
  const refresh = document.getElementById('activity-refresh');
  let activities = [], filter = 'all', loading = false, signature = null;
  const config = {
    ticket_queued: ['Queued', 'clock', 'builds', 'neutral'],
    ticket_started: ['Build started', 'play', 'builds', 'purple'],
    ticket_completed: ['Build completed', 'check', 'builds', 'success'],
    ticket_failed: ['Build failed', 'exclamation', 'attention', 'error'],
    ticket_stuck: ['Needs input', 'question', 'attention', 'warning'],
    user_action_required: ['Action required', 'exclamation', 'attention', 'warning'],
    git_pushed: ['Changes pushed', 'code-branch', 'git', 'purple'],
    git_merged: ['Changes merged', 'code-merge', 'git', 'success'],
    orchestrator_queued_next: ['Auto-queued', 'forward', 'builds', 'neutral'],
  };
  function el(tag, cls, text) { const n = document.createElement(tag); n.className = cls; if (text) n.textContent = text; return n; }
  function date(value) { return new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value); }
  function info(a) { return config[a.activityType] || ['Project update', 'circle-info', 'other', 'neutral']; }
  function dayLabel(d) {
    const today = new Date(), yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric', year:'numeric' });
  }
  function render() {
    container.replaceChildren();
    const visible = activities.filter(a => filter === 'all' || info(a)[2] === filter || (filter === 'builds' && a.activityType.startsWith('ticket_')));
    if (!visible.length) {
      const empty = el('div', 'events-empty');
      empty.append(el('strong', '', activities.length ? 'No matching activity' : 'Your project history starts here'), el('p', '', activities.length ? 'Try another filter to see more updates.' : 'Builds and project changes will appear as they happen.'));
      container.append(empty); return;
    }
    let previousDay, group;
    for (const a of visible) {
      const d = date(a.createdAt), key = d.toDateString();
      if (key !== previousDay) {
        const section = el('section', 'activity-day');
        section.append(el('h3', 'activity-date', dayLabel(d)));
        group = el('div', 'activity-day-list'); section.append(group); container.append(section); previousDay = key;
      }
      const [label, icon, , tone] = info(a);
      const row = el('article', 'activity-row');
      const marker = el('span', 'activity-icon'); marker.dataset.tone = tone; marker.setAttribute('aria-hidden','true'); marker.append(el('i','fas fa-' + icon));
      const body = el('div', 'activity-body');
      const meta = el('div','activity-meta'); meta.append(el('span','activity-label',label));
      const time = el('time','', d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'}));
      time.dateTime = d.toISOString(); time.title = d.toLocaleString(); meta.append(time); body.append(meta);
      const title = el(a.ticketId ? 'a' : 'div','activity-title', (a.title || 'Project update').replace(/^(Build started|Ticket queued|Completed|Failed|Auto-queued):\s*/i, ''));
      if (a.ticketId) title.href = '/projects/' + encodeURIComponent(projectId) + '/tickets?ticket=' + encodeURIComponent(a.ticketId);
      body.append(title);
      if (a.description) body.append(el('p','activity-description',a.description));
      row.append(marker,body); group.append(row);
    }
    container.append(el('p','activity-footnote', `Showing ${visible.length} of the latest ${activities.length} events · Newest first`));
  }
  async function fetchActivities() {
    if (loading) return; loading = true; refresh.disabled = true;
    try {
      const response = await fetch('/projects/' + encodeURIComponent(projectId) + '/api/activities?limit=50', {cache:'no-store'});
      if (!response.ok) throw new Error('Request failed');
      const data = await response.json();
      if (!Array.isArray(data.activities)) throw new Error('Invalid response');
      const next = data.activities.filter(a => !Number.isNaN(date(a.createdAt).getTime())).sort((a,b) => date(b.createdAt) - date(a.createdAt));
      const nextSignature = JSON.stringify(next);
      activities = next;
      if (signature !== nextSignature) { signature = nextSignature; render(); }
      sync.textContent = 'Updated just now'; sync.dataset.state = 'live';
    } catch (_) {
      sync.textContent = 'Couldn’t refresh · Try again'; sync.dataset.state = 'error';
      if (signature === null) { container.replaceChildren(el('p','events-empty','Activity is unavailable. Use Refresh to try again.')); }
    } finally { loading = false; refresh.disabled = false; }
  }
  host.querySelectorAll('[data-activity-filter]').forEach(button => button.addEventListener('click', () => {
    filter = button.dataset.activityFilter;
    host.querySelectorAll('[data-activity-filter]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
    render();
  }));
  refresh.addEventListener('click', fetchActivities);
  window.addEventListener('focus', fetchActivities);
  const timer = setInterval(() => { if (!document.hidden) fetchActivities(); }, 10000);
  window.addEventListener('beforeunload', () => clearInterval(timer));
  fetchActivities();
})();
