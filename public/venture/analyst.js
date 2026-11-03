(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const grid = $('va-grid'), panel = $('va-panel'), stage = $('va-stage');
  const cta = $('va-cta'), close = $('va-close'), status = $('va-status');
  // "page" is the analyst's own page (/venture-analyst/chat); otherwise this is
  // the landing panel, which only signs people in and hands over to that page.
  const pageMode = document.body.dataset.ventureMode === 'page';
  const chatPage = id => `/venture-analyst/chat${id ? `?c=${encodeURIComponent(id)}` : ''}`;
  const narrow = matchMedia('(max-width:1023px)');
  let expanded = false, controller, streamController, activeTurn, epoch = 0, loadEpoch = 0, returnFocus = cta, selectedId = null;
  const drafts = new Map(), sourceMap = new Map();
  let ventureLimit = null;
  const query = new URLSearchParams(location.search);
  let requested = query.get('c');
  const markdown = (el, text) => window.ventureMarkdown ? window.ventureMarkdown.into(el, text, sourceMap) : (el.textContent = text);
  const nextPage = query.get('next') === 'dashboard' ? 'dashboard' : null;
  const dashboard = $('va-dashboard');
  // One clear way to the dashboard, in the panel header, once signed in.
  function showDashboard(id) {
    if (!dashboard) return;
    dashboard.hidden = false;
    dashboard.href = `/venture-analyst/dashboard${id ? `?v=${encodeURIComponent(id)}` : ''}`;
  }
  const hideDashboard = () => { if (dashboard) dashboard.hidden = true; };
  // Friendly text first; the correlation ID stays available but small.
  function say(target, text, ref) {
    target.replaceChildren(document.createTextNode(text || ''));
    if (ref) { const small = element('small', ` Ref ${String(ref).slice(0, 8)}`, 'va-ref'); small.title = `Correlation ID: ${ref}`; target.append(small); }
  }
  function tabs(active) {
    stage.querySelectorAll('.va-views .va-tab').forEach(tab => { const on = tab.dataset.view === active; tab.classList.toggle('active', on); tab.setAttribute('aria-selected', String(on)); });
  }
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
    if (pageMode) return;
    const active = expanded && narrow.matches;
    panel.setAttribute('role', active ? 'dialog' : 'region');
    if (active) panel.setAttribute('aria-modal', 'true'); else panel.removeAttribute('aria-modal');
    document.body.classList.toggle('va-modal-open', active);
    // Keep the shared mobile navigation and footer out of the dialog's focus order.
    document.querySelectorAll('body > nav, body > footer, .va-pitch, .va-rail').forEach(el => { el.inert = active; });
  }
  function collapse() {
    cancel(); hideDashboard(); expanded = false; grid.classList.remove('expanded'); close.hidden = true;
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
    stage.replaceChildren(); hideDashboard(); status.textContent = nextPage ? 'Sign in to open your dashboard' : 'Your assessment starts here';
    const content = element('div', '', 'va-content'), auth = element('div', '', 'va-auth');
    auth.append(panel.querySelector('.va-avatar').cloneNode(true), element('h2', nextPage ? 'Sign in to see your dashboard' : 'Meet your venture analyst'), element('p', 'Sign in to start a conversation about your idea, your background, and what comes next. Only you and LFG’s venture review team can see it.'));
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
      const data = await api('/auth/venture/google', { method: 'POST', body: JSON.stringify(nextPage ? { next: nextPage } : {}) });
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
    status.textContent = data.conversation.title;
    // Reload resumes this conversation; a fresh open starts a new chat.
    history.replaceState(null, '', pageMode ? chatPage(selectedId) : `${location.pathname}?chat=open&c=${encodeURIComponent(selectedId)}`);
    stage.querySelector('.va-views')?.remove();
    const views = element('div', '', 'va-views');
    views.setAttribute('role', 'tablist');
    const chatTab = button('Chat', () => loadConversation(id, content).catch(failure), 'va-tab'), reportTab = button('Assessment', () => assessmentView(id, content), 'va-tab');
    chatTab.dataset.view = 'chat'; reportTab.dataset.view = 'assessment';
    [chatTab, reportTab].forEach(tab => tab.setAttribute('role', 'tab'));
    views.append(chatTab, reportTab);
    content.before(views); tabs('chat'); showDashboard(id);
    (data.sources || []).forEach(source => sourceMap.set(source.id, source));
    content.replaceChildren(element('div', 'YOUR CONVERSATION · REVIEWED BY LFG FOR FUNDING', 'va-label'));
    content.setAttribute('role', 'log'); content.removeAttribute('aria-label');
    if (!data.messages.length) content.append(element('p', 'Welcome. Tell me what you’re thinking of building and who it would help. A rough idea is enough to begin.', 'va-message'));
    for (const msg of data.messages) {
      const bubble = element('div', msg.role === 'user' ? msg.content : '', `va-message ${msg.role === 'user' ? 'user' : ''}`);
      if (msg.role !== 'user') markdown(bubble, msg.content);
      if (msg.role === 'assistant' && msg.status !== 'completed') {
        // A reply that didn't finish: a short notice instead of an empty bubble.
        const notice = element('div', '', 'va-notice');
        say(notice, msg.status === 'started' ? 'Still working, or interrupted. Check back in a couple of minutes.' : msg.status === 'cancelled' ? 'This reply was stopped.' : 'This reply failed.', msg.requestId);
        if (msg.status === 'started') notice.append(button('Stop', async () => {
          try { await api(`/api/venture/conversations/${encodeURIComponent(id)}/stop`, { method: 'POST', body: JSON.stringify({ requestId: msg.requestId }) }); await loadConversation(id, content); } catch (error) { failure(error); }
        }));
        else notice.append(button('Try again', () => {
          const prior = data.messages.find(m => m.requestId === msg.requestId && m.role === 'user');
          const input = stage.querySelector('textarea'); if (input && prior) { input.value = prior.content; input.focus(); }
        }));
        if (msg.content) bubble.append(notice); else { content.append(notice); continue; }
      }
      content.append(bubble);
    }
    for (const source of data.sources || []) addSource(content, source);
    composer(data.conversation.id, content);
    content.scrollTop = content.scrollHeight;
    // A first message typed on the dashboard is handed over once, via session storage.
    let pending = null; try { pending = sessionStorage.getItem(`va-pending:${id}`); sessionStorage.removeItem(`va-pending:${id}`); } catch { /* storage unavailable */ }
    if (pending && !data.messages.length) { const form = stage.querySelector('.va-composer'); form.querySelector('textarea').value = pending; form.requestSubmit(); }
  }
  async function assessmentView(id, content) {
    if (activeTurn) return;
    const loadVersion = ++loadEpoch;
    tabs('assessment');
    const form = stage.querySelector('.va-composer');
    // Keep the composer and unsent correction intact while browsing the report.
    if (form) form.hidden = true;
    content.replaceChildren(element('p', 'Loading latest saved assessment…', 'va-muted'));
    try {
      const data = await api(`/api/venture/conversations/${encodeURIComponent(id)}/assessment`);
      if (selectedId !== id || !expanded || loadVersion !== loadEpoch) return;
      renderAssessment(data.assessment, data.sources || [], id, content);
    } catch (error) { if (loadVersion === loadEpoch && expanded) content.replaceChildren(element('p', message(error), 'va-error'), button('Retry loading assessment', () => assessmentView(id, content))); }
  }
  function renderAssessment(saved, sources, id, content) {
    content.replaceChildren(); content.setAttribute('role', 'region'); content.setAttribute('aria-label', 'Saved venture assessment');
    content.append(element('h2', 'Assessment'), element('p', 'Financial figures and timelines are scenarios, not promises. Founder fit concerns relevant experience, access and capacity—not personal worth.', 'va-muted'));
    if (saved) {
      content.append(element('p', `${saved.status.toUpperCase()} · Version ${saved.version} · Last saved ${new Date(saved.createdAt).toLocaleString()}`, 'va-label'));
      const labels = { missingInputs: 'Missing inputs / focused follow-up', assumptions: 'Assumptions', founderFit: 'Founder fit and recommended changes', opportunity: 'Opportunity and customer pain', units: 'Shared currency, period and geography', market: 'Bottom-up TAM / SAM / SOM', revenue: 'Conservative / base / upside revenue', financing: 'Financing and profit-sharing tradeoffs', gtm: 'GTM experiments and budgets', milestones: 'Validation, MVP, first user and first revenue', uncertainties: 'Uncertainties', recommendation: 'Verdict, token tranche and your commitments' };
      const human = key => key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
      function render(value, parent) {
        if (value === null) { parent.append(element('span', 'Unknown — input needed')); return; }
        if (Array.isArray(value)) { const list = element('ul'); for (const item of value) { const li = element('li'); render(item, li); list.append(li); } parent.append(list); return; }
        if (typeof value === 'object') {
          if (value.kind && value.text) {
            parent.append(element('p', `[${value.kind}] ${value.text}`));
            value.sourceIds.forEach(sourceId => { const source = sources.find(s => s.id === sourceId); if (source) addSource(parent, source); }); return;
          }
          for (const [key, child] of Object.entries(value)) { const row = element('div', '', 'va-assessment-row'); row.append(element('strong', `${human(key)}: `)); render(child, row); parent.append(row); } return;
        }
        parent.append(document.createTextNode(String(value)));
      }
      for (const [key, title] of Object.entries(labels)) { const section = element('section', '', 'va-assessment-section'); section.append(element('h3', title)); render(saved.contentJson[key], section); content.append(section); }
    } else content.append(element('p', 'No saved assessment yet. Generate a provisional assessment, or return to chat to supply missing inputs.'));
    const feedback = element('p', '', 'va-muted'); feedback.setAttribute('role', 'status');
    const generate = button(saved ? 'Regenerate explicitly' : 'Generate assessment', async () => {
      if (activeTurn) return;
      const requestId = crypto.randomUUID(); activeTurn = { id, requestId };
      generate.disabled = true; feedback.textContent = `Generating and validating… Correlation ID: ${requestId}`;
      stage.querySelectorAll('.va-history button,.va-history select,.va-views button').forEach(el => { el.disabled = true; });
      try {
        const data = await api(`/api/venture/conversations/${encodeURIComponent(id)}/assessment`, { method: 'POST', body: JSON.stringify({ requestId }) });
        if (expanded && selectedId === id) renderAssessment(data.assessment, sources, id, content);
      } catch (error) { if (expanded) feedback.textContent = message(error); }
      finally { activeTurn = null; generate.disabled = false; stage.querySelectorAll('.va-history button,.va-history select,.va-views button').forEach(el => { el.disabled = false; }); }
    }, 'va-send');
    content.append(generate, feedback);
  }
  function addSource(content, source) {
    sourceMap.set(source.id, source);
    // No raw Markdown/HTML rendering. Only validated ledger URLs become links.
    let url; try { url = new URL(source.url); } catch { return; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    const link = element('a', source.title || url.hostname, 'va-source');
    link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
    const row = element('div', '', 'va-source-row');
    row.append(link, element('span', ` · ${url.hostname.replace(/^www\./, '')} · read ${new Date(source.retrievedAt).toLocaleDateString()}`, 'va-muted'), element('p', (source.excerpt || '').replace(/^\[[^\]]*\]\s*/, '').slice(0, 200), 'va-muted'));
    content.append(row);
  }
  function composer(id, content, onCreated) {
    stage.querySelector('.va-composer')?.remove();
    const form = element('form', '', 'va-composer'), row = element('div', '', 'va-inputrow');
    const input = element('textarea'); input.maxLength = 4000; input.rows = 2; input.required = true; input.setAttribute('aria-label', 'Your message'); input.placeholder = 'Tell me about your idea…';
    input.value = drafts.get(id) || ''; input.oninput = () => drafts.set(id, input.value);
    const send = element('button', 'Send', 'va-send'); send.type = 'submit';
    const stopButton = button('Stop', stop); stopButton.hidden = true;
    const feedback = element('div', '', 'va-muted'); feedback.setAttribute('role', 'status');
    row.append(input, send, stopButton); form.append(row, feedback); stage.append(form);
    // Enter sends; Shift+Enter adds a line. Never interrupt IME composition.
    input.onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); } };
    form.onsubmit = async event => {
      event.preventDefault(); if (activeTurn || !input.value.trim()) return;
      const text = input.value.trim(), requestId = crypto.randomUUID(), version = epoch;
      const created = !id;
      if (created) {
        // New chats are created on the first message, titled by it.
        send.disabled = true;
        try { id = (await api('/api/venture/conversations', { method: 'POST', body: JSON.stringify({ title: text.replace(/\s+/g, ' ').slice(0, 80) }) })).conversation.id; }
        catch (error) { send.disabled = false; feedback.textContent = message(error); return; }
        if (version !== epoch) return;
        selectedId = id; onCreated?.(id, text);
      }
      activeTurn = { id, requestId }; streamController = new AbortController();
      drafts.delete(id); input.value = ''; input.disabled = true; send.disabled = true; stopButton.hidden = false;
      stage.querySelectorAll('.va-history button,.va-history select,.va-views button').forEach(el => { el.disabled = true; });
      const user = element('div', text, 'va-message user'), answer = element('div', '', 'va-message'); content.append(user, answer);
      let answerText = '', frame = 0;
      const paint = () => { frame = 0; markdown(answer, answerText); content.scrollTop = content.scrollHeight; };
      say(feedback, 'Thinking…');
      let finished = false, failed = false;
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
            if (event.type === 'text') { answerText += event.text; frame ||= requestAnimationFrame(paint); }
            if (event.type === 'progress') say(feedback, event.message);
            if (event.type === 'source') addSource(content, event.source);
            if (event.type === 'error') { failed = true; say(feedback, event.message, requestId); }
            if (event.type === 'done') { finished = true; if (event.status === 'completed') say(feedback, ''); }
          }
          content.scrollTop = content.scrollHeight;
        }
        if (!finished) throw Object.assign(new Error('Stream interrupted. Reload saved history before retrying.'), { requestId });
      } catch (error) {
        failed = true;
        if (version === epoch) say(feedback, error.name === 'AbortError' ? 'Stopped. Anything already written is saved.' : error.message, error.requestId || requestId);
      } finally {
        activeTurn = null; streamController = null;
        if (frame) cancelAnimationFrame(frame);
        if (answerText) paint(); else answer.remove();
        if (version === epoch && created) {
          stage.querySelectorAll('.va-history button,.va-history select').forEach(el => { el.disabled = false; });
          const outcome = [...feedback.childNodes].map(node => node.cloneNode(true));
          await loadConversation(id, content).catch(failure);
          stage.querySelector('.va-composer [role="status"]')?.replaceChildren(...outcome);
          return;
        }
        if (version === epoch) {
          input.disabled = false; send.disabled = false; stopButton.hidden = true;
          stage.querySelectorAll('.va-history button,.va-history select,.va-views button').forEach(el => { el.disabled = false; });
          if (failed) feedback.append(button('Try again', () => { input.value = text; form.requestSubmit(); }));
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
    stage.replaceChildren(); status.textContent = 'Saved to your account · reviewed by LFG for funding';
    // No conversation picker: this page holds one venture at a time, and the
    // dashboard is where ventures are listed and opened.
    const content = element('div', '', 'va-content'); content.setAttribute('role', 'log');
    function newChat() {
      if (activeTurn) return;
      selectedId = null; loadEpoch++;
      history.replaceState(null, '', pageMode ? chatPage() : `${location.pathname}?chat=open`);
      stage.querySelector('.va-views')?.remove();
      content.setAttribute('role', 'log');
      showDashboard(null); status.textContent = 'New venture · saved to your account';
      if (ventureLimit && !ventureLimit.canCreate) {
        // At the venture limit: explain instead of offering a chat that can't be saved.
        stage.querySelector('.va-composer')?.remove();
        const note = element('div', '', 'va-notice va-limit');
        const dash = element('a', 'Open your dashboard', 'va-source'); dash.href = '/venture-analyst/dashboard';
        note.append(element('span', `You can have ${ventureLimit.max} active venture${ventureLimit.max === 1 ? '' : 's'} at a time. Open it from your dashboard, or archive it there to start another.`), dash);
        content.replaceChildren(element('div', 'NEW CONVERSATION', 'va-label'), note);
        return;
      }
      content.replaceChildren(element('div', 'NEW CONVERSATION', 'va-label'), element('p', 'Welcome. Tell me what you’re thinking of building, who it would help, and what you bring to it. A rough idea is enough to begin.', 'va-message'));
      composer(null, content, (id, text) => { showDashboard(id); status.textContent = text.slice(0, 80); });
      stage.querySelector('.va-composer textarea')?.focus();
    }
    showDashboard(requested || selectedId);
    stage.append(content);
    // Open the requested venture; at the venture limit resume the latest one;
    // otherwise start a fresh chat.
    const atLimit = ventureLimit && !ventureLimit.canCreate;
    const id = [requested, selectedId, atLimit ? data.conversations[0]?.id : null].find(candidate => candidate && data.conversations.some(item => item.id === candidate));
    requested = null;
    if (id) await loadConversation(id, content);
    else newChat();
  }
  async function ready() {
    cancel(); controller = new AbortController(); const version = epoch;
    stage.replaceChildren(element('p', 'Checking private session…', 'va-content'));
    try {
      const readiness = await api('/api/venture/session');
      ventureLimit = readiness.ventureLimit ?? null;
      if (version === epoch && expanded) {
        // Signed in on the landing page: continue on the analyst's own page.
        if (!pageMode) { location.assign(chatPage(requested)); return; }
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
    expanded = true;
    if (!pageMode) {
      grid.classList.add('expanded'); close.hidden = false; cta.setAttribute('aria-expanded', 'true');
      history.replaceState(null, '', `${location.pathname}?chat=open`);
    }
    stage.replaceChildren(); modal(); if (!pageMode) panel.focus();
    if (error) authView(error); else ready();
  }
  const signInFailed = query.get('auth') === 'failed' ? Object.assign(new Error('Google sign-in wasn’t completed. Retry; if you already have an LFG account, sign in to it first, then connect Google.'), { requestId: query.get('requestId') }) : null;
  if (pageMode) { open(signInFailed); return; }
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
  if (query.get('chat') === 'open') open(signInFailed);
})();
