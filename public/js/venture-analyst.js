(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const grid = $('va-grid'), panel = $('va-panel'), stage = $('va-stage');
  const cta = $('va-cta'), close = $('va-close'), status = $('va-status');
  const narrow = matchMedia('(max-width:1023px)');
  let expanded = false, controller, streamController, activeTurn, epoch = 0, loadEpoch = 0, returnFocus = cta, selectedId = null;
  function stop() {
    if (activeTurn) fetch(`/api/venture/conversations/${encodeURIComponent(activeTurn.id)}/stop`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: activeTurn.requestId }), keepalive: true }).catch(() => {});
    streamController?.abort(); streamController = null;
  }
  const element = (tag, text, className) => {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  function button(text, action, className = 'va-quiet') {
    const el = element('button', text, className); el.type = 'button'; el.onclick = action; return el;
  }
  function sample() {
    stage.replaceChildren();
    const content = element('div', '', 'va-content');
    content.append(element('div', 'EXAMPLE CONVERSATION', 'va-label'),
      element('div', 'I have an idea for a product. How do I know if it’s worth building?', 'va-message user'),
      element('div', 'Let’s look at the opportunity—and your edge.\n\nWho has this problem, and what have you learned from them so far?', 'va-message'));
    const foot = element('div', 'Your idea deserves its own conversation.', 'va-sample');
    foot.append(button('Start yours →', () => open())); stage.append(content, foot);
  }
  function cancel() { epoch++; stop(); controller?.abort(); controller = null; }
  function modal() {
    const active = expanded && narrow.matches;
    panel.setAttribute('role', active ? 'dialog' : 'region');
    if (active) panel.setAttribute('aria-modal', 'true'); else panel.removeAttribute('aria-modal');
    document.body.classList.toggle('va-modal-open', active);
    // Keep the shared mobile navigation and footer out of the dialog's focus order.
    document.querySelectorAll('body > nav, body > footer, .va-pitch, .va-rail').forEach(el => { el.inert = active; });
  }
  function collapse() {
    cancel(); expanded = false; grid.classList.remove('expanded'); close.hidden = true;
    cta.setAttribute('aria-expanded', 'false'); status.textContent = 'Example conversation · not a live chat';
    modal(); sample(); history.replaceState(null, '', location.pathname);
    (returnFocus?.isConnected && returnFocus !== document.body ? returnFocus : cta).focus();
  }
  function message(error) {
    const correlation = error?.requestId ? ` Correlation ID: ${error.requestId}` : '';
    return `${error?.message || 'Request failed. Please retry.'}${correlation}`;
  }
  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, signal: controller?.signal, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...options.headers } });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || 'Please retry.'), { status: response.status, code: data.code, requestId: data.requestId || response.headers.get('X-Request-ID') });
    return data;
  }
  function authView(error) {
    stage.replaceChildren(); status.textContent = 'Your private assessment starts here';
    const content = element('div', '', 'va-content'), auth = element('div', '', 'va-auth');
    auth.append(panel.querySelector('.va-avatar').cloneNode(true), element('h2', 'Meet your venture analyst'), element('p', 'Sign in to start a private conversation about your idea, your background, and what comes next.'));
    if (error) auth.append(element('p', message(error), 'va-error'));
    const google = button('Continue with Google', signin, 'va-google');
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
    // Static brand artwork only; all server/user content is rendered with textContent.
    icon.innerHTML = '<path fill="#4285F4" d="M22 12.2c0-.7-.1-1.4-.2-2.1H12v4h5.6a4.8 4.8 0 0 1-2.1 3.1v2.6h3.4c2-1.8 3.1-4.4 3.1-7.6Z"/><path fill="#34A853" d="M12 22c2.8 0 5.1-.9 6.9-2.5l-3.4-2.6a6.3 6.3 0 0 1-9.4-3.3H2.6v2.7A10.4 10.4 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.1 13.6a6.4 6.4 0 0 1 0-3.2V7.7H2.6a10 10 0 0 0 0 8.6Z"/><path fill="#EA4335" d="M12 6c1.6 0 3 .5 4.1 1.6l3.1-3A10 10 0 0 0 2.6 7.7l3.5 2.7A6.2 6.2 0 0 1 12 6Z"/>';
    google.prepend(icon);
    auth.append(google, element('p', 'Google verifies your identity. No access to your Gmail inbox is requested.', 'va-muted'));
    content.append(auth); stage.append(content);
  }
  async function signin() {
    cancel(); controller = new AbortController(); const version = epoch;
    authView(); const google = stage.querySelector('.va-google'); google.disabled = true; google.textContent = 'Signing in with Google…';
    google.after(button('Cancel', () => { cancel(); authView(); stage.querySelector('button')?.focus(); }));
    try {
      const data = await api('/auth/venture/google', { method: 'POST', body: '{}' });
      if (version !== epoch || !expanded) return;
      const target = new URL(data.url);
      if (target.protocol !== 'https:' || target.hostname !== 'accounts.google.com') throw new Error('Google returned an unexpected sign-in destination. Please retry.');
      location.assign(target.href);
    } catch (error) { if (error.name !== 'AbortError' && version === epoch) { authView(error); stage.querySelector('button')?.focus(); } }
  }
  async function loadConversation(id, content) {
    const version = epoch, loadVersion = ++loadEpoch;
    const data = await api(`/api/venture/conversations/${encodeURIComponent(id)}`);
    if (version !== epoch || loadVersion !== loadEpoch || !expanded) return;
    selectedId = data.conversation.id;
    content.replaceChildren(element('div', 'PRIVATE CONVERSATION', 'va-label'));
    if (!data.messages.length) content.append(element('p', 'Welcome. Tell me what you’re thinking of building and who it would help. A rough idea is enough to begin.', 'va-message'));
    for (const msg of data.messages) {
      const bubble = element('div', msg.content, `va-message ${msg.role === 'user' ? 'user' : ''}`);
      if (msg.status !== 'completed') {
        bubble.append(element('small', ` (${msg.status === 'started' ? 'in progress or interrupted — reload after two minutes' : msg.status}; correlation ID: ${msg.requestId}). Saved history is safe.`));
        if (msg.status === 'started') bubble.append(button('Stop saved turn', async () => {
          try { await api(`/api/venture/conversations/${encodeURIComponent(id)}/stop`, { method: 'POST', body: JSON.stringify({ requestId: msg.requestId }) }); await loadConversation(id, content); } catch (error) { failure(error); }
        }));
        if (msg.role === 'assistant') bubble.append(button('Retry explicitly', () => {
          const prior = data.messages.find(m => m.requestId === msg.requestId && m.role === 'user');
          const input = stage.querySelector('textarea'); if (input && prior) { input.value = prior.content; input.focus(); }
        }));
      }
      content.append(bubble);
    }
    for (const source of data.sources || []) addSource(content, source);
    composer(data.conversation.id, content);
    content.scrollTop = content.scrollHeight;
  }
  function addSource(content, source) {
    // No raw Markdown/HTML rendering. Only validated ledger URLs become links.
    let url; try { url = new URL(source.url); } catch { return; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    const link = element('a', `${source.title || url.hostname} · ${new Date(source.retrievedAt).toLocaleDateString()} · [[source:${source.id}]]`, 'va-source');
    link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
    const row = element('div', '', 'va-muted'); row.append(link, element('p', (source.excerpt || '').slice(0, 240))); content.append(row);
  }
  function composer(id, content) {
    stage.querySelector('.va-composer')?.remove();
    const form = element('form', '', 'va-composer'), row = element('div', '', 'va-inputrow');
    const input = element('textarea'); input.maxLength = 4000; input.rows = 2; input.required = true; input.setAttribute('aria-label', 'Your message'); input.placeholder = 'Tell me about your idea…';
    const send = element('button', 'Send', 'va-send'); send.type = 'submit';
    const stopButton = button('Stop', stop); stopButton.hidden = true;
    const feedback = element('div', '', 'va-muted'); feedback.setAttribute('role', 'status');
    row.append(input, send, stopButton); form.append(row, feedback); stage.append(form);
    form.onsubmit = async event => {
      event.preventDefault(); if (activeTurn || !input.value.trim()) return;
      const text = input.value.trim(), requestId = crypto.randomUUID(), version = epoch;
      activeTurn = { id, requestId }; streamController = new AbortController();
      input.value = ''; input.disabled = true; send.disabled = true; stopButton.hidden = false;
      stage.querySelectorAll('.va-history button,.va-history select').forEach(el => { el.disabled = true; });
      const user = element('div', text, 'va-message user'), answer = element('div', '', 'va-message'); content.append(user, answer);
      feedback.textContent = `Analysis starting… Correlation ID: ${requestId}`;
      let finished = false;
      try {
        const response = await fetch(`/api/venture/conversations/${encodeURIComponent(id)}/stream`, { method: 'POST', credentials: 'same-origin', signal: streamController.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId, content: text }) });
        if (!response.ok) {
          const error = await response.json(); throw Object.assign(new Error(error.error), { requestId: error.requestId });
        }
        const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '';
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          pending += decoder.decode(chunk.value, { stream: true });
          const lines = pending.split('\n'); pending = lines.pop();
          for (const line of lines) {
            if (!line || version !== epoch) continue;
            const event = JSON.parse(line);
            if (event.type === 'text') answer.append(document.createTextNode(event.text));
            if (event.type === 'progress') feedback.textContent = `${event.message} Correlation ID: ${requestId}`;
            if (event.type === 'source') addSource(content, event.source);
            if (event.type === 'error') feedback.textContent = `${event.message} (${event.code}) Correlation ID: ${requestId}`;
            if (event.type === 'done') { finished = true; if (event.status === 'completed') feedback.textContent = `Saved. Correlation ID: ${requestId}`; }
          }
          content.scrollTop = content.scrollHeight;
        }
        if (!finished) throw Object.assign(new Error('Stream interrupted. Reload saved history before retrying.'), { requestId });
      } catch (error) {
        if (version === epoch) feedback.textContent = error.name === 'AbortError' ? `Stopped. Partial history is saved. Correlation ID: ${requestId}` : message(error);
      } finally {
        activeTurn = null; streamController = null;
        if (version === epoch) {
          input.disabled = false; send.disabled = false; stopButton.hidden = true;
          stage.querySelectorAll('.va-history button,.va-history select').forEach(el => { el.disabled = false; });
          feedback.append(button('Retry explicitly', () => { input.value = text; input.focus(); }), button('Reload saved history', () => loadConversation(id, content).catch(failure)));
        }
      }
    };
  }
  function failure(error) {
    if (error.name === 'AbortError') return;
    if (error.status === 401 || error.status === 403) return authView(error);
    stage.replaceChildren(element('p', message(error), 'va-error'), button('Retry', () => ready()));
  }
  async function conversations() {
    const version = epoch;
    const data = await api('/api/venture/conversations');
    if (version !== epoch || !expanded) return;
    stage.replaceChildren(); status.textContent = 'Private conversation · saved to your account';
    const toolbar = element('div', '', 'va-history'), select = element('select'); select.setAttribute('aria-label', 'Saved conversations');
    select.append(new Option('Select a saved conversation', ''));
    data.conversations.forEach(item => select.append(new Option(item.title, item.id)));
    const content = element('div', '', 'va-content'); content.setAttribute('role', 'log');
    select.onchange = () => { if (select.value) loadConversation(select.value, content).catch(failure); };
    toolbar.append(select, button('New conversation', async () => {
      try {
        const data = await api('/api/venture/conversations', { method: 'POST', body: '{}' });
        if (version !== epoch) return;
        selectedId = data.conversation.id; await conversations();
      } catch (error) { if (version === epoch) failure(error); }
    }));
    stage.append(toolbar, content);
    const id = data.conversations.some(item => item.id === selectedId) ? selectedId : data.conversations[0]?.id;
    if (id) { select.value = id; await loadConversation(id, content); }
    else content.append(element('p', 'Create a private conversation to begin an adaptive interview and public-source research.', 'va-muted'));
  }
  async function ready() {
    cancel(); controller = new AbortController(); const version = epoch;
    stage.replaceChildren(element('p', 'Checking private session…', 'va-content'));
    try {
      const readiness = await api('/api/venture/session');
      if (version === epoch && expanded) {
        await conversations();
        if (!readiness.streamingAvailable) stage.querySelector('.va-content')?.prepend(element('p', `AI is unavailable: the operator must configure ${readiness.requiredProviderKey || 'platform provider credentials'}. Saved history remains readable.`, 'va-muted'));
      }
    }
    catch (error) { if (version === epoch && expanded) {
      if (error.status === 401 || error.code === 'GOOGLE_LINK_REQUIRED') authView(); else failure(error);
    } }
  }
  function open(error) {
    if (!expanded) returnFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : cta;
    expanded = true; grid.classList.add('expanded'); close.hidden = false; cta.setAttribute('aria-expanded', 'true');
    stage.replaceChildren(); modal(); panel.focus(); history.replaceState(null, '', `${location.pathname}?chat=open`);
    if (error) authView(error); else ready();
  }
  cta.onclick = () => open(); close.onclick = collapse; narrow.addEventListener('change', modal);
  document.addEventListener('keydown', event => {
    if (!expanded) return;
    if (event.key === 'Escape') { event.preventDefault(); collapse(); }
    if (event.key === 'Tab' && narrow.matches) {
      const all = [...panel.querySelectorAll('button:not(:disabled),select,a[href],input,textarea,[tabindex="0"]')].filter(el => !el.hidden);
      const first = all[0], last = all.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel)) { event.preventDefault(); first?.focus(); }
    }
  });
  sample();
  const query = new URLSearchParams(location.search);
  if (query.get('chat') === 'open') open(query.get('auth') === 'failed' ? Object.assign(new Error('Google sign-in wasn’t completed. Retry; if you already have an LFG account, sign in to it first, then connect Google.'), { requestId: query.get('requestId') }) : null);
  else {
    // Returning Google-connected users resume; anonymous/password-only users keep
    // the labelled landing example until they choose the CTA.
    fetch('/api/venture/session', { credentials: 'same-origin' }).then(response => { if (response.ok && !expanded && epoch === 0) open(); }).catch(() => {});
  }
})();
