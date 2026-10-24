(() => {
  'use strict';
  // Documentation sync UI: the Settings → Integrations card, and the Sync control
  // in the Documents panel (chat side panel and project page).
  const el = (tag, attrs = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat()) if (c) n.append(c);
    return n;
  };
  const icon = (cls) => el('i', { class: cls, 'aria-hidden': 'true' });
  const ago = (ms) => {
    if (!ms) return '';
    const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return new Date(ms).toLocaleDateString();
  };
  async function api(url, options = {}) {
    const res = await fetch(url, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...options });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }
  async function connect(provider, button) {
    button.disabled = true;
    try {
      const toolkit = provider.key.toLowerCase();
      const data = await api('/api/composio/connectors/' + encodeURIComponent(toolkit) + '/connect', { method: 'POST' });
      if (data.redirectUrl) { location.href = data.redirectUrl; return; }
      location.reload();
    } catch (err) { button.disabled = false; alert(err.message || 'Could not start the connection.'); }
  }
  const brand = (p) => el('span', { class: 'doc-sync-icon', style: `color:${p.color};background:${p.color}1a` }, icon(p.icon));

  // ── Settings card ────────────────────────────────────────────────────
  function settingsRow(p, refresh) {
    const status = p.connected
      ? el('span', { class: 'doc-sync-pill is-on' }, icon('fas fa-check'), ' Connected')
      : el('span', { class: 'doc-sync-pill' }, 'Not connected');
    const head = el('div', { class: 'doc-sync-row-head' },
      brand(p),
      el('div', { class: 'doc-sync-identity' }, el('strong', { text: p.name }), el('span', { text: p.description })),
      status);
    const row = el('div', { class: 'doc-sync-row', 'data-provider': p.key }, head);
    if (!p.connected) {
      const btn = el('button', { type: 'button', class: 'doc-sync-btn doc-sync-primary', onclick: () => connect(p, btn) }, icon('fas fa-plug'), ' Connect ' + p.name);
      row.append(el('div', { class: 'doc-sync-controls' }, btn));
      return row;
    }
    const controls = el('div', { class: 'doc-sync-controls' });
    if (p.destinationLabel) {
      const id = 'doc-sync-dest-' + p.key;
      const input = el('input', { id, type: 'text', value: p.destination, placeholder: p.destinationPlaceholder, autocomplete: 'off', spellcheck: 'false' });
      const save = el('button', { type: 'button', class: 'doc-sync-btn' }, 'Save');
      const form = el('form', { class: 'doc-sync-dest', onsubmit: async (e) => {
        e.preventDefault();
        if (input.value.trim() === p.destination) return;
        if (p.destination && !confirm('Change the destination? Documents will be published as new copies in the new location.')) return;
        save.disabled = true;
        try { await api('/api/document-sync/providers/' + p.key, { method: 'PUT', body: JSON.stringify({ destination: input.value }) }); refresh(); }
        catch (err) { save.disabled = false; alert(err.message); }
      } }, el('label', { for: id, text: p.destinationLabel + (p.destinationRequired ? '' : ' (optional)') }), el('div', { class: 'doc-sync-dest-field' }, input, save));
      controls.append(form);
    }
    const toggleId = 'doc-sync-auto-' + p.key;
    const toggle = el('input', { id: toggleId, type: 'checkbox', role: 'switch', checked: p.autoSync, disabled: !p.ready });
    toggle.addEventListener('change', async () => {
      toggle.disabled = true;
      try { await api('/api/document-sync/providers/' + p.key, { method: 'PUT', body: JSON.stringify({ autoSync: toggle.checked }) }); refresh(); }
      catch (err) { toggle.checked = !toggle.checked; toggle.disabled = false; alert(err.message); }
    });
    controls.append(el('div', { class: 'doc-sync-auto' },
      el('label', { class: 'toggle-switch' }, toggle, el('span', { class: 'toggle-slider' })),
      el('label', { for: toggleId, class: 'doc-sync-auto-label' },
        el('strong', { text: 'Auto sync' }),
        el('span', { text: p.ready ? 'Push new and edited documents from your projects every few minutes.' : 'Choose a ' + p.destinationLabel.toLowerCase() + ' first.' }))));
    row.append(controls);
    const meta = [];
    if (p.lastSyncedAt) meta.push('Last synced ' + ago(p.lastSyncedAt));
    if (meta.length || p.lastError) row.append(el('div', { class: 'doc-sync-meta' + (p.lastError ? ' is-error' : '') }, p.lastError ? icon('fas fa-triangle-exclamation') : null, ' ' + (p.lastError ? p.lastError : meta.join(' · '))));
    return row;
  }
  async function mountSettings() {
    const list = document.getElementById('doc-sync-list');
    if (!list) return;
    const summary = document.getElementById('doc-sync-summary');
    const refresh = async (fresh) => {
      try {
        const { providers } = await api('/api/document-sync/providers' + (fresh ? '?fresh=1' : ''));
        list.replaceChildren(...providers.map((p) => settingsRow(p, () => refresh(false))));
        const connected = providers.filter((p) => p.connected).length;
        const auto = providers.filter((p) => p.autoSync).length;
        if (summary) summary.textContent = connected ? `${connected} connected${auto ? ' · ' + auto + ' auto' : ''}` : 'None connected';
      } catch (err) {
        list.replaceChildren(el('div', { class: 'doc-sync-loading is-error', text: err.message || 'Could not load documentation sources.' }));
      }
    };
    // Fresh connection state: the user may have just returned from an OAuth flow.
    refresh(true);
  }

  // ── Documents panel ──────────────────────────────────────────────────
  let currentProject = null;
  function openPanel(projectId) {
    document.getElementById('doc-sync-dialog')?.remove();
    const body = el('div', { class: 'doc-sync-panel-body', 'aria-live': 'polite' }, el('div', { class: 'doc-sync-loading', text: 'Loading sync status…' }));
    const close = el('button', { type: 'button', class: 'doc-sync-close', 'aria-label': 'Close', onclick: () => dialog.close() }, icon('fas fa-xmark'));
    const dialog = el('dialog', { id: 'doc-sync-dialog', class: 'doc-sync-dialog', 'aria-labelledby': 'doc-sync-title' },
      el('header', {}, el('div', {}, el('h2', { id: 'doc-sync-title', text: 'Sync documents' }), el('p', { text: 'Publish this project’s documents to your knowledge bases. Only changed documents are sent.' })), close),
      body);
    dialog.addEventListener('close', () => dialog.remove());
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
    document.body.append(dialog);
    dialog.showModal();
    const render = (status, message) => {
      if (!status.configured) {
        body.replaceChildren(el('div', { class: 'doc-sync-empty' }, el('strong', { text: 'Documentation sync isn’t set up' }), el('p', { text: 'An admin needs to configure Composio before knowledge bases can be connected.' })));
        return;
      }
      const usable = status.providers.filter((p) => p.connected);
      if (!usable.length) {
        body.replaceChildren(el('div', { class: 'doc-sync-empty' },
          el('strong', { text: 'No knowledge base connected' }),
          el('p', { text: 'Connect Notion, Google Docs, Confluence or another source to publish your documents.' }),
          el('a', { class: 'doc-sync-btn doc-sync-primary', href: '/settings/integrations#doc-sync-card' }, icon('fas fa-plug'), ' Connect a source')));
        return;
      }
      const picks = new Map();
      const rows = usable.map((p) => {
        const check = el('input', { type: 'checkbox', checked: p.ready, disabled: !p.ready, 'aria-label': 'Sync to ' + p.name });
        picks.set(p.key, check);
        const state = !p.ready
          ? el('a', { href: '/settings/integrations#doc-sync-card', text: 'Choose a ' + (p.destinationLabel || 'destination').toLowerCase() })
          : el('span', { text: p.total ? `${p.upToDate} of ${p.total} up to date` + (p.lastSyncedAt ? ' · ' + ago(p.lastSyncedAt) : '') : 'No documents yet' });
        const errors = p.errors.length ? el('ul', { class: 'doc-sync-errors' }, p.errors.map((e) => el('li', { text: `${e.name}: ${e.error}` }))) : null;
        return el('label', { class: 'doc-sync-target' + (p.ready ? '' : ' is-disabled') },
          check, brand(p),
          el('span', { class: 'doc-sync-identity' }, el('strong', {}, p.name, p.autoSync ? el('span', { class: 'doc-sync-tag', text: 'Auto' }) : null), state, errors));
      });
      const force = el('input', { type: 'checkbox' });
      const run = el('button', { type: 'button', class: 'doc-sync-btn doc-sync-primary' }, icon('fas fa-arrows-rotate'), ' Sync now');
      const note = el('p', { class: 'doc-sync-note' + (message?.error ? ' is-error' : ''), role: 'status', text: message?.text || '' });
      run.addEventListener('click', async () => {
        const providers = [...picks].filter(([, c]) => c.checked && !c.disabled).map(([k]) => k);
        if (!providers.length) { note.textContent = 'Choose at least one knowledge base.'; return; }
        run.disabled = true; run.replaceChildren(icon('fas fa-spinner fa-spin'), ' Syncing…'); note.textContent = '';
        try {
          const data = await api(`/api/projects/${encodeURIComponent(projectId)}/document-sync`, { method: 'POST', body: JSON.stringify({ providers, force: force.checked }) });
          const synced = data.results.reduce((n, r) => n + r.synced, 0);
          const failed = data.results.reduce((n, r) => n + r.failed, 0);
          render(data.status, {
            error: failed > 0,
            text: failed ? `${synced} synced, ${failed} failed.` : synced ? `${synced} document${synced === 1 ? '' : 's'} synced.` : 'Everything was already up to date.',
          });
          updateBadge(data.status);
        } catch (err) {
          run.disabled = false; run.replaceChildren(icon('fas fa-arrows-rotate'), ' Sync now');
          note.textContent = err.message; note.classList.add('is-error');
        }
      });
      body.replaceChildren(
        el('div', { class: 'doc-sync-targets' }, rows),
        el('footer', {},
          el('label', { class: 'doc-sync-force' }, force, ' Re-send unchanged documents'),
          el('a', { href: '/settings/integrations#doc-sync-card', class: 'doc-sync-settings-link', text: 'Manage sources' }),
          run),
        note);
    };
    api(`/api/projects/${encodeURIComponent(projectId)}/document-sync`)
      .then((status) => { render(status); updateBadge(status); })
      .catch((err) => body.replaceChildren(el('div', { class: 'doc-sync-loading is-error', text: err.message })));
  }
  function updateBadge(status) {
    const button = document.getElementById('document-sync-open');
    if (!button) return;
    const ready = status.providers.filter((p) => p.ready);
    const stale = ready.some((p) => p.upToDate < p.total);
    button.classList.toggle('has-pending', stale);
    button.title = !ready.length ? 'Sync documents to your knowledge bases' : stale ? 'Some documents have changes to sync' : 'Documents are in sync';
  }
  window.DocumentSync = {
    mount(projectId) {
      currentProject = projectId;
      const refresh = document.getElementById('refresh-filebrowser');
      if (!refresh) return;
      let button = document.getElementById('document-sync-open');
      if (!button) {
        button = el('button', { id: 'document-sync-open', type: 'button', class: 'document-sync-open', 'aria-label': 'Sync documents to knowledge bases' }, icon('fas fa-cloud-arrow-up'), el('span', { text: 'Sync' }));
        refresh.before(button);
      }
      button.onclick = () => openPanel(currentProject);
      api(`/api/projects/${encodeURIComponent(projectId)}/document-sync`).then(updateBadge).catch(() => {});
    },
    open: (projectId) => openPanel(projectId || currentProject),
  };

  const start = () => {
    mountSettings();
    // The Documents panel may have loaded before this deferred script ran.
    if (window.currentFileBrowserProjectId) window.DocumentSync.mount(window.currentFileBrowserProjectId);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
