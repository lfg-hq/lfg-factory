// Venture landing: the founder types an idea, then signs in with Google. The
// idea waits in session storage (it survives the Google round trip in this tab)
// and the analyst's page sends it as the first message of a new chat.
(() => {
  'use strict';
  const CHAT = '/venture/chat';
  const KEY = 'va-idea';
  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...options.headers } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || 'Please retry.'), { status: response.status, code: data.code, requestId: data.requestId || response.headers.get('X-Request-ID') });
    return data;
  }
  for (const form of document.querySelectorAll('[data-idea-form]')) {
    const input = form.querySelector('input'), go = form.querySelector('button');
    const note = form.nextElementSibling, original = note.cloneNode(true);
    const restore = () => { note.className = original.className; note.replaceChildren(...[...original.childNodes].map(n => n.cloneNode(true))); };
    const fail = (text, ref) => {
      note.className = 'vh-formnote error';
      note.textContent = ref ? `${text} (ref ${String(ref).slice(0, 8)})` : text;
    };
    input.addEventListener('input', () => { if (note.classList.contains('error')) restore(); });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const idea = input.value.trim();
      if (!idea) { fail('Tell us a little about your idea first. A sentence is enough.'); input.focus(); return; }
      try { sessionStorage.setItem(KEY, idea.slice(0, 4000)); } catch { /* storage unavailable: the founder retypes in chat */ }
      const label = go.innerHTML; go.disabled = true; go.textContent = 'Opening Google sign-in…';
      try {
        // Already signed in with Google: straight to the analyst.
        try { await api('/api/venture/session'); location.assign(CHAT); return; }
        catch (error) { if (error.status !== 401 && error.code !== 'GOOGLE_LINK_REQUIRED') throw error; }
        const data = await api('/auth/venture/google', { method: 'POST', body: '{}' });
        const target = new URL(data.url);
        if (target.protocol !== 'https:' || target.hostname !== 'accounts.google.com') throw new Error('Google returned an unexpected sign-in destination. Please retry.');
        location.assign(target.href);
      } catch (error) {
        go.disabled = false; go.innerHTML = label;
        fail(error.message || 'Google sign-in could not start. Please retry.', error.requestId);
      }
    });
  }
  // Coming back with the browser's back button: the form is usable again.
  addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
})();
