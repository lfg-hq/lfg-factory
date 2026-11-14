// Whiteboard panels: toolbar, the style bar that follows the selection, comments, and the chat
// with the agent. The canvas itself is whiteboard.js; this file drives it through window.LFGBoard.
(function () {
  'use strict';
  const B = window.LFGBoard;
  const root = document.getElementById('wb');
  if (!B || !root) return;
  const $ = function (id) { return document.getElementById(id); };
  const guest = root.dataset.guest === 'true';
  // Someone who opened the board by its link has no account, so they say who they are (kept in this browser).
  let userName = root.dataset.user || (guest && localStorage.getItem('lfg-wb-guest')) || (guest ? 'Guest' : 'Someone');
  const canChat = root.dataset.canChat === 'true';
  const SHAPES = { rect: 'far fa-square', ellipse: 'far fa-circle', diamond: 'far fa-square wb-rot45', triangle: 'fas fa-play fa-rotate-270' };
  const INKS = ['auto', '#0f172a', '#64748b', '#ffffff', '#ef4444', '#f97316', '#f59e0b', '#22c55e', '#14b8a6', '#3b82f6', '#7c3aed', '#ec4899'];
  const FILLS = ['transparent', '#ffffff', '#e2e8f0', '#fca5a5', '#fdba74', '#fde68a', '#86efac', '#5eead4', '#93c5fd', '#c4b5fd', '#f9a8d4', '#0f172a'];
  const NOTES = ['#fde68a', '#fdba74', '#fca5a5', '#f9a8d4', '#c4b5fd', '#93c5fd', '#5eead4', '#86efac', '#e2e8f0', '#ffffff'];
  const HIGHLIGHTS = ['#fde047', '#86efac', '#93c5fd', '#f9a8d4', '#fdba74'];
  const FONT_STEPS = [10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64, 80, 96, 128];

  function el(tag, attrs, text) {
    const node = document.createElement(tag);
    for (const key in attrs || {}) node.setAttribute(key, attrs[key]);
    if (text != null) node.textContent = text;
    return node;
  }
  function escapeHtml(text) { return String(text).replace(/[&<>"]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]; }); }

  // ── Toast ──────────────────────────────────────────────────────────
  let toastTimer = null;
  function toast(text) {
    const node = $('wb-toast'); node.textContent = text; node.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { node.hidden = true; }, 4200);
  }
  B.on('error', toast);

  // ── Toolbar ────────────────────────────────────────────────────────
  const tools = $('wb-tools'), shapeMenu = $('wb-shapes'), shapeButton = $('wb-shape-btn');
  let lastShape = 'rect';
  tools.addEventListener('click', function (event) {
    const button = event.target.closest('button'); if (!button) return;
    if (button === shapeButton) { if (B.getTool() === lastShape) shapeMenu.hidden = !shapeMenu.hidden; else { B.setTool(lastShape); shapeMenu.hidden = false; } return; }
    if (button.id === 'wb-image-btn') { $('wb-image-input').click(); return; }
    if (button.dataset.tool) { B.setTool(button.dataset.tool); shapeMenu.hidden = true; }
  });
  shapeMenu.addEventListener('click', function (event) {
    const button = event.target.closest('button[data-tool]'); if (!button) return;
    B.setTool(button.dataset.tool); shapeMenu.hidden = true;
  });
  $('wb-image-input').addEventListener('change', function () { Array.from(this.files || []).forEach(function (file) { B.importImage(file); }); this.value = ''; });
  B.on('tool', function (tool) {
    if (SHAPES[tool]) { lastShape = tool; shapeButton.firstElementChild.className = SHAPES[tool]; }
    else shapeMenu.hidden = true;
    tools.querySelectorAll('button[data-tool]').forEach(function (b) { b.classList.toggle('active', b.dataset.tool === tool); });
    shapeButton.classList.toggle('active', !!SHAPES[tool]);
    shapeMenu.querySelectorAll('button').forEach(function (b) { b.classList.toggle('active', b.dataset.tool === tool); });
    refreshBar();
  });
  B.on('pointerdown', function () { shapeMenu.hidden = true; palette.hidden = true; $('wb-help').hidden = true; closeComment(); });

  // ── Top bar: title, status, undo, zoom ─────────────────────────────
  const title = $('wb-title'), status = $('wb-status');
  title.addEventListener('change', function () {
    B.request('', { method: 'PATCH', body: JSON.stringify({ title: title.value }) }).then(function (body) { title.value = body.title; document.title = body.title + ' — LFG'; }).catch(function (e) { toast(e.message); });
  });
  title.addEventListener('keydown', function (event) { if (event.key === 'Enter') title.blur(); });
  B.on('title', function (text) { if (document.activeElement !== title && title.value !== text) title.value = text; });
  B.on('status', function (state) {
    status.dataset.state = state;
    status.textContent = state === 'saving' ? 'Saving…' : state === 'error' ? 'Not saved, retrying…' : 'Saved';
  });
  if (!B.canEdit) { status.textContent = 'View only'; title.readOnly = true; }
  if (guest) title.readOnly = true;
  function refreshHistory() { $('wb-undo').disabled = !B.canUndo(); $('wb-redo').disabled = !B.canRedo(); }
  B.on('history', refreshHistory); refreshHistory();
  $('wb-undo').addEventListener('click', B.undo);
  $('wb-redo').addEventListener('click', B.redo);
  $('wb-export').addEventListener('click', function () { B.exportPng(title.value); });
  $('wb-help-btn').addEventListener('click', function () { $('wb-help').hidden = !$('wb-help').hidden; });
  const mid = function () { return [root.clientWidth / 2, root.clientHeight / 2]; };
  $('wb-zoom-in').addEventListener('click', function () { const m = mid(); B.zoomAt(m[0], m[1], 1.25, true); });
  $('wb-zoom-out').addEventListener('click', function () { const m = mid(); B.zoomAt(m[0], m[1], 0.8, true); });
  $('wb-zoom-level').addEventListener('click', function () { const m = mid(); B.zoomAt(m[0], m[1], 1 / B.cam.z, true); });
  $('wb-zoom-fit').addEventListener('click', function () { B.fitAll(); });

  // ── Style bar ──────────────────────────────────────────────────────
  const bar = $('wb-bar'), palette = $('wb-palette');
  let barFrame = 0, paletteFor = null;
  function swatch(act, value, label) {
    const cls = 'wb-swatch' + (value === 'transparent' ? ' none' : value === 'auto' ? ' auto' : '');
    return '<button type="button" class="' + cls + '" data-act="' + act + '" title="' + label + '" aria-label="' + label + '" style="--c:' + (value === 'transparent' || value === 'auto' ? 'transparent' : value) + '"></button>';
  }
  function icon(act, cls, label, on) { return '<button type="button" class="wb-ib' + (on ? ' active' : '') + '" data-act="' + act + '" title="' + label + '" aria-label="' + label + '"><i class="' + cls + '"></i></button>'; }
  function widths(current, options) {
    return '<span class="wb-seg">' + options.map(function (w, i) {
      return '<button type="button" class="wb-ib' + (current === w ? ' active' : '') + '" data-act="width" data-value="' + w + '" title="' + ['Thin', 'Medium', 'Thick'][i] + ' line"><span class="wb-line" style="height:' + (i * 2 + 1.5) + 'px"></span></button>';
    }).join('') + '</span>';
  }
  const SEP = '<span class="wb-sep"></span>';

  function barModel() {
    const tool = B.getTool(), s = B.style;
    if (!B.canEdit) return null;
    if (tool === 'pen') return { dock: true, html: swatch('pen', s.pen, 'Pen colour') + widths(s.penSize, [2, 4, 8]) };
    if (tool === 'highlighter') return { dock: true, html: swatch('hl', s.hl, 'Highlighter colour') + widths(s.hlSize, [12, 18, 28]) };
    if (tool === 'sticky') return { dock: true, html: swatch('sticky', s.sticky, 'Note colour') + '<span class="wb-hint">Click anywhere to drop a note</span>' };
    if (SHAPES[tool]) return { dock: true, html: swatch('dfill', s.fill, 'Fill') + swatch('dstroke', s.stroke, 'Outline') + widths(s.sw, [2, 4, 8]) + '<span class="wb-hint">Drag to draw, or click</span>' };
    if (tool === 'line' || tool === 'arrow') return { dock: true, html: swatch('dstroke', s.stroke, 'Line colour') + widths(s.sw, [2, 4, 8]) + '<span class="wb-hint">Start on a shape to connect it</span>' };
    if (tool === 'comment') return { dock: true, html: '<span class="wb-hint">Click anywhere, or on an element, to leave a comment</span>' };
    if (tool !== 'select' || !B.selection.size || B.isDragging() || B.isEditing()) return null;
    const list = B.selectedList();
    if (list.length === 1 && list[0].type === 'comment') return null;
    const has = {}; list.forEach(function (e) { has[e.type] = true; });
    const first = list[0], box = has.rect || has.ellipse || has.diamond || has.triangle;
    let html = '';
    if (box || has.sticky || has.frame) html += swatch('fill', (list.find(function (e) { return e.fill; }) || {}).fill || 'transparent', 'Fill');
    if (box || has.line || has.arrow || has.pen) html += swatch('stroke', (list.find(function (e) { return e.stroke; }) || {}).stroke || 'auto', has.pen || has.line || has.arrow ? 'Line colour' : 'Outline');
    if (has.text || box) html += swatch('color', (list.find(function (e) { return e.color; }) || {}).color || 'auto', 'Text colour');
    if (box || has.line || has.arrow) {
      const sw = (list.find(function (e) { return e.sw; }) || {}).sw;
      html += widths(sw <= 2 ? 2 : sw <= 4 ? 4 : 8, [2, 4, 8]) + icon('dash', 'fas fa-ellipsis', 'Dashed', list.some(function (e) { return e.dash; }));
    }
    if (box || has.sticky || has.text) {
      const size = Math.round((list.find(function (e) { return e.fontSize; }) || {}).fontSize || 16), align = first.align || (first.type === 'text' ? 'left' : 'center');
      html += SEP + icon('font-', 'fas fa-minus', 'Smaller text') + '<span class="wb-num">' + size + '</span>' + icon('font+', 'fas fa-plus', 'Larger text') +
        icon('bold', 'fas fa-bold', 'Bold', list.some(function (e) { return e.bold; })) +
        icon('align', 'fas fa-align-' + align, 'Text alignment');
    }
    html += SEP + icon('front', 'fas fa-arrow-up', 'Bring to front  ]') + icon('back', 'fas fa-arrow-down', 'Send to back  [') + icon('duplicate', 'far fa-clone', 'Duplicate') +
      icon('comment', 'far fa-comment', 'Comment on this');
    if (canChat) html += '<button type="button" class="wb-ask-inline" data-act="ask"><i class="fas fa-magic"></i> Ask LFG</button>';
    html += icon('delete', 'far fa-trash-alt', 'Delete');
    return { dock: false, html: html, box: B.unionBox(list) };
  }
  let barHtml = '';
  function refreshBar() { if (!barFrame) barFrame = requestAnimationFrame(function () { barFrame = 0; renderBar(); }); }
  function renderBar() {
    const model = barModel();
    if (!model) { bar.hidden = true; palette.hidden = true; barHtml = ''; return; }
    if (model.html !== barHtml) { bar.innerHTML = model.html; barHtml = model.html; }
    bar.hidden = false;
    bar.classList.toggle('docked', model.dock);
    if (model.dock) { bar.style.left = '50%'; bar.style.top = '64px'; bar.style.transform = 'translateX(-50%)'; return; }
    const a = B.toScreen(model.box.x, model.box.y), w = model.box.w * B.cam.z, h = model.box.h * B.cam.z;
    // A selection that has scrolled out of view takes its bar with it.
    if (a.x + w < 0 || a.y + h < 0 || a.x > root.clientWidth || a.y > root.clientHeight) { bar.hidden = true; palette.hidden = true; return; }
    const bw = bar.offsetWidth, bh = bar.offsetHeight;
    let top = a.y - bh - 18;
    if (top < 60) top = Math.min(root.clientHeight - bh - 12, a.y + h + 18);
    const left = Math.max(70, Math.min(root.clientWidth - bw - 12, a.x + w / 2 - bw / 2));
    bar.style.transform = 'none'; bar.style.left = left + 'px'; bar.style.top = top + 'px';
    if (!palette.hidden) placePalette();
  }
  ['selection', 'camera', 'moving', 'editing', 'change', 'history'].forEach(function (name) { B.on(name, refreshBar); });
  root.addEventListener('pointerup', refreshBar, true);

  function placePalette() {
    const anchor = bar.querySelector('[data-act="' + paletteFor + '"]'); if (!anchor) { palette.hidden = true; return; }
    const r = anchor.getBoundingClientRect(), base = root.getBoundingClientRect();
    palette.style.left = Math.max(8, Math.min(root.clientWidth - palette.offsetWidth - 8, r.left - base.left - 8)) + 'px';
    palette.style.top = r.bottom - base.top + 10 + 'px';
  }
  function openPalette(act) {
    if (!palette.hidden && paletteFor === act) { palette.hidden = true; return; }
    paletteFor = act;
    const colours = act === 'sticky' ? NOTES : act === 'hl' ? HIGHLIGHTS : act === 'fill' || act === 'dfill' ? (isNoteSelection() && act === 'fill' ? NOTES : FILLS) : INKS;
    palette.innerHTML = colours.map(function (c) {
      return '<button type="button" class="wb-swatch' + (c === 'transparent' ? ' none' : c === 'auto' ? ' auto' : '') + '" data-colour="' + c + '" title="' + (c === 'transparent' ? 'No fill' : c === 'auto' ? 'Default' : c) + '" style="--c:' + (c === 'transparent' || c === 'auto' ? 'transparent' : c) + '"></button>';
    }).join('');
    palette.hidden = false; placePalette();
  }
  function isNoteSelection() { const list = B.selectedList(); return list.length > 0 && list.every(function (e) { return e.type === 'sticky'; }); }
  palette.addEventListener('click', function (event) {
    const button = event.target.closest('[data-colour]'); if (!button) return;
    const c = button.dataset.colour;
    if (paletteFor === 'pen') B.setStyle({ pen: c });
    else if (paletteFor === 'hl') B.setStyle({ hl: c });
    else if (paletteFor === 'sticky') B.setStyle({ sticky: c });
    else if (paletteFor === 'dfill') B.setStyle({ fill: c });
    else if (paletteFor === 'dstroke') B.setStyle({ stroke: c });
    else if (paletteFor === 'fill') { B.setProps({ fill: c }); if (isNoteSelection()) B.setStyle({ sticky: c }); else B.setStyle({ fill: c }); }
    else if (paletteFor === 'stroke') { B.setProps({ stroke: c }); B.setStyle({ stroke: c }); }
    else if (paletteFor === 'color') B.setProps({ color: c });
    palette.hidden = true; refreshBar();
  });
  bar.addEventListener('click', function (event) {
    const button = event.target.closest('[data-act]'); if (!button) return;
    const act = button.dataset.act, tool = B.getTool(), list = B.selectedList();
    if (['fill', 'stroke', 'color', 'pen', 'hl', 'sticky', 'dfill', 'dstroke'].indexOf(act) >= 0) { openPalette(act); return; }
    palette.hidden = true;
    if (act === 'width') {
      const value = Number(button.dataset.value);
      if (tool === 'pen') B.setStyle({ penSize: value }); else if (tool === 'highlighter') B.setStyle({ hlSize: value });
      else { B.setStyle({ sw: value }); if (tool === 'select') B.setProps({ sw: value }); }
    }
    else if (act === 'dash') B.setProps({ dash: !list.some(function (e) { return e.dash; }) });
    else if (act === 'bold') B.setProps({ bold: !list.some(function (e) { return e.bold; }) });
    else if (act === 'align') { const now = list[0].align || (list[0].type === 'text' ? 'left' : 'center'); B.setProps({ align: now === 'left' ? 'center' : now === 'center' ? 'right' : 'left' }); }
    else if (act === 'font+' || act === 'font-') {
      const now = Math.round((list.find(function (e) { return e.fontSize; }) || {}).fontSize || 16);
      const next = act === 'font+' ? FONT_STEPS.find(function (s) { return s > now; }) || now : FONT_STEPS.slice().reverse().find(function (s) { return s < now; }) || now;
      B.setProps({ fontSize: next }); B.setStyle({ fontSize: next });
    }
    else if (act === 'front') B.restack(true);
    else if (act === 'back') B.restack(false);
    else if (act === 'duplicate') B.duplicateSelection();
    else if (act === 'delete') B.deleteSelection();
    else if (act === 'comment') { const box = B.unionBox(list); newComment({ x: box.x + box.w, y: box.y, target: list.length === 1 ? list[0] : null }); }
    else if (act === 'ask') openChat(true);
    barHtml = ''; refreshBar();
  });

  // ── Comments ───────────────────────────────────────────────────────
  const commentBox = $('wb-comment');
  let openId = null, draft = null;
  function when(at) { const d = new Date(at); return isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  function closeComment() { openId = null; draft = null; commentBox.hidden = true; }
  function newComment(at) {
    if (!B.canEdit) return;
    draft = at; openId = null; renderComment(); commentBox.querySelector('textarea').focus();
  }
  function renderComment() {
    const e = openId && B.els.get(openId);
    if (!e && !draft) { closeComment(); return; }
    commentBox.textContent = '';
    const thread = el('div', { 'class': 'wb-thread' });
    ((e && e.thread) || []).forEach(function (entry) {
      const item = el('div', { 'class': 'wb-thread-item' });
      const head = el('div', { 'class': 'wb-thread-head' }); head.appendChild(el('b', null, entry.author)); head.appendChild(el('span', null, when(entry.at)));
      item.appendChild(head); item.appendChild(el('p', null, entry.text)); thread.appendChild(item);
    });
    if (e && e.resolved) thread.appendChild(el('div', { 'class': 'wb-resolved' }, 'Resolved'));
    commentBox.appendChild(thread);
    if (B.canEdit) {
      const form = el('form', { 'class': 'wb-comment-form' });
      form.appendChild(el('textarea', { rows: '2', placeholder: e ? 'Reply…' : 'Write a comment…', 'aria-label': 'Comment' }));
      const row = el('div', { 'class': 'wb-comment-actions' });
      if (e) {
        row.appendChild(el('button', { type: 'button', 'class': 'wb-link', 'data-c': 'resolve' }, e.resolved ? 'Reopen' : 'Resolve'));
        row.appendChild(el('button', { type: 'button', 'class': 'wb-link', 'data-c': 'delete' }, 'Delete'));
        if (canChat) row.appendChild(el('button', { type: 'button', 'class': 'wb-link', 'data-c': 'ask' }, 'Ask LFG'));
      }
      row.appendChild(el('button', { type: 'submit', 'class': 'wb-primary' }, e ? 'Reply' : 'Comment'));
      form.appendChild(row); commentBox.appendChild(form);
    }
    commentBox.hidden = false; placeComment();
  }
  function placeComment() {
    if (commentBox.hidden) return;
    const e = openId && B.els.get(openId);
    if (openId && !e) { closeComment(); return; }
    const p = e ? B.commentPos(e) : draft, s = B.toScreen(p.x, p.y);
    commentBox.style.left = Math.max(70, Math.min(root.clientWidth - commentBox.offsetWidth - 12, s.x + 22)) + 'px';
    commentBox.style.top = Math.max(60, Math.min(root.clientHeight - commentBox.offsetHeight - 12, s.y - 30)) + 'px';
  }
  function submitComment() {
    const field = commentBox.querySelector('textarea'), text = field.value.trim(); if (!text) return;
    const entry = { id: B.uid(), author: userName, text: text, at: Date.now() };
    if (openId) { const e = B.els.get(openId); B.change([e.id], function () { e.thread = (e.thread || []).concat([entry]); delete e.resolved; }); }
    else {
      const e = { id: B.uid(), type: 'comment', x: draft.x, y: draft.y, author: userName, thread: [entry], z: B.nextZ() };
      if (draft.target) { const b = B.bbox(draft.target); e.attach = draft.target.id; e.ax = draft.x - b.x; e.ay = draft.y - b.y; }
      B.change([e.id], function () { B.put(e); }); openId = e.id; draft = null;
    }
    renderComment(); B.invalidate();
  }
  commentBox.addEventListener('submit', function (event) { event.preventDefault(); submitComment(); });
  commentBox.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey && event.target.tagName === 'TEXTAREA') { event.preventDefault(); submitComment(); }
    if (event.key === 'Escape') closeComment();
  });
  commentBox.addEventListener('click', function (event) {
    const act = event.target.getAttribute('data-c'), e = openId && B.els.get(openId); if (!act || !e) return;
    if (act === 'resolve') { B.change([e.id], function () { if (e.resolved) delete e.resolved; else e.resolved = true; }); renderComment(); B.invalidate(); }
    else if (act === 'delete') { B.change([e.id], function () { B.remove(e.id); }); closeComment(); }
    else if (act === 'ask') {
      const last = (e.thread || []).slice(-1)[0];
      B.select(e.attach ? [e.id, e.attach] : [e.id]); closeComment(); openChat(true);
      if (last && !chatInput.value) { chatInput.value = last.text; autoGrow(); }
    }
  });
  B.on('comment-new', newComment);
  B.on('comment-open', function (pin) { openId = pin.id; draft = null; renderComment(); });
  B.on('camera', placeComment); B.on('moving', placeComment);
  B.on('escape', function () { closeComment(); palette.hidden = true; shapeMenu.hidden = true; $('wb-help').hidden = true; });

  // ── Chat with the agent ────────────────────────────────────────────
  const chat = $('wb-chat'), chatLog = $('wb-chat-log'), chatInput = $('wb-chat-input'), chatSend = $('wb-chat-send'), chatContext = $('wb-chat-context');
  let streaming = null;
  function richText(node, text) {
    // Plain text with **bold** only; never markup from the model.
    node.innerHTML = escapeHtml(text).replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  }
  function bubble(role, text) {
    const empty = chatLog.querySelector('.wb-chat-empty'); if (empty) empty.hidden = true;
    const node = el('div', { 'class': 'wb-msg ' + role });
    const body = el('div', { 'class': 'wb-msg-body' }); richText(body, text || '');
    node.appendChild(body); chatLog.appendChild(node); chatLog.scrollTop = chatLog.scrollHeight;
    return node;
  }
  function autoGrow() { chatInput.style.height = 'auto'; chatInput.style.height = Math.min(140, chatInput.scrollHeight) + 'px'; }
  function refreshContext() {
    const n = B.selectedList().length;
    chatContext.hidden = !n;
    if (n) chatContext.firstElementChild.textContent = n === 1 ? 'Asking about the selected element' : 'Asking about ' + n + ' selected elements';
  }
  function openChat(focus) {
    if (!canChat) { toast('You can view this board, but the agent is not available to you here.'); return; }
    chat.hidden = false; $('wb-ask').classList.add('active'); refreshContext();
    requestAnimationFrame(function () { chat.classList.add('open'); if (focus) chatInput.focus(); });
  }
  function closeChat() { chat.classList.remove('open'); $('wb-ask').classList.remove('active'); setTimeout(function () { if (!chat.classList.contains('open')) chat.hidden = true; }, 180); }
  $('wb-ask').addEventListener('click', function () { if (chat.hidden) openChat(true); else closeChat(); });
  $('wb-chat-close').addEventListener('click', closeChat);
  $('wb-chat-clear').addEventListener('click', function () {
    if (streaming || !window.confirm('Clear this conversation? What is on the board stays.')) return;
    B.request('/messages', { method: 'DELETE' }).then(function () {
      chatLog.querySelectorAll('.wb-msg').forEach(function (n) { n.remove(); });
      chatLog.querySelector('.wb-chat-empty').hidden = false;
    }).catch(function (e) { toast(e.message); });
  });
  chatContext.querySelector('button').addEventListener('click', function () { B.select([]); });
  B.on('selection', refreshContext);
  chatLog.addEventListener('click', function (event) {
    const idea = event.target.closest('[data-idea]');
    if (idea) { chatInput.value = idea.dataset.idea; autoGrow(); chatInput.focus(); }
  });

  /** How much of the board's right side the chat window covers, so the view can keep clear of it. */
  function chatCover() {
    if (chat.hidden) return 0;
    const r = chat.getBoundingClientRect(), base = root.getBoundingClientRect();
    return r.left - base.left > root.clientWidth * 0.45 ? base.right - r.left + 12 : 0;
  }
  function setStreaming(state) {
    streaming = state; chat.classList.toggle('busy', !!state);
    chatSend.title = state ? 'Stop' : 'Send'; chatSend.firstElementChild.className = state ? 'fas fa-stop' : 'fas fa-arrow-up';
  }
  function ask(text) {
    if (streaming || !text.trim()) return;
    bubble('user', text);
    const node = bubble('assistant', ''), body = node.firstElementChild;
    body.classList.add('thinking');
    const abort = new AbortController(), added = [];
    let reply = '', failed = false;
    setStreaming(abort);
    function handle(event) {
      if (event.type === 'text') { reply += event.delta; body.classList.remove('thinking'); richText(body, reply.trim()); chatLog.scrollTop = chatLog.scrollHeight; }
      else if (event.type === 'ops') {
        B.removeRemote(event.deletes);
        B.applyRemote(event.upserts, null, true).forEach(function (id) { added.push(id); });
        // Follow the agent's work, unless the person is in the middle of something.
        const made = added.map(function (id) { return B.els.get(id); }).filter(Boolean);
        if (made.length && !B.isDragging() && !B.isEditing()) B.flyTo(B.unionBox(made), { pad: 110, dur: 650, maxZoom: 1, right: chatCover() });
      }
      else if (event.type === 'error') { failed = true; body.classList.remove('thinking'); node.classList.add('error'); richText(body, event.message); }
    }
    fetch(B.apiBase + '/chat', {
      method: 'POST', signal: abort.signal, headers: B.headers(),
      body: JSON.stringify({ message: text, selection: Array.from(B.selection), viewport: B.viewport() }),
    }).then(function (response) {
      if (!response.ok || !response.body) return response.json().catch(function () { return {}; }).then(function (b) { throw new Error(b.error || 'LFG could not answer just now.'); });
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = '';
      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) return;
          buffer += decoder.decode(chunk.value, { stream: true });
          const lines = buffer.split('\n'); buffer = lines.pop();
          lines.forEach(function (line) { if (line.trim()) { try { handle(JSON.parse(line)); } catch (e) { /* partial line */ } } });
          return pump();
        });
      }
      return pump();
    }).catch(function (error) {
      if (abort.signal.aborted) { if (!reply) richText(body, 'Stopped.'); return; }
      failed = true; node.classList.add('error'); richText(body, error.message || 'LFG could not answer just now.');
    }).then(function () {
      body.classList.remove('thinking'); setStreaming(null);
      if (!reply && !failed && !abort.signal.aborted) richText(body, added.length ? 'Done. Take a look at the board.' : 'I did not have anything to add.');
      const made = added.filter(function (id) { return B.els.has(id); });
      if (made.length && B.canEdit) {
        const undo = el('button', { type: 'button', 'class': 'wb-link' }, 'Remove what was added (' + made.length + ')');
        undo.addEventListener('click', function () { B.change(made, function () { made.forEach(B.remove); }); undo.remove(); });
        const show = el('button', { type: 'button', 'class': 'wb-link' }, 'Show on board');
        show.addEventListener('click', function () { const list = made.map(function (id) { return B.els.get(id); }).filter(Boolean); B.select(list.map(function (e) { return e.id; })); B.flyTo(B.unionBox(list), { pad: 110, right: chatCover() }); });
        const row = el('div', { 'class': 'wb-msg-actions' }); row.appendChild(show); row.appendChild(undo); node.appendChild(row);
      }
      chatLog.scrollTop = chatLog.scrollHeight;
    });
  }
  $('wb-chat-form').addEventListener('submit', function (event) {
    event.preventDefault();
    if (streaming) { streaming.abort(); return; }
    const text = chatInput.value; if (!text.trim()) return;
    chatInput.value = ''; autoGrow(); ask(text);
  });
  chatInput.addEventListener('input', autoGrow);
  chatInput.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('wb-chat-form').requestSubmit(); }
    if (event.key === 'Escape') { closeChat(); document.getElementById('wb-canvas').focus(); }
  });
  document.addEventListener('keydown', function (event) {
    const target = event.target, typing = target && (target.isContentEditable || /^(INPUT|TEXTAREA)$/.test(target.tagName));
    if ((event.key === '/' && !typing) || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k')) { event.preventDefault(); openChat(true); }
    if (event.key === '?' && !typing) $('wb-help').hidden = !$('wb-help').hidden;
  });

  // The chat window can be dragged by its header.
  (function () {
    const head = $('wb-chat-head'); let start = null;
    head.addEventListener('pointerdown', function (event) {
      if (event.target.closest('button')) return;
      const r = chat.getBoundingClientRect(), base = root.getBoundingClientRect();
      start = { x: event.clientX, y: event.clientY, left: r.left - base.left, top: r.top - base.top };
      head.setPointerCapture(event.pointerId);
    });
    head.addEventListener('pointermove', function (event) {
      if (!start) return;
      const left = Math.max(8, Math.min(root.clientWidth - 120, start.left + event.clientX - start.x)), top = Math.max(8, Math.min(root.clientHeight - 60, start.top + event.clientY - start.y));
      chat.style.left = left + 'px'; chat.style.top = top + 'px'; chat.style.right = 'auto'; chat.style.bottom = 'auto';
    });
    head.addEventListener('pointerup', function () { start = null; });
  })();

  B.on('camera', function () { $('wb-zoom-level').textContent = Math.round(B.cam.z * 100) + '%'; });
  B.on('ready', function (body) {
    root.classList.add('ready'); B.setTool(B.getTool());
    $('wb-zoom-level').textContent = Math.round(B.cam.z * 100) + '%';
    (body.messages || []).forEach(function (m) { bubble(m.role === 'assistant' ? 'assistant' : 'user', m.content); });
    $('wb-empty').hidden = body.elements.length > 0;
  });
  // ── Guests: a name for their comments ──────────────────────────────
  (function () {
    const card = $('wb-guest'); if (!card || !guest || !B.canEdit || root.dataset.user || localStorage.getItem('lfg-wb-guest')) return;
    const input = card.querySelector('input');
    card.hidden = false; input.focus();
    card.addEventListener('submit', function (event) {
      event.preventDefault();
      userName = input.value.trim().slice(0, 40) || 'Guest';
      localStorage.setItem('lfg-wb-guest', userName); B.setName(userName); card.hidden = true; document.getElementById('wb-canvas').focus();
    });
  })();

  // ── Who is here ────────────────────────────────────────────────────
  (function () {
    const box = $('wb-peers');
    B.on('peers', function (list) {
      box.textContent = '';
      list.slice(0, 6).forEach(function (p) {
        const chip = el('button', { type: 'button', 'class': 'wb-peer', title: p.name + (p.guest ? ' (guest)' : '') + ' · click to go to their cursor', 'data-peer': p.id, style: 'background:' + p.color }, (p.name[0] || '?').toUpperCase());
        box.appendChild(chip);
      });
      if (list.length > 6) box.appendChild(el('span', { 'class': 'wb-peer more', title: list.slice(6).map(function (p) { return p.name; }).join(', ') }, '+' + (list.length - 6)));
      box.hidden = !list.length;
    });
    box.addEventListener('click', function (event) { const chip = event.target.closest('[data-peer]'); if (chip) B.followPeer(chip.dataset.peer); });
    B.on('live', function (up) { root.classList.toggle('live', up); });
  })();

  // ── Model for the agent ────────────────────────────────────────────
  (function () {
    const picker = $('wb-chat-model'); if (!picker) return;
    let current = '';
    B.on('ready', function (body) {
      const models = body.models || [];
      if (!models.length) return;
      picker.textContent = '';
      if (!body.model) picker.appendChild(el('option', { value: '' }, 'Choose a model'));
      const groups = {};
      models.forEach(function (m) {
        const group = groups[m.provider] || (groups[m.provider] = picker.appendChild(el('optgroup', { label: m.provider })));
        group.appendChild(el('option', { value: m.key }, m.label));
      });
      current = body.model || ''; picker.value = current; picker.parentElement.hidden = false;
    });
    picker.addEventListener('change', function () {
      const wanted = picker.value; if (!wanted) return;
      picker.disabled = true;
      fetch('/api/settings/model', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modelKey: wanted, projectId: root.dataset.project }) })
        .then(function (response) { return response.json().catch(function () { return {}; }).then(function (body) { if (!response.ok) throw new Error(body.error || 'That model could not be selected.'); }); })
        .then(function () { current = wanted; const blank = picker.querySelector('option[value=""]'); if (blank) blank.remove(); })
        .catch(function (error) { picker.value = current; toast(error.message); })
        .then(function () { picker.disabled = false; });
    });
  })();

  // Someone else on the project asked the agent: show the exchange here too.
  B.on('chat', function (m) {
    const asked = bubble('user', m.message); asked.classList.add('other');
    asked.insertBefore(el('div', { 'class': 'wb-msg-who' }, m.name), asked.firstChild);
    bubble('assistant', m.reply);
  });

  // ── Share by link ──────────────────────────────────────────────────
  (function () {
    const button = $('wb-share-btn'), panel = $('wb-share'); if (!button || !panel) return;
    const mode = $('wb-share-mode'), row = $('wb-share-row'), link = $('wb-share-link'), copy = $('wb-share-copy'), note = $('wb-share-note');
    let current = 'off';
    function show(share) {
      current = share.mode || 'off'; mode.value = current; row.hidden = !share.token;
      link.value = share.token ? window.location.origin + '/board/' + share.token : '';
      button.classList.toggle('active', !!share.token);
      note.textContent = !share.token ? 'Only people on this project can open this board.'
        : share.mode === 'edit' ? 'Anyone with this link can draw, write and comment, with no account. They cannot use Ask LFG.'
        : 'Anyone with this link can look at this board, with no account. They cannot change it.';
    }
    B.on('ready', function (body) { if (body.share) { button.hidden = false; show(body.share); } });
    button.addEventListener('click', function () { panel.hidden = !panel.hidden; });
    B.on('pointerdown', function () { panel.hidden = true; });
    B.on('escape', function () { panel.hidden = true; });
    mode.addEventListener('change', function () {
      const wanted = mode.value === 'off' ? null : mode.value;
      if (!wanted && !window.confirm('Turn the link off? Anyone using it loses access, and the same link will not work again.')) { mode.value = current; return; }
      mode.disabled = true;
      B.request('/share', { method: 'PUT', body: JSON.stringify({ mode: wanted }) }).then(show).catch(function (e) { toast(e.message); })
        .then(function () { mode.disabled = false; });
    });
    copy.addEventListener('click', function () {
      link.select();
      const done = function () { copy.textContent = 'Copied'; setTimeout(function () { copy.textContent = 'Copy link'; }, 1600); };
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(link.value).then(done, function () { document.execCommand('copy'); done(); });
      else { document.execCommand('copy'); done(); }
    });
  })();

  B.on('change', function () { $('wb-empty').hidden = true; });
  B.on('tool', function (tool) { if (tool !== 'select') $('wb-empty').hidden = true; });
  $('wb-empty').addEventListener('click', function (event) {
    const idea = event.target.closest('[data-idea]'); if (!idea) return;
    openChat(true); chatInput.value = idea.dataset.idea; autoGrow();
  });
})();
