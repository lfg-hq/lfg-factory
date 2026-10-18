(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const pid = document.body.dataset.projectId, tid = document.body.dataset.ticketId;
  const api = `/api/projects/${encodeURIComponent(pid)}/tickets/${encodeURIComponent(tid)}/code/`;
  const params = new URLSearchParams(location.search);
  let base = params.get('base') || 'main', files = [], changedOnly = true, selected = null, current = null;
  let diffEditor, editor, models, mode = 'diff', canEdit = false, dirty = false, busy = false, pendingCommit = null, requestId = 0;
  $('base').value = base;
  const status = text => { $('status').textContent = text; };
  function message(text) { $('message').hidden = !text; $('message').textContent = text || ''; }
  function controls() { const readOnly = !canEdit || busy || !current?.exists; $('save').disabled = !dirty || readOnly; $('format').disabled = !selected || readOnly; diffEditor?.updateOptions({ readOnly }); editor?.updateOptions({ readOnly }); }
  async function request(action, body, extra = {}) {
    const q = new URLSearchParams({ base, ...extra });
    const r = await fetch(api + action + '?' + q, { credentials: 'same-origin', ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const data = await r.json();
    if (r.status === 202 && data?.preparing) { status(data.message || 'Restoring ticket workspace…'); $('connection').textContent = '◌ Restoring'; await new Promise(resolve => setTimeout(resolve, 2000)); return request(action, body, extra); }
    if (!r.ok || data?.error) throw new Error(data?.error || 'Request failed');
    if (action === 'tree' && (!data || !Array.isArray(data.files) || typeof data.branch !== 'string' || data.files.some(f => !f || typeof f.path !== 'string' || typeof f.changed !== 'boolean'))) {
      throw new Error('The workspace returned an incomplete file list. Refresh to retry.');
    }
    return data;
  }
  function updateUrl(path) { const url = new URL(location.href); url.searchParams.set('base', base); if (path) url.searchParams.set('file', path); window.history.replaceState(null, '', url); }
  function renderFiles() {
    const query = $('file-search').value.toLowerCase();
    const shown = files.filter(f => (!changedOnly || f.changed) && f.path.toLowerCase().includes(query));
    $('file-list').replaceChildren();
    $('change-count').textContent = files.filter(f => f.changed).length;
    if (!shown.length) { const p = document.createElement('p'); p.className = 'list-empty'; p.textContent = query ? 'No matching files.' : changedOnly ? 'No changes against this base. Explore All files to browse the codebase.' : 'No files available.'; $('file-list').append(p); }
    for (const f of shown) {
      const b = document.createElement('button'); b.className = 'file-item' + (selected === f.path ? ' active' : ''); b.title = f.path; b.setAttribute('aria-pressed', String(selected === f.path));
      const icon = document.createElement('span'); icon.className = 'file-icon'; icon.textContent = /\.(ts|tsx)$/.test(f.path) ? 'TS' : /\.(js|jsx)$/.test(f.path) ? 'JS' : /\.css$/.test(f.path) ? '#' : '◇';
      const name = document.createElement('span'); name.className = 'file-name'; name.textContent = f.path.split('/').pop();
      if (f.path.includes('/')) { const folder = document.createElement('small'); folder.textContent = f.path.slice(0, f.path.lastIndexOf('/')); name.append(folder); }
      b.append(icon, name);
      if (f.changed) { const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = 'M'; badge.title = 'Changed against base'; b.append(badge); }
      b.onclick = () => openFile(f.path); $('file-list').append(b);
    }
  }
  function discard() { return !dirty || window.confirm('Discard your unsaved edits and continue?'); }
  async function refresh(initial = false) {
    if (busy || (!initial && !discard())) return;
    busy = true; controls(); status('Opening ticket workspace…'); message(''); $('connection').textContent = '◌ Connecting';
    try {
      const data = await request('tree'); files = data.files; canEdit = data.canEdit;
      $('branch').textContent = data.branch; $('branch').title = data.branch;
      $('connection').textContent = canEdit ? '● Sandbox connected' : '◌ Read-only';
      $('command').disabled = $('run-command').disabled = !canEdit;
      $('base-label').textContent = 'BASE · ' + base; renderFiles();
      if (data.truncated) message('Showing the first 10,000 files.');
      status(canEdit ? 'Connected to ticket sandbox' : 'Read-only · editing unavailable');
      const path = initial ? params.get('file') : selected;
      const next = files.find(f => f.path === path) || files.find(f => f.changed) || files[0];
      busy = false;
      if (next) await openFile(next.path, true);
      controls();
    } catch (e) { busy = false; canEdit = false; controls(); message(e.message); status('Checkout unavailable'); if (!files.length) { $('change-count').textContent = '—'; $('file-list').textContent = 'Could not load ticket files. Refresh to retry.'; } $('connection').textContent = '◌ Unavailable'; $('command').disabled = $('run-command').disabled = true; }
  }
  async function openFile(path, force = false) {
    if (busy || (!force && !discard())) return;
    const id = ++requestId;
    busy = true; controls();
    status('Opening ' + path + '…');
    try {
      const data = await request('file', null, { path });
      if (id !== requestId) return;
      // Keep the previous buffer intact if loading this file fails.
      selected = path; current = data; dirty = false;
      diffEditor.setModel(null); editor.setModel(null);
      if (models) { models.original.dispose(); models.modified.dispose(); }
      const uri = monaco.Uri.parse('file:///ticket/' + path);
      models = { original: monaco.editor.createModel(data.original, undefined, monaco.Uri.parse('file:///base/' + path)), modified: monaco.editor.createModel(data.content, undefined, uri) };
      diffEditor.setModel(models); editor.setModel(models.modified);
      const readOnly = !canEdit || !data.exists;
      diffEditor.updateOptions({ readOnly }); editor.updateOptions({ readOnly });
      models.modified.onDidChangeContent(() => { dirty = models.modified.getValue() !== current.content; $('dirty-label').textContent = dirty ? '● Unsaved' : ''; controls(); status(dirty ? 'Unsaved changes' : 'All changes saved'); });
      $('empty').hidden = true; $('breadcrumb').textContent = path; $('dirty-label').textContent = '';
      $('file-status').textContent = models.modified.getLanguageId() + '  /  UTF-8';
      renderFiles(); updateUrl(path); controls(); status(readOnly ? 'Read-only' : 'Ready · Ctrl/Cmd+S to save');
      if (!data.exists) message('This file was deleted. The base version is shown for review.'); else message('');
      layout();
    } catch (e) { if (id === requestId) { message(e.message); status('Could not open file'); } }
    finally { busy = false; controls(); }
  }
  function layout() { diffEditor?.layout(); editor?.layout(); }
  function setMode(next) { mode = next; $('diff-mode').classList.toggle('active', mode === 'diff'); $('edit-mode').classList.toggle('active', mode === 'edit'); $('diff-labels').hidden = mode !== 'diff'; $('split-host').hidden = mode !== 'diff'; $('edit-host').hidden = mode !== 'edit'; layout(); }
  async function save() {
    if (!dirty || !canEdit || busy) return;
    busy = true; controls(); message('');
    const path = selected, content = models.modified.getValue(), version = current.version;
    // Freeze navigation while saving so the response always belongs to this buffer.
    $('file-list').inert = true; $('refresh').disabled = true;
    try {
      const result = await request('save', { path, content, version });
      current.content = content; current.version = result.version; dirty = models.modified.getValue() !== content;
      $('dirty-label').textContent = dirty ? '● Unsaved' : ''; status('Saved to sandbox');
      const entry = files.find(f => f.path === path); if (entry) entry.changed = models.original.getValue() !== content; renderFiles();
      pendingCommit = { path, version: result.version };
      $('commit-file').textContent = path; $('commit-message').value = 'Update ' + path.split('/').pop(); $('commit-error').textContent = '';
      $('commit-dialog').showModal(); $('commit-message').focus(); $('commit-message').select();
    } catch (e) { message(e.message); status('Save failed · edits preserved'); }
    finally { busy = false; $('file-list').inert = false; $('refresh').disabled = false; controls(); }
  }
  $('commit-form').onsubmit = async e => {
    e.preventDefault(); $('confirm-commit').disabled = $('skip-commit').disabled = true;
    try { const r = await request('commit', { ...pendingCommit, message: $('commit-message').value }); $('commit-dialog').close(); status('Committed ' + r.sha.slice(0, 8) + ' · local only'); }
    catch (err) { $('commit-error').textContent = err.message; }
    finally { $('confirm-commit').disabled = $('skip-commit').disabled = false; }
  };
  $('skip-commit').onclick = () => $('commit-dialog').close();
  $('commit-dialog').addEventListener('cancel', e => { if ($('confirm-commit').disabled) e.preventDefault(); });
  $('save').onclick = save;
  $('refresh').onclick = () => refresh();
  $('file-search').oninput = renderFiles;
  $('changes').onclick = () => { changedOnly = true; $('changes').classList.add('active'); $('all-files').classList.remove('active'); renderFiles(); };
  $('all-files').onclick = () => { changedOnly = false; $('changes').classList.remove('active'); $('all-files').classList.add('active'); renderFiles(); };
  $('diff-mode').onclick = () => setMode('diff'); $('edit-mode').onclick = () => setMode('edit');
  $('base-form').onsubmit = e => { e.preventDefault(); if (busy || !discard()) return; base = $('base').value.trim() || 'main'; dirty = false; updateUrl(selected); refresh(true); };
  $('format').onclick = async () => {
    const active = mode === 'diff' ? diffEditor.getModifiedEditor() : editor;
    const action = active.getAction('editor.action.formatDocument');
    if (!action?.isSupported()) { message('No formatter is available for this language. You can run the project formatter in the terminal.'); return; }
    await action.run();
  };
  function terminal(show) { $('terminal').hidden = !show; $('terminal-toggle').setAttribute('aria-expanded', String(show)); layout(); if (show) $('command').focus(); }
  $('terminal-toggle').onclick = () => terminal($('terminal').hidden); $('close-terminal').onclick = () => terminal(false);
  $('clear-terminal').onclick = () => { $('terminal-output').textContent = ''; };
  const history = []; let historyIndex = 0;
  $('command').onkeydown = e => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); historyIndex = Math.max(0, Math.min(history.length, historyIndex + (e.key === 'ArrowUp' ? -1 : 1))); $('command').value = history[historyIndex] || ''; } };
  $('terminal-form').onsubmit = async e => {
    e.preventDefault(); const command = $('command').value.trim(); if (!command || !canEdit || $('run-command').disabled) return;
    history.push(command); historyIndex = history.length; $('command').value = ''; $('run-command').disabled = true;
    const out = $('terminal-output'); out.textContent += '\n❯ ' + command + '\n';
    try { const r = await request('exec', { command }); out.textContent += r.output + '\n[exit ' + r.exitCode + (r.truncated ? ' · output truncated' : '') + ']\n'; }
    catch (err) { out.textContent += err.message + '\n'; }
    finally { out.textContent = out.textContent.slice(-100000); out.scrollTop = out.scrollHeight; $('run-command').disabled = !canEdit; }
  };
  window.addEventListener('beforeunload', e => { if (dirty || busy) { e.preventDefault(); e.returnValue = ''; } });
  document.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); } if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('file-search').focus(); } });
  if (!window.require) { message('The editor could not load. Refresh the page to retry.'); return; }
  window.require.config({ paths: { vs: new URL('/vendor/monaco/vs', location.origin).href } });
  window.require(['vs/editor/editor.main'], () => {
    monaco.editor.defineTheme('ticket-dark', { base: 'vs-dark', inherit: true, rules: [], colors: { 'editor.background': '#101217', 'editor.lineHighlightBackground': '#1b1e26', 'editorLineNumber.foreground': '#4e5768', 'editorLineNumber.activeForeground': '#afa0cc', 'editor.selectionBackground': '#55427566', 'diffEditor.insertedTextBackground': '#37946925', 'diffEditor.removedTextBackground': '#ba526625', 'diffEditor.insertedLineBackground': '#2b6b4218', 'diffEditor.removedLineBackground': '#a3434918' } });
    const split = document.createElement('div'); split.id = 'split-host'; const edit = document.createElement('div'); edit.id = 'edit-host'; edit.hidden = true;
    for (const el of [split, edit]) { el.style.cssText = 'position:absolute;inset:0'; $('editor').append(el); }
    const options = { theme: 'ticket-dark', fontFamily: "'JetBrains Mono', monospace", fontSize: 12, lineHeight: 21, padding: { top: 18 }, minimap: { enabled: false }, smoothScrolling: true, scrollBeyondLastLine: false, automaticLayout: true, readOnly: true, bracketPairColorization: { enabled: true }, quickSuggestions: true, wordBasedSuggestions: 'currentDocument', renderWhitespace: 'selection' };
    diffEditor = monaco.editor.createDiffEditor(split, { ...options, renderSideBySide: true, originalEditable: false }); editor = monaco.editor.create(edit, options);
    for (const ed of [editor, diffEditor.getModifiedEditor()]) ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, save);
    refresh(true);
  }, () => message('The editor could not load. Refresh the page to retry.'));
})();
