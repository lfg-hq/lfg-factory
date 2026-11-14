// Whiteboard canvas engine: what is on the board, drawing it, and every pointer and keyboard
// interaction. The panels around the canvas (style bar, comments, chat) live in whiteboard-ui.js
// and talk to this file through window.LFGBoard.
(function () {
  'use strict';
  const root = document.getElementById('wb');
  if (!root) return;
  const canvas = document.getElementById('wb-canvas');
  const ctx = canvas.getContext('2d');
  const editor = document.getElementById('wb-editor');
  const boardId = root.dataset.board;
  // A board opened by its link talks to the public API, with the link's secret in place of a session.
  const apiBase = root.dataset.api || '/api/whiteboards/' + boardId;
  const canEdit = root.dataset.canEdit === 'true';
  const FONT = 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const BOX_TYPES = { rect: 1, ellipse: 1, diamond: 1, triangle: 1 };
  const TEXT_TYPES = { rect: 1, ellipse: 1, diamond: 1, triangle: 1, sticky: 1, text: 1, frame: 1, line: 1, arrow: 1 };

  // ── State ──────────────────────────────────────────────────────────
  const els = new Map();
  const selection = new Set();
  const cam = { x: 0, y: 0, z: 1 };
  const listeners = {};
  let sorted = null;
  let tool = 'select';
  let drag = null;
  let hoverBind = null;
  let guides = [];
  let editing = null;
  let spaceDown = false;
  let needsDraw = true;
  let pointer = { sx: 0, sy: 0, inside: false };
  const style = Object.assign({ stroke: 'auto', fill: 'transparent', sw: 2, fontSize: 18, sticky: '#fde68a', pen: 'auto', penSize: 3, hl: '#fde047', hlSize: 18 },
    safeParse(localStorage.getItem('lfg-wb-style')));

  function safeParse(text) { try { return JSON.parse(text) || {}; } catch (e) { return {}; } }
  function emit(name, data) { (listeners[name] || []).forEach(function (fn) { fn(data); }); }
  function on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); }
  function uid() { return 'e' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
  function clone(e) { const c = {}; for (const k in e) if (k[0] !== '_') c[k] = Array.isArray(e[k]) ? e[k].map(function (v) { return v && typeof v === 'object' ? Object.assign({}, v) : v; }) : e[k]; return c; }
  function invalidate() { needsDraw = true; }
  function isLine(e) { return e.type === 'line' || e.type === 'arrow'; }
  function dark() { return document.documentElement.getAttribute('data-theme') !== 'light'; }
  function theme() {
    return dark()
      ? { bg: '#141518', dot: '#2c2e35', ink: '#e5e7eb', muted: '#9ca3af', frame: '#1d1f24', frameBorder: '#3a3d46', accent: '#a78bfa' }
      : { bg: '#f4f5f7', dot: '#d3d6dc', ink: '#1f2937', muted: '#6b7280', frame: '#ffffff', frameBorder: '#d5d9e0', accent: '#7c3aed' };
  }

  // ── Geometry ───────────────────────────────────────────────────────
  function toWorld(sx, sy) { return { x: sx / cam.z + cam.x, y: sy / cam.z + cam.y }; }
  function toScreen(x, y) { return { x: (x - cam.x) * cam.z, y: (y - cam.y) * cam.z }; }
  function center(e) { const b = bbox(e); return { x: b.x + b.w / 2, y: b.y + b.h / 2 }; }

  /** Where a connector meets the edge of the element it is attached to, heading toward `to`. */
  function edgePoint(target, to) {
    const c = center(target), hw = target.w / 2 + 6, hh = target.h / 2 + 6;
    const dx = to.x - c.x, dy = to.y - c.y;
    if (!dx && !dy) return c;
    let t;
    if (target.type === 'ellipse') t = 1 / Math.sqrt((dx * dx) / (hw * hw) + (dy * dy) / (hh * hh));
    else if (target.type === 'diamond') t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
    else t = Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9));
    return { x: c.x + dx * t, y: c.y + dy * t };
  }
  function lineEnds(e) {
    const a = e.from && els.get(e.from), b = e.to && els.get(e.to);
    let p1 = { x: e.x1, y: e.y1 }, p2 = { x: e.x2, y: e.y2 };
    const c1 = a ? center(a) : p1, c2 = b ? center(b) : p2;
    if (a) p1 = edgePoint(a, c2);
    if (b) p2 = edgePoint(b, c1);
    return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
  }
  function commentPos(e) {
    const t = e.attach && els.get(e.attach);
    if (t) { const b = bbox(t); return { x: b.x + (e.ax || 0), y: b.y + (e.ay || 0) }; }
    return { x: e.x, y: e.y };
  }
  function bbox(e) {
    if (isLine(e)) { const l = lineEnds(e); return { x: Math.min(l.x1, l.x2), y: Math.min(l.y1, l.y2), w: Math.abs(l.x2 - l.x1), h: Math.abs(l.y2 - l.y1) }; }
    if (e.type === 'comment') { const p = commentPos(e); return { x: p.x, y: p.y, w: 0, h: 0 }; }
    if (e._raw) return rawBox(e._raw);
    return { x: e.x, y: e.y, w: e.w || 0, h: e.h || 0 };
  }
  function rawBox(pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < pts.length; i += 2) { x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]); y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1]); }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  function unionBox(list) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    list.forEach(function (e) { const b = bbox(e); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); });
    return isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  }
  function segDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1, len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len)) : 0;
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }
  function insideShape(e, x, y, inset) {
    const w = e.w - inset * 2, h = e.h - inset * 2;
    if (w <= 0 || h <= 0) return false;
    const cx = e.x + e.w / 2, cy = e.y + e.h / 2, dx = Math.abs(x - cx), dy = Math.abs(y - cy);
    if (e.type === 'ellipse') return (dx * dx) / (w * w / 4) + (dy * dy) / (h * h / 4) <= 1;
    if (e.type === 'diamond') return dx / (w / 2) + dy / (h / 2) <= 1;
    if (e.type === 'triangle') { const ty = (y - (e.y + inset)) / h; return ty >= 0 && ty <= 1 && dx <= (w / 2) * ty; }
    return dx <= w / 2 && dy <= h / 2;
  }
  function hitElement(e, x, y, tol) {
    if (e.type === 'comment') return false;
    if (isLine(e)) { const l = lineEnds(e); return segDist(x, y, l.x1, l.y1, l.x2, l.y2) <= tol + (e.sw || 2) / 2; }
    const b = bbox(e);
    if (x < b.x - tol || y < b.y - tol || x > b.x + b.w + tol || y > b.y + b.h + tol) return false;
    if (e.type === 'pen') {
      const sx = e.w / (e.bw || 1), sy = e.h / (e.bh || 1), p = e.pts, reach = tol + (e.sw || 3) / 2;
      if (p.length === 2) return Math.hypot(x - e.x - p[0] * sx, y - e.y - p[1] * sy) <= reach + 2;
      for (let i = 0; i + 3 < p.length; i += 2) if (segDist(x, y, e.x + p[i] * sx, e.y + p[i + 1] * sy, e.x + p[i + 2] * sx, e.y + p[i + 3] * sy) <= reach) return true;
      return false;
    }
    if (e.type === 'frame') {
      // A frame is picked by its title or its edge, so you can still drag-select what is inside it.
      const title = y < b.y && y > b.y - 24 / cam.z && x >= b.x && x <= b.x + Math.max(60 / cam.z, b.w);
      return title || (insideShape(e, x, y, -tol) && !insideShape(e, x, y, tol));
    }
    if (BOX_TYPES[e.type]) {
      if (!insideShape(e, x, y, -tol)) return false;
      const hollow = (!e.fill || e.fill === 'transparent') && !e.text;
      return hollow ? !insideShape(e, x, y, tol + (e.sw || 2)) : true;
    }
    return true;
  }
  function order() {
    if (!sorted) sorted = Array.from(els.values()).sort(function (a, b) { return (b.type === 'frame') - (a.type === 'frame') || (a.z || 0) - (b.z || 0); });
    return sorted;
  }
  function hit(x, y, skip) {
    const list = order(), tol = 6 / cam.z;
    for (let i = list.length - 1; i >= 0; i--) if (list[i] !== skip && hitElement(list[i], x, y, tol)) return list[i];
    return null;
  }
  function hitComment(sx, sy) {
    let found = null;
    els.forEach(function (e) {
      if (e.type !== 'comment') return;
      const p = commentPos(e), s = toScreen(p.x, p.y);
      if (Math.hypot(sx - s.x, sy - (s.y - 14)) <= 16) found = e;
    });
    return found;
  }
  function bindable(x, y, self) {
    const list = order();
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (e === self || isLine(e) || e.type === 'pen' || e.type === 'comment' || e.type === 'frame') continue;
      if (x >= e.x && y >= e.y && x <= e.x + e.w && y <= e.y + e.h) return e;
    }
    return null;
  }

  // ── Text layout ────────────────────────────────────────────────────
  const layoutCache = new Map();
  function font(size, bold) { return (bold ? '600 ' : '') + size + 'px ' + FONT; }
  function wrap(text, size, bold, maxW) {
    const key = size + '|' + (bold ? 1 : 0) + '|' + Math.round(maxW) + '|' + text;
    let lines = layoutCache.get(key);
    if (lines) return lines;
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.font = font(size, bold);
    lines = [];
    String(text).split('\n').forEach(function (para) {
      let line = '';
      para.split(' ').forEach(function (word) {
        let candidate = line ? line + ' ' + word : word;
        if (ctx.measureText(candidate).width <= maxW || !line) {
          // A single word wider than the box is broken by character.
          while (ctx.measureText(candidate).width > maxW && candidate.length > 1) {
            let cut = candidate.length - 1;
            while (cut > 1 && ctx.measureText(candidate.slice(0, cut)).width > maxW) cut--;
            lines.push(candidate.slice(0, cut)); candidate = candidate.slice(cut);
          }
          line = candidate;
        } else { lines.push(line); line = word; }
      });
      lines.push(line);
    });
    ctx.restore();
    if (layoutCache.size > 3000) layoutCache.clear();
    layoutCache.set(key, lines);
    return lines;
  }
  function textWidth(text, size, bold) {
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.font = font(size, bold);
    let w = 0; String(text).split('\n').forEach(function (l) { w = Math.max(w, ctx.measureText(l).width); });
    ctx.restore(); return w;
  }
  /** The largest font size, up to the element's own, at which its text fits the box. */
  function fitSize(text, size, bold, w, h) {
    let s = size;
    while (s > 8 && wrap(text, s, bold, w).length * s * 1.3 > h) s = Math.max(8, Math.floor(s * 0.9));
    return s;
  }
  function luminance(hex) {
    const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})/i.exec(hex || '');
    if (!m) return 1;
    const h = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
    return (parseInt(h.slice(0, 2), 16) * 299 + parseInt(h.slice(2, 4), 16) * 587 + parseInt(h.slice(4, 6), 16) * 114) / 255000;
  }
  function textColour(e, t) {
    if (e.color && e.color !== 'auto') return e.color;
    const filled = e.fill && e.fill !== 'transparent' && e.fill !== 'auto' && e.type !== 'text';
    return filled ? (luminance(e.fill) > 0.55 ? '#1f2937' : '#f8fafc') : t.ink;
  }
  function textSpec(e) {
    const pad = e.type === 'text' ? 0 : e.type === 'sticky' ? 14 : Math.min(12, e.w / 6);
    let inner = { x: e.x + pad, y: e.y + pad, w: Math.max(4, e.w - pad * 2), h: Math.max(4, e.h - pad * 2) };
    if (e.type === 'triangle') inner = { x: e.x + e.w * 0.22, y: e.y + e.h * 0.45, w: e.w * 0.56, h: e.h * 0.5 };
    if (e.type === 'diamond' || e.type === 'ellipse') inner = { x: e.x + e.w * 0.16, y: e.y + e.h * 0.16, w: e.w * 0.68, h: e.h * 0.68 };
    const base = e.fontSize || 16;
    const size = e.type === 'text' ? base : fitSize(e.text || '', base, e.bold, inner.w, inner.h);
    return { box: inner, size: size, align: e.align || (e.type === 'text' ? 'left' : 'center'), valign: e.type === 'text' ? 'top' : 'middle' };
  }
  function drawText(c, e, t) {
    if (!e.text || editing === e.id) return;
    const spec = textSpec(e), lines = wrap(e.text, spec.size, e.bold, spec.box.w), lh = spec.size * 1.3;
    if (e.type === 'text') { const h = Math.max(lh, lines.length * lh); if (Math.abs(h - e.h) > 0.5) e.h = h; }
    c.font = font(spec.size, e.bold); c.fillStyle = textColour(e, t); c.textBaseline = 'middle'; c.textAlign = spec.align;
    const x = spec.align === 'left' ? spec.box.x : spec.align === 'right' ? spec.box.x + spec.box.w : spec.box.x + spec.box.w / 2;
    let y = spec.valign === 'top' ? spec.box.y + lh / 2 : spec.box.y + spec.box.h / 2 - ((lines.length - 1) * lh) / 2;
    for (let i = 0; i < lines.length; i++) { c.fillText(lines[i], x, y); y += lh; }
  }

  // ── Drawing ────────────────────────────────────────────────────────
  const images = new Map();
  function image(src) {
    let img = images.get(src);
    if (!img) { img = new Image(); img.onload = invalidate; img.src = src; images.set(src, img); }
    return img;
  }
  function roundRect(c, x, y, w, h, r) {
    r = Math.max(0, Math.min(r || 0, w / 2, h / 2));
    c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }
  function shapePath(c, e) {
    const x = e.x, y = e.y, w = e.w, h = e.h;
    if (e.type === 'ellipse') { c.beginPath(); c.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2); }
    else if (e.type === 'diamond') { c.beginPath(); c.moveTo(x + w / 2, y); c.lineTo(x + w, y + h / 2); c.lineTo(x + w / 2, y + h); c.lineTo(x, y + h / 2); c.closePath(); }
    else if (e.type === 'triangle') { c.beginPath(); c.moveTo(x + w / 2, y); c.lineTo(x + w, y + h); c.lineTo(x, y + h); c.closePath(); }
    else roundRect(c, x, y, w, h, e.radius || 0);
  }
  function paint(value, t) { return value === 'auto' || !value ? t.ink : value; }
  function penPath(c, pts, ox, oy, sx, sy) {
    c.beginPath(); c.moveTo(ox + pts[0] * sx, oy + pts[1] * sy);
    for (let i = 2; i + 3 < pts.length; i += 2) {
      const x = ox + pts[i] * sx, y = oy + pts[i + 1] * sy, nx = ox + pts[i + 2] * sx, ny = oy + pts[i + 3] * sy;
      c.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
    }
    if (pts.length >= 4) c.lineTo(ox + pts[pts.length - 2] * sx, oy + pts[pts.length - 1] * sy);
  }
  function drawElement(c, e, t, zoom, now) {
    if (e.type === 'comment') return;
    c.save();
    let alpha = e.opacity == null ? 1 : e.opacity;
    if (e._born) {
      // New elements ease in: a short fade and a slight grow from their centre.
      const p = Math.min(1, (now - e._born) / 380);
      if (p >= 1) delete e._born;
      else {
        const k = 1 - Math.pow(1 - p, 3), b = bbox(e), cx = b.x + b.w / 2, cy = b.y + b.h / 2, s = 0.86 + 0.14 * k;
        alpha *= k; c.translate(cx, cy); c.scale(s, s); c.translate(-cx, -cy); needsDraw = true;
      }
    }
    if (e._fade) alpha *= 0.25;
    c.globalAlpha = alpha;
    c.lineJoin = 'round'; c.lineCap = 'round';
    if (e.type === 'frame') {
      roundRect(c, e.x, e.y, e.w, e.h, 4);
      c.fillStyle = !e.fill || e.fill === 'auto' ? t.frame : e.fill; c.fill();
      c.lineWidth = 1 / zoom; c.strokeStyle = t.frameBorder; c.stroke();
      if (editing !== e.id) {
        const size = 13 / zoom; c.font = font(size, true); c.fillStyle = t.muted; c.textBaseline = 'bottom'; c.textAlign = 'left';
        c.fillText(e.text || 'Frame', e.x, e.y - 6 / zoom);
      }
    } else if (e.type === 'sticky') {
      c.shadowColor = 'rgba(0,0,0,0.22)'; c.shadowBlur = 14 * zoom; c.shadowOffsetY = 5 * zoom;
      roundRect(c, e.x, e.y, e.w, e.h, 3); c.fillStyle = e.fill || '#fde68a'; c.fill();
      c.shadowColor = 'transparent';
      drawText(c, e, t);
    } else if (BOX_TYPES[e.type]) {
      shapePath(c, e);
      if (e.fill && e.fill !== 'transparent') { c.fillStyle = paint(e.fill, t); c.fill(); }
      if ((e.sw == null ? 2 : e.sw) > 0 && e.stroke !== 'transparent') {
        c.lineWidth = e.sw == null ? 2 : e.sw; c.strokeStyle = paint(e.stroke, t);
        if (e.dash) c.setLineDash([c.lineWidth * 3, c.lineWidth * 2.5]);
        c.stroke(); c.setLineDash([]);
      }
      drawText(c, e, t);
    } else if (e.type === 'text') {
      drawText(c, e, t);
    } else if (isLine(e)) {
      const l = lineEnds(e), sw = e.sw || 2;
      c.strokeStyle = paint(e.stroke, t); c.lineWidth = sw;
      if (e.dash) c.setLineDash([sw * 3, sw * 2.5]);
      c.beginPath(); c.moveTo(l.x1, l.y1); c.lineTo(l.x2, l.y2); c.stroke(); c.setLineDash([]);
      if (e.type === 'arrow') {
        const a = Math.atan2(l.y2 - l.y1, l.x2 - l.x1), len = 9 + sw * 2.2;
        c.beginPath(); c.moveTo(l.x2 - len * Math.cos(a - 0.45), l.y2 - len * Math.sin(a - 0.45)); c.lineTo(l.x2, l.y2);
        c.lineTo(l.x2 - len * Math.cos(a + 0.45), l.y2 - len * Math.sin(a + 0.45)); c.stroke();
      }
      if (e.text && editing !== e.id) {
        const size = e.fontSize || 14, mx = (l.x1 + l.x2) / 2, my = (l.y1 + l.y2) / 2;
        c.font = font(size); const w = c.measureText(e.text).width + 12;
        c.fillStyle = t.bg; roundRect(c, mx - w / 2, my - size * 0.8, w, size * 1.6, 4); c.fill();
        c.fillStyle = t.ink; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(e.text, mx, my);
      }
    } else if (e.type === 'pen') {
      c.strokeStyle = paint(e.stroke, t); c.fillStyle = c.strokeStyle; c.lineWidth = e.sw || 3;
      if (e.hl) { c.globalAlpha = alpha * 0.4; c.lineCap = 'butt'; }
      const raw = e._raw, pts = raw || e.pts;
      if (pts.length === 2) { c.beginPath(); c.arc(raw ? pts[0] : e.x + pts[0], raw ? pts[1] : e.y + pts[1], c.lineWidth / 2, 0, Math.PI * 2); c.fill(); }
      else { if (raw) penPath(c, raw, 0, 0, 1, 1); else penPath(c, pts, e.x, e.y, e.w / (e.bw || 1), e.h / (e.bh || 1)); c.stroke(); }
    } else if (e.type === 'image') {
      const img = image(e.src);
      if (img.complete && img.naturalWidth) c.drawImage(img, e.x, e.y, e.w, e.h);
      else { c.fillStyle = t.dot; c.fillRect(e.x, e.y, e.w, e.h); }
    }
    c.restore();
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1, w = root.clientWidth, h = root.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    return { dpr: dpr, w: w, h: h };
  }
  function selectedList() { const out = []; selection.forEach(function (id) { const e = els.get(id); if (e) out.push(e); }); return out; }
  function handlePoints() {
    const list = selectedList();
    if (!list.length || !canEdit) return [];
    if (list.length === 1 && isLine(list[0])) {
      const l = lineEnds(list[0]), a = toScreen(l.x1, l.y1), b = toScreen(l.x2, l.y2);
      return [{ id: 'p1', x: a.x, y: a.y }, { id: 'p2', x: b.x, y: b.y }];
    }
    if (list.length === 1 && list[0].type === 'comment') return [];
    const box = unionBox(list), a = toScreen(box.x, box.y), w = box.w * cam.z, h = box.h * cam.z;
    const pts = [{ id: 'nw', x: a.x, y: a.y }, { id: 'ne', x: a.x + w, y: a.y }, { id: 'se', x: a.x + w, y: a.y + h }, { id: 'sw', x: a.x, y: a.y + h }];
    if (w > 44) pts.push({ id: 'n', x: a.x + w / 2, y: a.y }, { id: 's', x: a.x + w / 2, y: a.y + h });
    if (h > 44) pts.push({ id: 'e', x: a.x + w, y: a.y + h / 2 }, { id: 'w', x: a.x, y: a.y + h / 2 });
    return pts;
  }
  function draw(now) {
    const size = resize(), t = theme(), dpr = size.dpr, z = cam.z;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = t.bg; ctx.fillRect(0, 0, size.w, size.h);
    // Dot grid: the spacing doubles as you zoom out so the dots never crowd.
    let step = 24; while (step * z < 16) step *= 2;
    const gap = step * z, ox = ((-cam.x * z) % gap + gap) % gap, oy = ((-cam.y * z) % gap + gap) % gap, r = Math.max(1, Math.min(1.6, z));
    ctx.fillStyle = t.dot;
    for (let x = ox; x < size.w; x += gap) for (let y = oy; y < size.h; y += gap) ctx.fillRect(x - r / 2, y - r / 2, r, r);

    ctx.setTransform(dpr * z, 0, 0, dpr * z, -cam.x * z * dpr, -cam.y * z * dpr);
    const view = { x: cam.x - 40 / z, y: cam.y - 40 / z, w: size.w / z + 80 / z, h: size.h / z + 80 / z };
    const list = order();
    for (let i = 0; i < list.length; i++) {
      const e = list[i], b = bbox(e);
      if (b.x > view.x + view.w || b.y > view.y + view.h || b.x + b.w < view.x || b.y + b.h < view.y) continue;
      drawElement(ctx, e, t, z, now);
    }

    // Everything below is drawn in screen pixels so it stays crisp at any zoom.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 1.5; ctx.strokeStyle = t.accent;
    if (hoverBind) { const a = toScreen(hoverBind.x, hoverBind.y); ctx.strokeRect(a.x - 3, a.y - 3, hoverBind.w * z + 6, hoverBind.h * z + 6); }
    const picked = selectedList();
    picked.forEach(function (e) {
      if (e.type === 'comment') return;
      if (isLine(e)) return;
      const b = bbox(e), a = toScreen(b.x, b.y);
      ctx.strokeRect(a.x, a.y, b.w * z, b.h * z);
    });
    if (picked.length > 1) {
      const box = unionBox(picked), a = toScreen(box.x, box.y);
      ctx.setLineDash([4, 3]); ctx.strokeRect(a.x - 4, a.y - 4, box.w * z + 8, box.h * z + 8); ctx.setLineDash([]);
    }
    if (!drag || drag.kind === 'resize' || drag.kind === 'endpoint') {
      handlePoints().forEach(function (h) {
        ctx.fillStyle = '#ffffff'; ctx.beginPath();
        if (h.id[0] === 'p') ctx.arc(h.x, h.y, 5.5, 0, Math.PI * 2); else ctx.rect(h.x - 4.5, h.y - 4.5, 9, 9);
        ctx.fill(); ctx.stroke();
      });
    }
    ctx.lineWidth = 1; ctx.strokeStyle = '#f43f5e';
    guides.forEach(function (g) {
      ctx.beginPath();
      if (g.x != null) { const sx = (g.x - cam.x) * z; ctx.moveTo(sx, 0); ctx.lineTo(sx, size.h); } else { const sy = (g.y - cam.y) * z; ctx.moveTo(0, sy); ctx.lineTo(size.w, sy); }
      ctx.stroke();
    });
    if (drag && drag.kind === 'marquee') {
      const a = toScreen(drag.x0, drag.y0), b = toScreen(drag.x1, drag.y1);
      ctx.fillStyle = dark() ? 'rgba(167,139,250,0.12)' : 'rgba(124,58,237,0.08)'; ctx.strokeStyle = t.accent;
      ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y); ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    }
    // Comment pins keep one size on screen.
    els.forEach(function (e) {
      if (e.type !== 'comment') return;
      const p = commentPos(e), s = toScreen(p.x, p.y), on = selection.has(e.id);
      ctx.save(); ctx.globalAlpha = e.resolved ? 0.45 : 1; ctx.translate(s.x, s.y);
      ctx.shadowColor = 'rgba(0,0,0,0.3)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, -14, 14, Math.PI * 0.75, Math.PI * 2.25); ctx.closePath();
      ctx.fillStyle = e.resolved ? '#64748b' : on ? '#f59e0b' : '#7c3aed'; ctx.fill();
      ctx.shadowColor = 'transparent'; ctx.fillStyle = '#fff'; ctx.font = font(12, true); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const count = (e.thread || []).length;
      ctx.fillText(count > 1 ? String(count) : ((e.author || '?')[0] || '?').toUpperCase(), 0, -14);
      ctx.restore();
    });
    if (tool === 'eraser' && pointer.inside) { ctx.strokeStyle = t.muted; ctx.beginPath(); ctx.arc(pointer.sx, pointer.sy, 9, 0, Math.PI * 2); ctx.stroke(); }
  }

  // ── Camera ─────────────────────────────────────────────────────────
  let fly = null, zoomGoal = null;
  function clampZoom(z) { return Math.max(0.05, Math.min(8, z)); }
  function cameraMoved() { invalidate(); positionEditor(); emit('camera'); }
  function panBy(dx, dy) { fly = null; cam.x += dx / cam.z; cam.y += dy / cam.z; cameraMoved(); }
  /** Zoom keeping the board point under (sx, sy) where it is. Smooth zooms glide to the target. */
  function zoomAt(sx, sy, factor, smooth) {
    fly = null;
    const target = clampZoom((zoomGoal ? zoomGoal.z : cam.z) * factor);
    if (smooth) { zoomGoal = { z: target, sx: sx, sy: sy, w: toWorld(sx, sy) }; invalidate(); return; }
    const w = toWorld(sx, sy); zoomGoal = null; cam.z = target; cam.x = w.x - sx / cam.z; cam.y = w.y - sy / cam.z; cameraMoved();
  }
  function flyTo(box, opts) {
    if (!box) return;
    opts = opts || {};
    // `right` keeps that many pixels on the right clear, for a panel that is covering the board there.
    const pad = opts.pad == null ? 90 : opts.pad, w = Math.max(240, root.clientWidth - (opts.right || 0)), h = root.clientHeight;
    const z = clampZoom(Math.min((w - pad * 2) / Math.max(box.w, 1), (h - pad * 2) / Math.max(box.h, 1), opts.maxZoom || 1.25));
    const to = { z: z, x: box.x + box.w / 2 - w / 2 / z, y: box.y + box.h / 2 - h / 2 / z };
    zoomGoal = null;
    if (opts.instant) { cam.x = to.x; cam.y = to.y; cam.z = to.z; fly = null; cameraMoved(); return; }
    fly = { from: { x: cam.x, y: cam.y, z: cam.z }, to: to, w: w, t0: performance.now(), dur: opts.dur || 520 }; invalidate();
  }
  function fitAll(opts) {
    const box = unionBox(Array.from(els.values()));
    if (box) flyTo(box, opts); else if (opts && opts.instant) { cam.x = -root.clientWidth / 2; cam.y = -root.clientHeight / 2; cam.z = 1; cameraMoved(); }
  }
  function stepCamera(now) {
    if (fly) {
      const p = Math.min(1, (now - fly.t0) / fly.dur), k = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      // Zoom moves along a log scale and the centre of the view glides between the two framings.
      const w = fly.w, h = root.clientHeight, z = Math.exp(Math.log(fly.from.z) + (Math.log(fly.to.z) - Math.log(fly.from.z)) * k);
      const c0x = fly.from.x + w / 2 / fly.from.z, c0y = fly.from.y + h / 2 / fly.from.z, c1x = fly.to.x + w / 2 / fly.to.z, c1y = fly.to.y + h / 2 / fly.to.z;
      cam.z = z; cam.x = c0x + (c1x - c0x) * k - w / 2 / z; cam.y = c0y + (c1y - c0y) * k - h / 2 / z;
      if (p >= 1) fly = null;
      cameraMoved();
    } else if (zoomGoal) {
      const next = Math.abs(zoomGoal.z - cam.z) < cam.z * 0.004 ? zoomGoal.z : cam.z + (zoomGoal.z - cam.z) * 0.3;
      cam.z = next; cam.x = zoomGoal.w.x - zoomGoal.sx / next; cam.y = zoomGoal.w.y - zoomGoal.sy / next;
      if (next === zoomGoal.z) zoomGoal = null;
      cameraMoved();
    }
  }
  function frameLoop(now) {
    stepCamera(now);
    if (needsDraw) { needsDraw = false; draw(now); }
    requestAnimationFrame(frameLoop);
  }

  // ── Changes, undo and saving ───────────────────────────────────────
  const dirty = new Set(), removed = new Set(), inflight = new Set();
  let version = 0, mutations = 0, saveTimer = null, saving = false, pending = null;
  const undoStack = [], redoStack = [];

  function structureChanged() { sorted = null; invalidate(); }
  function touch(id) { if (!canEdit) return; removed.delete(id); dirty.add(id); mutations++; scheduleSave(); invalidate(); }
  function put(e) { els.set(e.id, e); structureChanged(); touch(e.id); }
  function remove(id) {
    if (!els.delete(id)) return;
    selection.delete(id); dirty.delete(id); removed.add(id); mutations++; structureChanged(); scheduleSave();
  }
  function nextZ() { let z = 0; els.forEach(function (e) { z = Math.max(z, e.z || 0); }); return z + 1; }

  /** Start recording a change to these elements (ids that do not exist yet are recorded as new). */
  function begin(ids) { pending = new Map(); (ids || []).forEach(track); }
  function track(id) { if (pending && !pending.has(id)) pending.set(id, els.has(id) ? clone(els.get(id)) : null); }
  /** Finish the change: remember it for undo and queue it for saving. */
  function commit() {
    if (!pending) return;
    const before = pending, after = new Map(); pending = null;
    let changed = false;
    before.forEach(function (was, id) {
      const now = els.has(id) ? clone(els.get(id)) : null;
      after.set(id, now);
      if (JSON.stringify(was) !== JSON.stringify(now)) { changed = true; if (now) touch(id); }
    });
    if (!changed) return;
    undoStack.push({ before: before, after: after }); if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0; emit('history'); emit('change');
  }
  function restore(states) {
    states.forEach(function (state, id) {
      if (state) { els.set(id, clone(state)); touch(id); } else { remove(id); }
    });
    structureChanged(); pruneSelection(); emit('selection'); emit('change');
  }
  function undo() { const entry = undoStack.pop(); if (!entry) return; redoStack.push(entry); restore(entry.before); emit('history'); }
  function redo() { const entry = redoStack.pop(); if (!entry) return; undoStack.push(entry); restore(entry.after); emit('history'); }
  function pruneSelection() { selection.forEach(function (id) { if (!els.has(id)) selection.delete(id); }); }
  /** Make one recorded change: mutate(elements) may edit, add (put) or remove elements. */
  function change(ids, mutate) { begin(ids); mutate(); commit(); }

  function request(path, options) {
    return fetch(apiBase + path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, options || {})).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        if (!response.ok) throw new Error(body.error || 'That did not go through.');
        return body;
      });
    });
  }
  function scheduleSave() { if (!canEdit) return; emit('status', 'saving'); clearTimeout(saveTimer); saveTimer = setTimeout(save, 500); }
  function payload() {
    const upserts = [];
    dirty.forEach(function (id) { const e = els.get(id); if (e && !e._raw) { upserts.push(clone(e)); inflight.add(id); } });
    const deletes = Array.from(removed);
    upserts.forEach(function (e) { dirty.delete(e.id); }); removed.clear();
    return { upserts: upserts, deletes: deletes };
  }
  function save() {
    if (saving || (!dirty.size && !removed.size)) return;
    const body = payload();
    if (!body.upserts.length && !body.deletes.length) return;
    saving = true;
    request('/ops', { method: 'POST', body: JSON.stringify(body) }).then(function () {
      emit('status', dirty.size || removed.size ? 'saving' : 'saved');
    }).catch(function (error) {
      // Put the unsaved work back so the next attempt carries it.
      body.upserts.forEach(function (e) { if (els.has(e.id)) dirty.add(e.id); });
      body.deletes.forEach(function (id) { if (!els.has(id)) removed.add(id); });
      emit('status', 'error'); emit('error', error.message);
      clearTimeout(saveTimer); saveTimer = setTimeout(save, 4000);
    }).then(function () {
      saving = false; inflight.clear(); mutations++;
      if (dirty.size || removed.size) { clearTimeout(saveTimer); saveTimer = setTimeout(save, 300); }
    });
  }
  function flush() {
    if (!canEdit || (!dirty.size && !removed.size)) return;
    const body = payload();
    try { fetch(apiBase + '/ops', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); } catch (e) { /* leaving anyway */ }
  }
  function busyWith(id) { return dirty.has(id) || inflight.has(id) || editing === id || (drag && drag.ids && drag.ids.has(id)); }
  /** Take in elements that came from the server (someone else, or the agent). */
  function applyRemote(upserts, ids, animate) {
    const fresh = [];
    (upserts || []).forEach(function (e) {
      if (busyWith(e.id)) return;
      const old = els.get(e.id);
      if (old && old._born) e._born = old._born;
      if (!old && animate) e._born = performance.now();
      if (!old) fresh.push(e.id);
      els.set(e.id, e);
    });
    if (ids) {
      const keep = new Set(ids);
      Array.from(els.keys()).forEach(function (id) { if (!keep.has(id) && !busyWith(id)) { els.delete(id); selection.delete(id); } });
    }
    structureChanged(); emit('selection'); emit('change');
    return fresh;
  }
  function removeRemote(ids) { (ids || []).forEach(function (id) { if (!busyWith(id)) { els.delete(id); selection.delete(id); } }); structureChanged(); emit('selection'); }
  function poll() {
    if (document.hidden || saving || dirty.size || removed.size || drag) return;
    const seen = mutations;
    request('?since=' + version).then(function (body) {
      // Anything done here while the request was out makes the answer stale; the next poll asks again.
      if (seen !== mutations || saving || drag) return;
      if (body.title) emit('title', body.title);
      if (body.version === version) return;
      version = body.version;
      applyRemote(body.elements, body.ids, true);
    }).catch(function () { /* next poll retries */ });
  }

  // ── Creating elements ──────────────────────────────────────────────
  function setTool(next) {
    if (!canEdit && next !== 'select' && next !== 'hand') return;
    tool = next; hoverBind = null; invalidate();
    canvas.style.cursor = next === 'hand' ? 'grab' : next === 'select' ? 'default' : next === 'eraser' ? 'none' : next === 'text' ? 'text' : 'crosshair';
    emit('tool', next);
  }
  function select(ids, keep) {
    if (!keep) selection.clear();
    (ids || []).forEach(function (id) { if (els.has(id)) selection.add(id); });
    invalidate(); emit('selection');
  }
  function addSticky(x, y, text) {
    const e = { id: uid(), type: 'sticky', x: x - 100, y: y - 100, w: 200, h: 200, text: text || '', fill: style.sticky, fontSize: 20, z: nextZ() };
    change([e.id], function () { put(e); }); return e;
  }
  function addText(x, y, text) {
    const e = { id: uid(), type: 'text', x: x, y: y - style.fontSize * 0.65, w: 8, h: style.fontSize * 1.3, text: text || '', fontSize: style.fontSize, color: 'auto', z: nextZ() };
    if (text) e.w = Math.min(640, textWidth(text, e.fontSize) + 4);
    change([e.id], function () { put(e); }); return e;
  }
  function addImage(src, w, h, x, y) {
    const scale = Math.min(1, 480 / Math.max(w, h));
    const e = { id: uid(), type: 'image', src: src, w: w * scale, h: h * scale, z: nextZ() };
    e.x = x - e.w / 2; e.y = y - e.h / 2;
    change([e.id], function () { put(e); }); select([e.id]); return e;
  }
  function importImage(file, at) {
    if (!canEdit || !file || !/^image\//.test(file.type)) return;
    const reader = new FileReader();
    reader.onload = function () {
      const img = new Image();
      img.onload = function () {
        // Large pictures are scaled down so the board stays quick to load and save.
        let max = 1400, data = '';
        for (let attempt = 0; attempt < 4; attempt++) {
          const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
          const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          data = c.toDataURL(file.type === 'image/png' && attempt === 0 ? 'image/png' : 'image/jpeg', 0.85);
          if (data.length < 850000) break;
          max = Math.round(max * 0.7);
        }
        if (data.length >= 850000) { emit('error', 'That image is too large for the board.'); return; }
        const p = at || toWorld(root.clientWidth / 2, root.clientHeight / 2);
        addImage(data, img.naturalWidth, img.naturalHeight, p.x, p.y);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  // ── Text editing ───────────────────────────────────────────────────
  function editorBox(e) {
    if (isLine(e)) { const l = lineEnds(e), w = 160; return { x: (l.x1 + l.x2) / 2 - w / 2, y: (l.y1 + l.y2) / 2 - 14, w: w, h: 28, size: e.fontSize || 14, align: 'center', valign: 'middle' }; }
    if (e.type === 'frame') return { x: e.x, y: e.y - 26 / cam.z, w: Math.max(e.w, 160 / cam.z), h: 22 / cam.z, size: 13 / cam.z, align: 'left', valign: 'middle', bold: true };
    const spec = textSpec(e);
    return { x: spec.box.x, y: spec.box.y, w: e.type === 'text' ? Math.max(e.w, 40) : spec.box.w, h: spec.box.h, size: spec.size, align: spec.align, valign: spec.valign, bold: e.bold, grow: e.type === 'text' };
  }
  function positionEditor() {
    const e = editing && els.get(editing);
    if (!e) return;
    const b = editorBox(e), s = toScreen(b.x, b.y), t = theme();
    editor.style.left = s.x + 'px'; editor.style.top = s.y + 'px';
    editor.style.width = b.grow && !e._wide ? 'auto' : b.w * cam.z + 'px';
    editor.style.minWidth = b.grow ? Math.max(20, b.w * cam.z) + 'px' : '';
    editor.style.maxWidth = b.grow && !e._wide ? 640 * cam.z + 'px' : '';
    editor.style.height = b.grow ? 'auto' : b.h * cam.z + 'px';
    editor.style.fontSize = b.size * cam.z + 'px'; editor.style.fontWeight = b.bold ? '600' : '400';
    editor.style.textAlign = b.align; editor.style.justifyContent = b.valign === 'top' ? 'flex-start' : 'center';
    editor.style.color = e.type === 'frame' || isLine(e) ? t.ink : textColour(e, t);
  }
  function startEditing(e, selectAll) {
    if (!canEdit || !TEXT_TYPES[e.type]) return;
    stopEditing();
    editing = e.id; e._wide = e.type === 'text' && !!e.text && e.w > textWidth(e.text, e.fontSize, e.bold) + 12;
    select([e.id]);
    const field = editor.firstElementChild;
    field.textContent = e.text || '';
    editor.hidden = false; positionEditor(); invalidate();
    field.focus();
    const range = document.createRange(); range.selectNodeContents(field); if (!selectAll) range.collapse(false);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    emit('editing', true);
  }
  function stopEditing() {
    const e = editing && els.get(editing);
    if (!editing) return;
    const field = editor.firstElementChild, text = field.innerText.replace(/ /g, ' ').replace(/\n+$/, '');
    editing = null; editor.hidden = true;
    if (e) {
      const wide = e._wide; delete e._wide;
      if (e.type === 'text' && !text.trim()) { change([e.id], function () { remove(e.id); }); }
      else if ((e.text || '') !== text) {
        change([e.id], function () {
          e.text = text;
          if (e.type === 'text' && !wide) e.w = Math.min(640, textWidth(text, e.fontSize, e.bold) + 4);
        });
      }
    }
    invalidate(); emit('editing', false); emit('selection');
  }
  editor.firstElementChild.addEventListener('input', function () {
    const e = editing && els.get(editing);
    if (!e || e.type === 'text' || e.type === 'frame' || isLine(e)) return;
    // Notes and shapes shrink their text to fit as you type.
    const spec = textSpec(Object.assign({}, e, { text: this.innerText }));
    editor.style.fontSize = spec.size * cam.z + 'px';
  });
  editor.firstElementChild.addEventListener('blur', function () { setTimeout(function () { if (document.activeElement !== editor.firstElementChild) stopEditing(); }, 0); });
  editor.firstElementChild.addEventListener('keydown', function (event) {
    event.stopPropagation();
    const e = editing && els.get(editing);
    if (event.key === 'Escape' || (event.key === 'Enter' && (event.metaKey || event.ctrlKey || (e && (e.type === 'frame' || isLine(e)))))) { event.preventDefault(); stopEditing(); canvas.focus(); }
  });
  editor.firstElementChild.addEventListener('paste', function (event) {
    event.preventDefault(); event.stopPropagation();
    document.execCommand('insertText', false, (event.clipboardData || window.clipboardData).getData('text/plain'));
  });

  // ── Pointer interaction ────────────────────────────────────────────
  const touches = new Map();
  let pinch = null;
  function local(event) { const r = canvas.getBoundingClientRect(); return { sx: event.clientX - r.left, sy: event.clientY - r.top }; }
  function handleAt(sx, sy) {
    const pts = handlePoints();
    for (let i = 0; i < pts.length; i++) if (Math.abs(pts[i].x - sx) <= 8 && Math.abs(pts[i].y - sy) <= 8) return pts[i].id;
    return null;
  }
  const CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', p1: 'move', p2: 'move' };

  function startMove(event, w) {
    const ids = new Set(selection);
    // Moving a frame carries along what sits inside it.
    selectedList().forEach(function (f) {
      if (f.type !== 'frame') return;
      els.forEach(function (e) {
        if (e === f || e.type === 'frame' || e.type === 'comment') return;
        const c = center(e);
        if (c.x >= f.x && c.x <= f.x + f.w && c.y >= f.y && c.y <= f.y + f.h) ids.add(e.id);
      });
    });
    if (event.altKey) {
      // Alt-drag leaves the originals behind and moves a copy.
      const copies = duplicateElements(Array.from(ids).map(function (id) { return els.get(id); }), 0, 0, true);
      ids.clear(); copies.forEach(function (e) { ids.add(e.id); });
      select(copies.map(function (e) { return e.id; }));
    } else begin(Array.from(ids));
    const start = new Map(); ids.forEach(function (id) { const e = els.get(id); if (e) start.set(id, clone(e)); });
    const moving = Array.from(ids).map(function (id) { return els.get(id); }).filter(Boolean);
    drag = { kind: 'move', ids: ids, start: start, x0: w.x, y0: w.y, box: unionBox(moving.filter(function (e) { return e.type !== 'comment'; })), moved: false };
  }
  function snapMove(dx, dy, box) {
    guides = [];
    if (!box) return { dx: dx, dy: dy };
    const tol = 6 / cam.z, xs = [box.x + dx, box.x + dx + box.w / 2, box.x + dx + box.w], ys = [box.y + dy, box.y + dy + box.h / 2, box.y + dy + box.h];
    let bestX = null, bestY = null, n = 0;
    const view = { x: cam.x, y: cam.y, w: root.clientWidth / cam.z, h: root.clientHeight / cam.z };
    order().some(function (e) {
      if (drag.ids.has(e.id) || e.type === 'comment' || e.type === 'pen' || isLine(e)) return false;
      const b = bbox(e);
      if (b.x > view.x + view.w || b.y > view.y + view.h || b.x + b.w < view.x || b.y + b.h < view.y) return false;
      [b.x, b.x + b.w / 2, b.x + b.w].forEach(function (tx) { xs.forEach(function (sx) { const d = tx - sx; if (Math.abs(d) <= tol && (!bestX || Math.abs(d) < Math.abs(bestX.d))) bestX = { d: d, at: tx }; }); });
      [b.y, b.y + b.h / 2, b.y + b.h].forEach(function (ty) { ys.forEach(function (sy) { const d = ty - sy; if (Math.abs(d) <= tol && (!bestY || Math.abs(d) < Math.abs(bestY.d))) bestY = { d: d, at: ty }; }); });
      return ++n > 300;
    });
    if (bestX) { dx += bestX.d; guides.push({ x: bestX.at }); }
    if (bestY) { dy += bestY.d; guides.push({ y: bestY.at }); }
    return { dx: dx, dy: dy };
  }
  function moveTo(e, s, dx, dy) {
    if (isLine(e)) { e.x1 = s.x1 + dx; e.y1 = s.y1 + dy; e.x2 = s.x2 + dx; e.y2 = s.y2 + dy; }
    else if (e.type === 'comment' && e.attach) { e.ax = (s.ax || 0) + dx; e.ay = (s.ay || 0) + dy; }
    else { e.x = s.x + dx; e.y = s.y + dy; }
  }
  function resizeTo(w, event) {
    const d = drag, sb = d.box, h = d.handle;
    let x0 = sb.x, y0 = sb.y, x1 = sb.x + sb.w, y1 = sb.y + sb.h;
    if (h.indexOf('w') >= 0) x0 = Math.min(w.x, x1 - 4); if (h.indexOf('e') >= 0) x1 = Math.max(w.x, x0 + 4);
    if (h.indexOf('n') >= 0) y0 = Math.min(w.y, y1 - 4); if (h.indexOf('s') >= 0) y1 = Math.max(w.y, y0 + 4);
    let sx = sb.w ? (x1 - x0) / sb.w : 1, sy = sb.h ? (y1 - y0) / sb.h : 1;
    if (h.length === 2 && (d.uniform || event.shiftKey)) {
      const k = Math.max(sx, sy); sx = sy = k;
      if (h.indexOf('w') >= 0) x0 = x1 - sb.w * k; if (h.indexOf('n') >= 0) y0 = y1 - sb.h * k;
    }
    d.start.forEach(function (s, id) {
      const e = els.get(id); if (!e) return;
      if (isLine(e)) { e.x1 = x0 + (s.x1 - sb.x) * sx; e.y1 = y0 + (s.y1 - sb.y) * sy; e.x2 = x0 + (s.x2 - sb.x) * sx; e.y2 = y0 + (s.y2 - sb.y) * sy; return; }
      e.x = x0 + (s.x - sb.x) * sx; e.y = y0 + (s.y - sb.y) * sy; e.w = Math.max(2, s.w * sx);
      if (e.type === 'text') { if (h.length === 2) e.fontSize = Math.max(6, Math.round(s.fontSize * sy * 10) / 10); }
      else e.h = Math.max(2, s.h * sy);
    });
  }
  function endpointTo(w, event) {
    const e = els.get(drag.id), end = drag.end; if (!e) return;
    const target = bindable(w.x, w.y, e), other = end === 1 ? e.to : e.from;
    hoverBind = target && target.id !== other ? target : null;
    let x = w.x, y = w.y;
    if (event.shiftKey && !hoverBind) {
      // Shift keeps the line on the nearest 45 degrees.
      const ax = end === 1 ? e.x2 : e.x1, ay = end === 1 ? e.y2 : e.y1, a = Math.round(Math.atan2(y - ay, x - ax) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(x - ax, y - ay);
      x = ax + Math.cos(a) * len; y = ay + Math.sin(a) * len;
    }
    if (end === 1) { e.x1 = x; e.y1 = y; if (hoverBind) e.from = hoverBind.id; else delete e.from; }
    else { e.x2 = x; e.y2 = y; if (hoverBind) e.to = hoverBind.id; else delete e.to; }
  }
  function eraseAt(w) {
    const e = hit(w.x, w.y);
    if (e && e.type !== 'frame' && !drag.gone.has(e.id)) { track(e.id); drag.gone.add(e.id); e._fade = true; invalidate(); }
  }

  canvas.addEventListener('pointerdown', function (event) {
    const p = local(event), w = toWorld(p.sx, p.sy);
    pointer = { sx: p.sx, sy: p.sy, inside: true };
    if (editing) stopEditing();
    canvas.focus({ preventScroll: true });
    if (event.pointerType === 'touch') {
      touches.set(event.pointerId, p);
      if (touches.size === 2) {
        cancelDrag();
        const pts = Array.from(touches.values());
        pinch = { d: Math.hypot(pts[0].sx - pts[1].sx, pts[0].sy - pts[1].sy), cx: (pts[0].sx + pts[1].sx) / 2, cy: (pts[0].sy + pts[1].sy) / 2 };
        return;
      }
    }
    try { canvas.setPointerCapture(event.pointerId); } catch (e) { /* synthetic pointers cannot be captured */ }
    emit('pointerdown');
    if (event.button === 1 || event.button === 2 || spaceDown || tool === 'hand') {
      drag = { kind: 'pan', sx: p.sx, sy: p.sy }; canvas.style.cursor = 'grabbing'; return;
    }
    if (event.button !== 0) return;

    if (tool === 'select') {
      const handle = handleAt(p.sx, p.sy);
      if (handle && handle[0] === 'p') { const line = selectedList()[0]; begin([line.id]); drag = { kind: 'endpoint', id: line.id, end: handle === 'p1' ? 1 : 2, ids: new Set([line.id]) }; return; }
      if (handle) {
        const list = selectedList(), start = new Map(); list.forEach(function (e) { start.set(e.id, clone(e)); });
        begin(list.map(function (e) { return e.id; }));
        drag = { kind: 'resize', handle: handle, start: start, box: unionBox(list), ids: new Set(selection), uniform: list.every(function (e) { return e.type === 'text' || e.type === 'image'; }) };
        return;
      }
      const pin = hitComment(p.sx, p.sy), target = pin || hit(w.x, w.y);
      if (target) {
        if (event.shiftKey) { if (selection.has(target.id)) selection.delete(target.id); else selection.add(target.id); emit('selection'); invalidate(); return; }
        if (!selection.has(target.id)) select([target.id]);
        if (canEdit) startMove(event, w); else if (pin) drag = { kind: 'tap', ids: new Set() };
        if (drag) drag.pin = pin;
        return;
      }
      if (!event.shiftKey) select([]);
      drag = { kind: 'marquee', x0: w.x, y0: w.y, x1: w.x, y1: w.y, base: new Set(selection) };
      return;
    }
    if (!canEdit) return;
    if (tool === 'pen' || tool === 'highlighter') {
      const hl = tool === 'highlighter';
      const e = { id: uid(), type: 'pen', x: w.x, y: w.y, w: 1, h: 1, bw: 1, bh: 1, pts: [], stroke: hl ? style.hl : style.pen, sw: hl ? style.hlSize : style.penSize, z: nextZ(), _raw: [w.x, w.y] };
      if (hl) e.hl = true;
      begin([e.id]); els.set(e.id, e); structureChanged();
      drag = { kind: 'pen', id: e.id, ids: new Set([e.id]) }; return;
    }
    if (tool === 'eraser') { begin([]); drag = { kind: 'erase', gone: new Set(), ids: new Set() }; eraseAt(w); return; }
    // Typing starts when the button is released: the press itself would take focus back to the canvas.
    if (tool === 'sticky') { const e = addSticky(w.x, w.y); setTool('select'); drag = { kind: 'type', id: e.id, ids: new Set([e.id]) }; return; }
    if (tool === 'text') { const e = addText(w.x, w.y); setTool('select'); drag = { kind: 'type', id: e.id, ids: new Set([e.id]) }; return; }
    if (tool === 'comment') { const target = hit(w.x, w.y); emit('comment-new', { x: w.x, y: w.y, target: target && target.type !== 'frame' ? target : null }); setTool('select'); return; }
    if (tool === 'line' || tool === 'arrow') {
      const from = bindable(w.x, w.y, null);
      const e = { id: uid(), type: tool, x1: w.x, y1: w.y, x2: w.x, y2: w.y, stroke: style.stroke, sw: style.sw, z: nextZ() };
      if (from) e.from = from.id;
      begin([e.id]); els.set(e.id, e); structureChanged();
      drag = { kind: 'endpoint', id: e.id, end: 2, creating: true, ids: new Set([e.id]) }; return;
    }
    if (BOX_TYPES[tool] || tool === 'frame') {
      const e = { id: uid(), type: tool, x: w.x, y: w.y, w: 1, h: 1, z: nextZ() };
      if (tool === 'frame') { e.text = 'Frame'; e.fill = 'auto'; }
      else { e.stroke = style.stroke; e.fill = style.fill; e.sw = style.sw; e.fontSize = 16; if (tool === 'rect') e.radius = 8; }
      begin([e.id]); els.set(e.id, e); structureChanged();
      drag = { kind: 'create', id: e.id, x0: w.x, y0: w.y, ids: new Set([e.id]) };
    }
  });

  canvas.addEventListener('pointermove', function (event) {
    const p = local(event), w = toWorld(p.sx, p.sy);
    pointer = { sx: p.sx, sy: p.sy, inside: true };
    if (event.pointerType === 'touch' && touches.has(event.pointerId)) {
      touches.set(event.pointerId, p);
      if (pinch && touches.size === 2) {
        const pts = Array.from(touches.values()), d = Math.hypot(pts[0].sx - pts[1].sx, pts[0].sy - pts[1].sy), cx = (pts[0].sx + pts[1].sx) / 2, cy = (pts[0].sy + pts[1].sy) / 2;
        panBy(pinch.cx - cx, pinch.cy - cy); zoomAt(cx, cy, d / (pinch.d || d), false);
        pinch = { d: d, cx: cx, cy: cy }; return;
      }
    }
    if (tool === 'eraser') invalidate();
    if (!drag) {
      if (tool === 'select' && !spaceDown) {
        const handle = handleAt(p.sx, p.sy);
        canvas.style.cursor = handle ? CURSORS[handle] : hitComment(p.sx, p.sy) ? 'pointer' : hit(w.x, w.y) ? (canEdit ? 'move' : 'default') : 'default';
      } else if ((tool === 'line' || tool === 'arrow') && canEdit) { const b = bindable(w.x, w.y, null); if (b !== hoverBind) { hoverBind = b; invalidate(); } }
      return;
    }
    const d = drag;
    if (d.kind === 'pan') { panBy(d.sx - p.sx, d.sy - p.sy); d.sx = p.sx; d.sy = p.sy; return; }
    if (d.kind === 'move') {
      let dx = w.x - d.x0, dy = w.y - d.y0;
      if (!d.moved && Math.hypot(dx, dy) * cam.z < 3) return;
      d.moved = true;
      if (event.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      const snapped = event.metaKey || event.ctrlKey ? (guides = [], { dx: dx, dy: dy }) : snapMove(dx, dy, d.box);
      d.start.forEach(function (s, id) { const e = els.get(id); if (e) moveTo(e, s, snapped.dx, snapped.dy); });
      emit('moving');
    } else if (d.kind === 'resize') { resizeTo(w, event); emit('moving'); }
    else if (d.kind === 'endpoint') endpointTo(w, event);
    else if (d.kind === 'marquee') {
      d.x1 = w.x; d.y1 = w.y;
      const x0 = Math.min(d.x0, d.x1), y0 = Math.min(d.y0, d.y1), x1 = Math.max(d.x0, d.x1), y1 = Math.max(d.y0, d.y1);
      selection.clear(); d.base.forEach(function (id) { selection.add(id); });
      els.forEach(function (e) {
        const b = bbox(e);
        const inside = b.x >= x0 && b.y >= y0 && b.x + b.w <= x1 && b.y + b.h <= y1;
        const touching = b.x <= x1 && b.y <= y1 && b.x + b.w >= x0 && b.y + b.h >= y0;
        if (e.type === 'frame' || e.type === 'comment' ? inside : touching) selection.add(e.id);
      });
    } else if (d.kind === 'pen') {
      const e = els.get(d.id), raw = e._raw, events = event.getCoalescedEvents ? event.getCoalescedEvents() : [event];
      (events.length ? events : [event]).forEach(function (ev) {
        const q = local(ev), v = toWorld(q.sx, q.sy), n = raw.length;
        if (Math.hypot(v.x - raw[n - 2], v.y - raw[n - 1]) * cam.z >= 1.5) raw.push(v.x, v.y);
      });
    } else if (d.kind === 'erase') eraseAt(w);
    else if (d.kind === 'create') {
      const e = els.get(d.id);
      let x1 = w.x, y1 = w.y;
      if (event.shiftKey) { const s = Math.max(Math.abs(x1 - d.x0), Math.abs(y1 - d.y0)); x1 = d.x0 + Math.sign(x1 - d.x0 || 1) * s; y1 = d.y0 + Math.sign(y1 - d.y0 || 1) * s; }
      e.x = Math.min(d.x0, x1); e.y = Math.min(d.y0, y1); e.w = Math.abs(x1 - d.x0); e.h = Math.abs(y1 - d.y0);
    }
    invalidate();
  });

  function endDrag(event) {
    touches.delete(event.pointerId);
    if (touches.size < 2) pinch = null;
    const d = drag; drag = null; guides = []; hoverBind = null;
    if (!d) return;
    invalidate();
    if (d.kind === 'pan') { setTool(tool); return; }
    if (d.kind === 'tap') { if (d.pin) emit('comment-open', d.pin); return; }
    if (d.kind === 'type') { const e = els.get(d.id); if (e) startEditing(e); return; }
    if (d.kind === 'move') {
      if (!d.moved) { pending = null; if (d.pin) emit('comment-open', d.pin); emit('selection'); return; }
      commit(); emit('selection'); return;
    }
    if (d.kind === 'resize') { commit(); emit('selection'); return; }
    if (d.kind === 'marquee') { emit('selection'); return; }
    if (d.kind === 'endpoint') {
      const e = els.get(d.id);
      if (d.creating) {
        const l = lineEnds(e);
        if (Math.hypot(l.x2 - l.x1, l.y2 - l.y1) * cam.z < 6) { els.delete(e.id); pending = null; structureChanged(); return; }
        commit(); setTool('select'); select([e.id]); return;
      }
      commit(); emit('selection'); return;
    }
    if (d.kind === 'pen') {
      const e = els.get(d.id), raw = e._raw, b = rawBox(raw);
      delete e._raw;
      e.x = b.x; e.y = b.y; e.w = Math.max(b.w, 1); e.h = Math.max(b.h, 1); e.bw = e.w; e.bh = e.h;
      e.pts = raw.map(function (v, i) { return Math.round((v - (i % 2 ? b.y : b.x)) * 10) / 10; });
      commit(); return;
    }
    if (d.kind === 'erase') { d.gone.forEach(function (id) { remove(id); }); commit(); return; }
    if (d.kind === 'create') {
      const e = els.get(d.id);
      if (e.w * cam.z < 6 && e.h * cam.z < 6) {
        // A click, not a drag: drop a default-sized shape centred where you clicked.
        const size = e.type === 'frame' ? [640, 420] : [160, 110];
        e.w = size[0]; e.h = size[1]; e.x = d.x0 - e.w / 2; e.y = d.y0 - e.h / 2;
      }
      commit(); setTool('select'); select([e.id]);
    }
  }
  function cancelDrag() {
    if (!drag) return;
    const d = drag; drag = null; guides = []; hoverBind = null;
    if (d.kind === 'pen' || d.kind === 'create' || d.creating) { els.delete(d.id); structureChanged(); }
    else if (d.start) d.start.forEach(function (s, id) { if (els.has(id)) els.set(id, clone(s)); });
    if (d.gone) d.gone.forEach(function (id) { const e = els.get(id); if (e) delete e._fade; });
    pending = null; structureChanged();
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', function () { pointer.inside = false; if (tool === 'eraser') invalidate(); });
  canvas.addEventListener('contextmenu', function (event) { event.preventDefault(); });
  canvas.addEventListener('dblclick', function (event) {
    if (!canEdit || tool !== 'select') return;
    const p = local(event), w = toWorld(p.sx, p.sy), target = hit(w.x, w.y);
    if (target && TEXT_TYPES[target.type]) startEditing(target, true);
    else if (!target && !hitComment(p.sx, p.sy)) startEditing(addText(w.x, w.y));
  });
  canvas.addEventListener('wheel', function (event) {
    event.preventDefault();
    const p = local(event);
    if (event.ctrlKey || event.metaKey) { zoomAt(p.sx, p.sy, Math.exp(-Math.max(-60, Math.min(60, event.deltaY)) * 0.012), false); return; }
    // A mouse wheel sends whole, large steps with no sideways movement; a trackpad sends small ones.
    const wheel = event.deltaMode !== 0 || (!event.deltaX && Math.abs(event.deltaY) >= 50 && Number.isInteger(event.deltaY));
    if (wheel) zoomAt(p.sx, p.sy, event.deltaY < 0 ? 1.25 : 0.8, true);
    else panBy(event.deltaX, event.deltaY);
  }, { passive: false });

  // ── Selection actions ──────────────────────────────────────────────
  function duplicateElements(list, dx, dy, recordOpen) {
    const ids = new Map(); list.forEach(function (e) { ids.set(e.id, uid()); });
    let z = nextZ();
    const copies = list.slice().sort(function (a, b) { return (a.z || 0) - (b.z || 0); }).map(function (e) {
      const c = clone(e); c.id = ids.get(e.id); c.z = z++; delete c.v; delete c.by;
      if (isLine(c)) { c.x1 += dx; c.y1 += dy; c.x2 += dx; c.y2 += dy; } else if (!(c.type === 'comment' && c.attach)) { c.x += dx; c.y += dy; }
      ['from', 'to', 'attach'].forEach(function (k) {
        if (!c[k]) return;
        if (ids.has(c[k])) c[k] = ids.get(c[k]);
        else if (k !== 'attach') {
          // A copy keeps its ends where they were when what it pointed at is not copied too.
          const l = lineEnds(e); if (k === 'from') { c.x1 = l.x1 + dx; c.y1 = l.y1 + dy; } else { c.x2 = l.x2 + dx; c.y2 = l.y2 + dy; } delete c[k];
        }
      });
      return c;
    });
    begin(copies.map(function (c) { return c.id; }));
    copies.forEach(put);
    if (!recordOpen) commit();
    return copies;
  }
  function duplicateSelection() { const list = selectedList(); if (!list.length || !canEdit) return; select(duplicateElements(list, 24, 24).map(function (e) { return e.id; })); }
  function deleteSelection() {
    const ids = Array.from(selection); if (!ids.length || !canEdit) return;
    change(ids, function () { ids.forEach(remove); }); select([]);
  }
  function restack(front) {
    const list = selectedList().sort(function (a, b) { return (a.z || 0) - (b.z || 0); }); if (!list.length || !canEdit) return;
    let min = 0; els.forEach(function (e) { min = Math.min(min, e.z || 0); });
    let z = front ? nextZ() : min - list.length;
    change(list.map(function (e) { return e.id; }), function () { list.forEach(function (e) { e.z = z++; }); });
    structureChanged();
  }
  function setProps(props) {
    const list = selectedList(); if (!list.length || !canEdit) return;
    change(list.map(function (e) { return e.id; }), function () {
      list.forEach(function (e) { for (const k in props) { if (props[k] === false || props[k] == null) delete e[k]; else e[k] = props[k]; } });
    });
    invalidate(); emit('selection');
  }
  function setStyle(props) { Object.assign(style, props); localStorage.setItem('lfg-wb-style', JSON.stringify(style)); }

  let clipboard = null;
  const CLIP_MARK = 'lfg-whiteboard-selection:';
  function copySelection() {
    const list = selectedList(); if (!list.length) return false;
    clipboard = { stamp: Date.now(), items: list.map(clone), box: unionBox(list) };
    return true;
  }
  function pasteClipboard() {
    if (!clipboard || !canEdit) return;
    const at = pointer.inside ? toWorld(pointer.sx, pointer.sy) : toWorld(root.clientWidth / 2, root.clientHeight / 2);
    const live = clipboard.items.map(function (e) { return e; });
    // lineEnds reads the board, so paste works from the copied snapshot's own coordinates.
    const dx = at.x - (clipboard.box.x + clipboard.box.w / 2), dy = at.y - (clipboard.box.y + clipboard.box.h / 2);
    select(duplicateElements(live, dx, dy).map(function (e) { return e.id; }));
  }
  document.addEventListener('copy', function (event) {
    if (typing(event.target) || !copySelection()) return;
    event.clipboardData.setData('text/plain', CLIP_MARK + clipboard.stamp); event.preventDefault();
  });
  document.addEventListener('cut', function (event) {
    if (typing(event.target) || !canEdit || !copySelection()) return;
    event.clipboardData.setData('text/plain', CLIP_MARK + clipboard.stamp); event.preventDefault(); deleteSelection();
  });
  document.addEventListener('paste', function (event) {
    if (typing(event.target) || !canEdit) return;
    const data = event.clipboardData; if (!data) return;
    const file = Array.from(data.files || []).find(function (f) { return /^image\//.test(f.type); });
    const at = pointer.inside ? toWorld(pointer.sx, pointer.sy) : toWorld(root.clientWidth / 2, root.clientHeight / 2);
    if (file) { event.preventDefault(); importImage(file, at); return; }
    const text = data.getData('text/plain');
    if (!text) return;
    event.preventDefault();
    if (text.indexOf(CLIP_MARK) === 0 && clipboard) { pasteClipboard(); return; }
    // Text from elsewhere lands as a note (or as plain text when it is long).
    const e = text.length <= 140 ? addSticky(at.x, at.y, text.trim()) : addText(at.x, at.y, text.trim().slice(0, 6000));
    select([e.id]);
  });
  root.addEventListener('dragover', function (event) { event.preventDefault(); });
  root.addEventListener('drop', function (event) {
    event.preventDefault();
    const p = local(event), at = toWorld(p.sx, p.sy);
    Array.from(event.dataTransfer.files || []).slice(0, 6).forEach(function (file, i) { importImage(file, { x: at.x + i * 30, y: at.y + i * 30 }); });
  });

  // ── Keyboard ───────────────────────────────────────────────────────
  function typing(target) { return !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)); }
  const TOOL_KEYS = { v: 'select', h: 'hand', p: 'pen', y: 'highlighter', e: 'eraser', n: 'sticky', t: 'text', r: 'rect', o: 'ellipse', d: 'diamond', l: 'line', a: 'arrow', f: 'frame', c: 'comment' };
  document.addEventListener('keydown', function (event) {
    if (typing(event.target)) return;
    const mod = event.metaKey || event.ctrlKey, key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (key === ' ') { if (!spaceDown) { spaceDown = true; canvas.style.cursor = 'grab'; } event.preventDefault(); return; }
    if (mod && key === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
    if (mod && key === 'y') { event.preventDefault(); redo(); return; }
    if (mod && key === 'a') { event.preventDefault(); select(Array.from(els.values()).filter(function (e) { return e.type !== 'comment'; }).map(function (e) { return e.id; })); return; }
    if (mod && key === 'd') { event.preventDefault(); duplicateSelection(); return; }
    if (mod && (key === '=' || key === '+')) { event.preventDefault(); zoomAt(root.clientWidth / 2, root.clientHeight / 2, 1.25, true); return; }
    if (mod && key === '-') { event.preventDefault(); zoomAt(root.clientWidth / 2, root.clientHeight / 2, 0.8, true); return; }
    if (mod && key === '0') { event.preventDefault(); zoomAt(root.clientWidth / 2, root.clientHeight / 2, 1 / cam.z, true); return; }
    if (mod) return;
    if (key === 'Escape') { if (drag) cancelDrag(); else if (selection.size) select([]); else setTool('select'); emit('escape'); return; }
    if (key === 'Delete' || key === 'Backspace') { event.preventDefault(); deleteSelection(); return; }
    if (key === 'Enter' && selection.size === 1) { const e = selectedList()[0]; if (TEXT_TYPES[e.type]) { event.preventDefault(); startEditing(e, true); } return; }
    if (key === ']') { restack(true); return; }
    if (key === '[') { restack(false); return; }
    if (event.shiftKey && (key === '1' || key === '!')) { fitAll(); return; }
    if (event.shiftKey && (key === '2' || key === '@')) { flyTo(unionBox(selectedList())); return; }
    if (key.indexOf('Arrow') === 0 && selection.size && canEdit) {
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1, dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0, dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
      const list = selectedList();
      change(list.map(function (e) { return e.id; }), function () { list.forEach(function (e) { moveTo(e, clone(e), dx, dy); }); });
      emit('moving'); return;
    }
    if (TOOL_KEYS[key] && !event.altKey) { setTool(TOOL_KEYS[key]); }
  });
  document.addEventListener('keyup', function (event) { if (event.key === ' ') { spaceDown = false; if (!drag) setTool(tool); } });

  // ── Export ─────────────────────────────────────────────────────────
  function exportPng(name) {
    const list = order().filter(function (e) { return e.type !== 'comment'; }), box = unionBox(list);
    if (!box) { emit('error', 'There is nothing on the board to export yet.'); return; }
    const pad = 48, scale = Math.min(2, 8000 / (box.w + pad * 2), 8000 / (box.h + pad * 2));
    const out = document.createElement('canvas'); out.width = Math.ceil((box.w + pad * 2) * scale); out.height = Math.ceil((box.h + pad * 2) * scale);
    const c = out.getContext('2d'), t = theme(), was = editing;
    editing = null;
    c.fillStyle = t.bg; c.fillRect(0, 0, out.width, out.height);
    c.setTransform(scale, 0, 0, scale, (pad - box.x) * scale, (pad - box.y) * scale);
    list.forEach(function (e) { const born = e._born; delete e._born; drawElement(c, e, t, scale, 0); if (born) e._born = born; });
    editing = was;
    out.toBlob(function (blob) {
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = (name || 'whiteboard').replace(/[^\w\- ]+/g, '').trim() + '.png';
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    });
  }

  // ── Start ──────────────────────────────────────────────────────────
  window.LFGBoard = {
    els: els, selection: selection, cam: cam, style: style, canEdit: canEdit, boardId: boardId, apiBase: apiBase, on: on, emit: emit, request: request,
    selectedList: selectedList, unionBox: unionBox, bbox: bbox, toScreen: toScreen, toWorld: toWorld, commentPos: commentPos, isLine: isLine,
    setTool: setTool, getTool: function () { return tool; }, select: select, change: change, put: put, remove: remove, uid: uid, nextZ: nextZ,
    setProps: setProps, setStyle: setStyle, restack: restack, duplicateSelection: duplicateSelection, deleteSelection: deleteSelection,
    undo: undo, redo: redo, canUndo: function () { return undoStack.length > 0; }, canRedo: function () { return redoStack.length > 0; },
    zoomAt: zoomAt, flyTo: flyTo, fitAll: fitAll, exportPng: exportPng, importImage: importImage, applyRemote: applyRemote, removeRemote: removeRemote,
    startEditing: startEditing, isDragging: function () { return !!drag; }, isEditing: function () { return !!editing; }, invalidate: invalidate,
    viewport: function () { return { x: cam.x, y: cam.y, w: root.clientWidth / cam.z, h: root.clientHeight / cam.z }; },
  };

  new ResizeObserver(invalidate).observe(root);
  new MutationObserver(invalidate).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  window.addEventListener('beforeunload', flush);
  document.addEventListener('visibilitychange', function () { if (document.hidden) flush(); else poll(); });
  requestAnimationFrame(frameLoop);

  request('').then(function (body) {
    version = body.board.version;
    body.elements.forEach(function (e) { els.set(e.id, e); });
    structureChanged();
    fitAll({ instant: true, maxZoom: 1 });
    emit('ready', body);
    setInterval(poll, 2500);
  }).catch(function (error) { emit('error', error.message); });
})();
