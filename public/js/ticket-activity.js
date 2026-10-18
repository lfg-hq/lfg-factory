/** Conversation-scoped ticket activity inside chat; no fabricated completion percentage. */
(function () {
  const projectId = document.body.dataset.projectId;
  const root = document.getElementById('chat-ticket-activity');
  if (!root || !projectId) return;
  const seen = new Map();
  let loading = false;
  let revision = 0;
  let signature = '';
  function active(t) {
    return t.agentBusy === true || /^(queued|executing|building|running|stopping)$/.test(t.queueStatus || '') || /^(in_progress|building)$/.test(t.status || '');
  }
  function label(t) {
    if (t.queueStatus === 'stopping') return 'Stopping…';
    if (t.agentBusy) return 'Agent working…';
    if (t.queueStatus === 'queued') return 'Queued';
    if (active(t)) return 'Building…';
    if (/^(failed|blocked)$/.test(t.status || '')) return 'Needs attention — open ticket';
    if (t.status === 'stopped') return 'Stopped';
    return 'Work finished — open ticket for results';
  }
  function render() {
    const tickets = [...seen.values()];
    const next = JSON.stringify(tickets.map(t => [t.id, t.name, t.ticketKey, t.status, t.queueStatus, t.agentBusy]));
    if (signature === next) return;
    signature = next;
    root.replaceChildren();
    root.hidden = tickets.length === 0;
    for (const t of tickets) {
      const card = document.createElement('article');
      card.className = 'chat-ticket-activity-card';
      const title = document.createElement('strong');
      title.textContent = (t.ticketKey ? t.ticketKey + ' · ' : '') + t.name;
      const state = document.createElement('div');
      state.className = 'chat-ticket-activity-state';
      state.setAttribute('role', 'status');
      if (active(t)) {
        const spinner = document.createElement('span');
        spinner.className = 'ticket-activity-spinner';
        spinner.setAttribute('aria-hidden', 'true');
        state.append(spinner);
      }
      state.append(document.createTextNode(label(t)));
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'chat-ticket-activity-open';
      open.textContent = 'Open ticket';
      open.addEventListener('click', () => window.TicketAgentChat?.open(t.id, t.ticketKey, t.name, t));
      card.append(title, state, open);
      root.append(card);
    }
  }
  async function refresh() {
    if (loading || !window.currentConversationId) return;
    loading = true;
    const started = revision;
    const conversation = window.currentConversationId;
    try {
      const response = await fetch('/api/projects/' + encodeURIComponent(projectId) + '/tickets', {credentials:'same-origin'});
      if (!response.ok) return;
      const data = await response.json();
      if (started !== revision || conversation !== window.currentConversationId) return; // A newer live event wins over this snapshot.
      const ids = new Set();
      for (const t of data.tickets || []) {
        if (t.activityConversationId !== conversation) continue;
        ids.add(t.id);
        if (active(t) || seen.has(t.id)) seen.set(t.id, t);
      }
      for (const id of seen.keys()) if (!ids.has(id)) seen.delete(id);
      render();
    } catch (_) { /* Keep the last known state; retry on the next poll. */ }
    finally { loading = false; if (conversation !== window.currentConversationId) refresh(); }
  }
  window.addEventListener('ticket-activity', event => {
    const msg = event.detail || {};
    if (msg.type !== 'ticket_chat_state' && msg.type !== 'ticket_status') return;
    const ticket = seen.get(msg.ticketId);
    if (ticket && (msg.type === 'ticket_chat_state' || msg.type === 'ticket_status')) {
      revision++;
      if (msg.type === 'ticket_chat_state') ticket.agentBusy = !!msg.busy;
      else {
        if (msg.status !== undefined) ticket.status = msg.status;
        if (msg.queueStatus !== undefined) ticket.queueStatus = msg.queueStatus;
      }
      render();
    }
    // Unknown IDs are resolved through the project-scoped API, never inserted
    // from unscoped events belonging to a different project.
    if (!ticket || msg.type === 'ticket_status' || msg.type === 'ticket_chat_state') refresh();
  });
  window.addEventListener('chat-conversation-changed', () => {
    revision++; seen.clear(); signature = ''; root.replaceChildren(); root.hidden = true;
    refresh();
  });
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden) refresh(); }, 8000);
  refresh();
})();
