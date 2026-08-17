/**
 * "Chat with ticket" — the ticket's build/agent conversation, rendered NATIVELY in the
 * chat page's LEFT panel (no iframe), while the RIGHT panel keeps the live preview. Lets
 * you suggest changes to a ticket's branch and watch the app update, without the
 * full-screen ticket drawer covering everything.
 *
 * Reuses the same API the ticket drawer uses:
 *   GET  /api/projects/:pid/tickets/:id/logs   → the execution/agent log
 *   POST /api/projects/:pid/tickets/:id/chat   → send a message to the agent
 * Live updates are polled (every 3s) while the panel is open — simple + robust; the
 * drawer's WebSocket path is a separate concern.
 */
(function () {
  const PID = () => document.body.dataset.projectId;
  let ticketId = null;
  let timer = null;

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const md = (s) => (typeof marked !== "undefined" ? marked.parse(s || "") : esc(s).split("\n").join("<br>"));
  const $ = (id) => document.getElementById(id);
  const panel = () => $("ticket-agent-panel");
  let fitObs = null;
  let prevArtWidth = null; // preview-overlay width to restore when the ticket chat closes
  let curMeta = null;      // last ticket's fields (for the Details tab)
  let activeTab = "details";
  let tasksLoaded = false, gitLoaded = false; // lazy-load Tasks/Git on first view

  // The preview panel (#artifacts-panel) is a FIXED slide-over on the right, so the popup
  // must stop at its LEFT edge (else it hides behind the preview + its ✕ is unreachable).
  // Recompute the popup's right inset from the overlay's live width.
  function fitToChatArea() {
    const p = panel();
    if (!p || p.style.display === "none") return;
    const art = document.getElementById("artifacts-panel");
    const overlayW = (art && art.classList.contains("expanded")) ? Math.max(0, window.innerWidth - art.getBoundingClientRect().left) : 0;
    p.style.right = (overlayW + 12) + "px";
  }

  // The artifacts (preview) panel's width is COUPLED to .chat-container's padding-right
  // (artifacts.js reserves that space so the chat reflows to meet the panel). We resize the
  // panel directly for the split, so we must keep that padding in sync — otherwise the chat
  // is left with a dead gap ("shrunk/disproportionate") after we close.
  function syncChatPadding() {
    const art = document.getElementById("artifacts-panel");
    const cc = document.querySelector(".chat-container");
    if (!cc) return;
    if (art && art.classList.contains("expanded")) cc.style.setProperty("padding-right", Math.round(art.getBoundingClientRect().width) + "px", "important");
  }

  // The split between the ticket chat (left) and the preview (right) is DRAGGABLE via the
  // handle on the popup's right edge — dragging widens/narrows both together. The chosen
  // width persists so you set it once. Defaults to 50-50.
  const SPLIT_KEY = "lfg_ticket_split_art_w";
  let resizeWired = false;
  function preferredArtWidth() {
    const v = parseInt(localStorage.getItem(SPLIT_KEY) || "", 10);
    if (v > 0) return Math.max(360, Math.min(window.innerWidth - 360, v)) + "px";
    return "50vw";
  }
  function setupResize() {
    if (resizeWired) return;
    const handle = $("ta-resize");
    if (!handle) return;
    resizeWired = true;
    let dragging = false;
    handle.addEventListener("mousedown", (e) => { dragging = true; e.preventDefault(); document.body.style.userSelect = "none"; });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const art = document.getElementById("artifacts-panel");
      if (!art) return;
      let w = window.innerWidth - e.clientX;                       // preview width = distance from cursor to the right edge
      w = Math.max(360, Math.min(window.innerWidth - 360, w));     // keep both panes usable
      art.style.width = w + "px";
      fitToChatArea();
      syncChatPadding();
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = "";
      const art = document.getElementById("artifacts-panel");
      if (art) localStorage.setItem(SPLIT_KEY, String(Math.round(art.getBoundingClientRect().width)));
    });
  }

  // The Details tab: the ticket's fields (status / priority / created, full description,
  // attachments) — the same info as the old right-side drawer, now in this left panel.
  function renderMeta(meta) {
    const el = $("ta-pane-details");
    if (!el) return;
    if (!meta) { el.innerHTML = '<div style="opacity:.5;padding:20px;text-align:center;">No details.</div>'; return; }
    const pill = (txt, bg, fg) => `<span style="font-size:11px;font-weight:600;padding:2px 9px;border-radius:6px;background:${bg};color:${fg};white-space:nowrap;">${esc(txt)}</span>`;
    const pr = String(meta.priority || "").toLowerCase();
    const prColor = /high|urgent/.test(pr) ? ["rgba(239,68,68,.14)", "#f87171"] : /low/.test(pr) ? ["rgba(59,130,246,.14)", "#60a5fa"] : ["rgba(245,158,11,.16)", "#fbbf24"];
    const created = meta.createdAt ? new Date(meta.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
    const desc = String(meta.description || "").trim();
    const atts = Array.isArray(meta.attachments) ? meta.attachments : [];
    const imgAtts = atts.filter((a) => a && a.url && (!a.type || /^image\//.test(a.type) || /\.(png|jpe?g|gif|webp)$/i.test(a.url)));
    el.innerHTML =
      `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">` +
        pill(meta.status || "open", "rgba(124,58,237,.14)", "#a78bfa") +
        (meta.priority ? pill(meta.priority, prColor[0], prColor[1]) : "") +
        (created ? `<span style="font-size:11px;color:var(--text-secondary,#9ca3af);">Created ${esc(created)}</span>` : "") +
      `</div>` +
      (imgAtts.length ? `<div style="margin-top:12px;display:flex;flex-wrap:wrap;gap:6px;">` +
        imgAtts.map((a) => `<a href="${esc(a.url)}" target="_blank" rel="noopener" title="${esc(a.name || "attachment")}"><img src="${esc(a.url)}" loading="lazy" style="max-width:180px;max-height:150px;border-radius:8px;border:1px solid var(--border-color,#2a2a2a);display:block;"></a>`).join("") +
      `</div>` : "") +
      (desc ? `<div class="markdown-content" style="margin-top:14px;font-size:13px;color:var(--text-color,#cbd5e1);line-height:1.6;">${md(desc)}</div>` : '<div style="margin-top:14px;opacity:.5;font-size:12.5px;">No description.</div>');
  }

  // ── Tabs: Details / Actions (agent chat) / Tasks / Git ─────────────────────
  function switchTicketTab(tab) {
    activeTab = tab;
    document.querySelectorAll("#ta-tabs .ta-tab").forEach((b) => b.classList.toggle("active", b.getAttribute("data-ta-tab") === tab));
    const panes = { details: "ta-pane-details", actions: "ta-log", tasks: "ta-pane-tasks", git: "ta-pane-git" };
    Object.keys(panes).forEach((k) => { const el = $(panes[k]); if (el) el.style.display = (k === tab) ? (k === "actions" ? "flex" : "block") : "none"; });
    const inputRow = $("ta-input-row");
    if (inputRow) inputRow.style.display = tab === "actions" ? "flex" : "none"; // send box only for the agent chat
    if (tab === "tasks" && !tasksLoaded) { tasksLoaded = true; loadTasks(); }
    if (tab === "git" && !gitLoaded) { gitLoaded = true; loadGit(); }
  }
  function setTabCount(tab, n) {
    const b = document.querySelector('#ta-tabs .ta-tab[data-ta-tab="' + tab + '"]');
    if (!b) return;
    let c = b.querySelector(".ta-tab-count");
    if (!n) { if (c) c.remove(); return; }
    if (!c) { c = document.createElement("span"); c.className = "ta-tab-count"; b.appendChild(c); }
    c.textContent = String(n);
  }

  async function loadTasks() {
    const el = $("ta-pane-tasks");
    if (!el || !ticketId) return;
    el.innerHTML = '<div style="opacity:.5;padding:20px;text-align:center;">Loading tasks…</div>';
    try {
      const r = await fetch(`/api/projects/${PID()}/tickets/${ticketId}/tasks`, { credentials: "same-origin" });
      const rows = await r.json();
      if (!Array.isArray(rows) || !rows.length) { el.innerHTML = '<div style="opacity:.55;padding:24px;text-align:center;">No tasks yet.</div>'; setTabCount("tasks", 0); return; }
      const dot = (s) => { s = (s || "").toLowerCase(); const c = s === "success" ? "#22c55e" : s === "in_progress" ? "#3b82f6" : s === "fail" ? "#ef4444" : "#6b7280"; return `<span style="width:8px;height:8px;border-radius:50%;background:${c};flex:none;margin-top:5px;"></span>`; };
      el.innerHTML = rows.map((t) => `<div style="display:flex;gap:9px;padding:8px 0;border-bottom:1px solid var(--border-color,#2a2a2a);">${dot(t.status)}<span style="font-size:13px;color:var(--text-color,#cbd5e1);line-height:1.45;${/success/i.test(t.status) ? "opacity:.55;text-decoration:line-through;" : ""}">${esc(t.description || "")}</span></div>`).join("");
      setTabCount("tasks", rows.length);
    } catch (e) { el.innerHTML = '<div style="opacity:.55;padding:24px;text-align:center;">Couldn\'t load tasks.</div>'; }
  }

  function renderDiff(diff) {
    return String(diff).slice(0, 60000).split("\n").map((ln) => {
      const e = esc(ln);
      if (ln.startsWith("+") && !ln.startsWith("+++")) return `<span style="color:#4ade80;">${e}</span>`;
      if (ln.startsWith("-") && !ln.startsWith("---")) return `<span style="color:#f87171;">${e}</span>`;
      if (ln.startsWith("@@")) return `<span style="color:#a78bfa;">${e}</span>`;
      return e;
    }).join("\n");
  }
  async function loadGit() {
    const el = $("ta-pane-git");
    if (!el || !ticketId) return;
    el.innerHTML = '<div style="opacity:.5;padding:20px;text-align:center;">Loading diff…</div>';
    try {
      const r = await fetch(`/api/projects/${PID()}/tickets/${ticketId}/git/diff?base=main`, { credentials: "same-origin" });
      const d = await r.json();
      if (d.error) { el.innerHTML = `<div style="opacity:.6;padding:24px;text-align:center;line-height:1.5;">${esc(d.error)}</div>`; return; }
      const files = Array.isArray(d.files) ? d.files : [];
      const commits = Array.isArray(d.commits) ? d.commits : [];
      let html = `<div style="padding:12px 16px;border-bottom:1px solid var(--border-color,#2a2a2a);font-size:12px;color:var(--text-secondary,#9ca3af);"><code style="color:#a78bfa;">${esc(d.head || "")}</code> vs <code>${esc(d.base || "main")}</code> · ${files.length} file${files.length !== 1 ? "s" : ""} changed</div>`;
      if (commits.length) html += `<div style="padding:10px 16px;border-bottom:1px solid var(--border-color,#2a2a2a);">${commits.map((c) => `<div style="font-size:12px;color:var(--text-secondary,#9ca3af);padding:2px 0;"><code style="color:#a78bfa;">${esc((c.sha || "").slice(0, 7))}</code> ${esc(c.subject || "")}</div>`).join("")}</div>`;
      if (files.length) html += `<div style="padding:8px 16px;">${files.map((f) => `<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0;font-family:ui-monospace,monospace;"><span style="color:var(--text-color,#cbd5e1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(f.path)}</span><span style="flex:none;margin-left:10px;"><span style="color:#22c55e;">+${f.added}</span> <span style="color:#ef4444;">-${f.removed}</span></span></div>`).join("")}</div>`;
      if (d.diff) html += `<pre style="margin:0;padding:12px 16px;font-size:11.5px;line-height:1.5;overflow:auto;white-space:pre;color:var(--text-color,#cbd5e1);border-top:1px solid var(--border-color,#2a2a2a);">${renderDiff(d.diff)}</pre>`;
      el.innerHTML = html;
      setTabCount("git", files.length);
    } catch (e) { el.innerHTML = '<div style="opacity:.55;padding:24px;text-align:center;">Couldn\'t load the diff.</div>'; }
  }

  function open(id, key, name, meta, opts) {
    opts = opts || {};
    ticketId = id;
    curMeta = meta || null;
    tasksLoaded = false; gitLoaded = false;
    const p = panel();
    if (!p) return;
    const title = $("ta-title");
    if (title) title.textContent = (key ? key + " · " : "") + (name || "Ticket");
    renderMeta(meta);
    p.style.display = "flex";
    const area = $("ta-log");
    if (area) area.innerHTML = '<div style="opacity:.5;padding:24px;text-align:center;">Loading…</div>';
    loadLog();
    startPoll();
    // Default tab: Details when opened from a ticket row (fields in hand); Actions when
    // opened from the preview's "Chat with ticket" button (you came to chat).
    switchTicketTab(opts.withPreview ? "actions" : "details");
    // Only take over the RIGHT panel with the live preview when explicitly asked (the
    // preview toolbar's "Chat with ticket"). A ticket-row click must NOT hijack the tab.
    if (opts.withPreview) {
      try {
        const tabBtn = document.querySelector('.tab-button[data-tab="preview"]');
        if (tabBtn) tabBtn.click();
        if (window.PreviewTab && window.PreviewTab.open) window.PreviewTab.open(id);
      } catch (_) {}
    }
    // 50-50 split: give the preview overlay half the width so the ticket chat gets the
    // other half (otherwise, with a narrow preview, the popup sprawls across the screen).
    const art = document.getElementById("artifacts-panel");
    if (art) { if (prevArtWidth === null) prevArtWidth = art.style.width || ""; art.style.width = preferredArtWidth(); }
    setupResize();
    syncChatPadding();
    // Fit to the visible chat area (left of the preview overlay), and keep it fitted as the
    // preview is toggled (class) or its width dragged (style).
    setTimeout(() => { fitToChatArea(); syncChatPadding(); }, 60);
    if (art && !fitObs) { fitObs = new MutationObserver(fitToChatArea); fitObs.observe(art, { attributes: true, attributeFilter: ["class", "style"] }); }
    window.addEventListener("resize", fitToChatArea);
    const input = $("ta-input");
    if (input) setTimeout(() => input.focus(), 80);
  }

  function close() {
    const p = panel();
    if (p) p.style.display = "none";
    renderMeta(null);
    stopPoll();
    if (fitObs) { fitObs.disconnect(); fitObs = null; }
    window.removeEventListener("resize", fitToChatArea);
    const art = document.getElementById("artifacts-panel");
    if (art && prevArtWidth !== null) { art.style.width = prevArtWidth; prevArtWidth = null; } // restore the preview width
    syncChatPadding(); // reflow the chat to the restored panel width (no dead gap)
    ticketId = null;
  }

  async function loadLog() {
    if (!ticketId) return;
    try {
      const r = await fetch(`/api/projects/${PID()}/tickets/${ticketId}/logs`, { credentials: "same-origin" });
      if (!r.ok) return;
      const rows = await r.json();
      if (Array.isArray(rows)) renderAll(rows);
    } catch (_) { /* keep last render */ }
  }

  function renderAll(rows) {
    const area = $("ta-log");
    if (!area) return;
    const atBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 100;
    area.innerHTML = rows.length
      ? rows.map(renderRow).join("")
      : '<div data-empty style="opacity:.55;padding:28px 20px;text-align:center;line-height:1.6;">No activity yet.<br>Send a message below to ask the agent to change this ticket.</div>';
    if (atBottom) area.scrollTop = area.scrollHeight;
  }

  let rowSeq = 0;
  const ACTION_RE = /^(Running|Reading|Editing|Writing|Creating|Searching|Listing|Merging|Merged|Committing|Committed|Pushed|Pushing|Building|Build|Installing|Started|Starting|Cloning|Fetching|Restarting|Verifying|Continuing|Spinning|Setting up)/;
  function renderRow(row) {
    const type = row.type || "command";
    const msg = (row.message || "").trim();
    if (type === "user_message") return `<div class="ta-user">${renderUserMsg(msg)}</div>`;
    if (type === "ai_response") {
      const fail = msg.charAt(0) === "❌" || msg.indexOf("Build failed") === 0;
      return `<div class="ta-agent${fail ? " ta-agent-fail" : ""}"><div class="ta-agent-label">Agent</div><div class="markdown-content">${md(msg)}</div></div>`;
    }
    if (type === "cli_error") return `<div class="ta-error"><i class="fas fa-triangle-exclamation"></i> ${esc(msg)}</div>`;
    // command / tool row → ONE collapsible: the command as the header, its output as the body.
    const out = String(row.output || "");
    const hasOut = out.length > 0;
    const bodyText = hasOut ? out : msg;
    const isAction = hasOut || msg.charAt(0) === "$" || msg.charCodeAt(0) > 255 || ACTION_RE.test(msg);
    const id = "tarow-" + (++rowSeq);
    const label = esc(msg.length > 160 ? msg.slice(0, 160) + "…" : msg) || "(no output)";
    return `<div class="ta-cmdrow${isAction ? "" : " ta-outrow"}">
      <div class="ta-cmd-header" data-ta-toggle="${id}"><i class="fas fa-chevron-right ta-chev"></i><i class="fas ${isAction ? "fa-terminal" : "fa-angle-right"}" style="opacity:.55;font-size:11px;"></i><span class="ta-cmd-text">${label}</span></div>
      <div id="${id}" class="ta-cmd-body" style="display:none;">${esc(bodyText)}</div>
    </div>`;
  }

  // Render a user message: turn any attached image URL into an inline thumbnail and HIDE
  // the raw (presigned) URL from the text — it renders on reload (fixes "image disappeared
  // after refresh") and keeps the signed S3 URL out of the visible UI.
  const IMG_URL_RE = /(https?:\/\/[^\s)]+?\.(?:png|jpe?g|gif|webp))(\?[^\s)]*)?/gi;
  function renderUserMsg(msg) {
    const imgs = [];
    const stripped = String(msg || "").replace(IMG_URL_RE, (m, base, q) => { imgs.push(base + (q || "")); return "🖼️ image"; });
    let html = esc(stripped);
    for (const u of imgs) {
      html += `<div style="padding-top:8px;"><a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" loading="lazy" style="max-width:220px;max-height:180px;border-radius:8px;border:1px solid var(--border-color,#2a2a2a);display:block;"></a></div>`;
    }
    return html;
  }

  // ── File attachments (images/files for the agent) — supports MULTIPLE ───────
  let pendingUploads = [];
  let uploading = 0; // in-flight uploads (so the chip shows a spinner)
  function showAttachChip() {
    const chip = $("ta-attach-chip");
    if (!chip) return;
    if (!pendingUploads.length && !uploading) { chip.style.display = "none"; chip.innerHTML = ""; return; }
    chip.style.display = "flex";
    chip.style.flexWrap = "wrap";
    const pills = pendingUploads.map((u, i) =>
      `<span style="display:inline-flex;align-items:center;gap:5px;background:var(--border-color,#222);padding:2px 6px;border-radius:6px;"><i class="fas ${u.isImage ? "fa-image" : "fa-paperclip"}"></i>${esc(u.name)}<button data-ta-clearfile="${i}" title="Remove" style="background:none;border:none;color:var(--text-secondary,#9ca3af);cursor:pointer;padding:0 2px;"><i class="fas fa-times"></i></button></span>`
    ).join("");
    const spin = uploading ? `<span style="display:inline-flex;align-items:center;gap:5px;opacity:.7;"><i class="fas fa-spinner fa-spin"></i> Uploading ${uploading}…</span>` : "";
    chip.innerHTML = pills + spin;
  }
  async function uploadFile(file) {
    if (!file || !ticketId) return;
    uploading++; showAttachChip();
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch(`/api/projects/${PID()}/tickets/${ticketId}/chat/upload`, { method: "POST", body: fd, credentials: "same-origin" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "upload failed");
      pendingUploads.push({ path: j.path, url: j.url, name: file.name, isImage: j.isImage });
    } catch (e) { /* skip this file */ }
    finally { uploading = Math.max(0, uploading - 1); showAttachChip(); }
  }

  // Is the ticket chat currently open? (so the camera can route a screenshot here.)
  function isOpen() { const p = panel(); return !!ticketId && !!p && p.style.display !== "none"; }
  // Attach a captured preview screenshot as a pending image on the ticket chat.
  function attachScreenshot(url) {
    if (!url) return;
    pendingUploads.push({ path: null, url, name: "preview-screenshot.png", isImage: true });
    showAttachChip();
    const input = $("ta-input"); if (input) input.focus();
  }

  async function send() {
    const input = $("ta-input");
    if (!input) return;
    const typed = input.value.trim();
    let msg = typed;
    const uploads = pendingUploads.slice();
    if ((!msg && !uploads.length) || !ticketId) return;
    input.value = "";
    if (uploads.length) {
      const refs = uploads.map((u) => u.path
        ? `I uploaded a file to ${u.path} (original name: ${u.name}). Use it as needed.`
        : `I attached a file (${u.name}) available at ${u.url}. It will be placed in the sandbox on the next build.`);
      msg = (msg ? msg + "\n\n" : "") + refs.join("\n");
      pendingUploads = [];
      showAttachChip();
    }
    const area = $("ta-log");
    if (area) {
      const ph = area.querySelector("[data-empty]");
      if (ph) area.innerHTML = "";
      let bubble = `<div class="ta-user">${esc(typed || (uploads.length ? "(attachment)" : ""))}</div>`;
      const imgs = uploads.filter((u) => u.isImage && u.url);
      if (imgs.length) bubble += `<div class="ta-user" style="padding:0;background:none;display:flex;flex-wrap:wrap;gap:6px;">` +
        imgs.map((u) => `<a href="${esc(u.url)}" target="_blank" rel="noopener"><img src="${esc(u.url)}" alt="${esc(u.name)}" style="max-width:160px;max-height:140px;border-radius:8px;border:1px solid var(--border-color,#2a2a2a);display:block;"></a>`).join("") + `</div>`;
      area.insertAdjacentHTML("beforeend", bubble + `<div class="ta-thinking" id="ta-thinking"><i class="fas fa-spinner fa-spin"></i> Agent is working…</div>`);
      area.scrollTop = area.scrollHeight;
    }
    try {
      const r = await fetch(`/api/projects/${PID()}/tickets/${ticketId}/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
        body: JSON.stringify({ message: msg }),
      });
      if (!r.ok) { const t = $("ta-thinking"); if (t) t.textContent = "Couldn't reach the agent — try again."; }
    } catch (_) { const t = $("ta-thinking"); if (t) t.textContent = "Network error — try again."; }
    // Live WS updates replace the thinking row with the agent's streamed response.
  }

  // Live updates arrive over the chat page's existing WebSocket (chat.js routes the
  // per-user ticket_log/ticket_log_output/ticket_status events here). The interval is
  // just a slow safety net in case a socket message is missed.
  function onWs(msg) {
    if (!msg || !ticketId) return;
    if (msg.ticketId && msg.ticketId !== ticketId) return;
    if (msg.type === "ticket_log" && msg.log) {
      const area = $("ta-log");
      if (!area) return;
      const th = $("ta-thinking"); if (th) th.remove();
      const empty = area.querySelector("[data-empty]"); if (empty) area.innerHTML = "";
      const atBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 120;
      area.insertAdjacentHTML("beforeend", renderRow(msg.log));
      if (atBottom) area.scrollTop = area.scrollHeight;
    } else if (msg.type === "ticket_log_output" || msg.type === "ticket_status") {
      loadLog(); // authoritative refresh (folds tool output into its row / updates status)
    }
  }
  function startPoll() { stopPoll(); timer = setInterval(loadLog, 12000); } // WS is primary; this is a backstop
  function stopPoll() { if (timer) { clearInterval(timer); timer = null; } }

  window.TicketAgentChat = { open, close, send, onWs, isOpen, attachScreenshot };

  function wire() {
    $("ta-exit")?.addEventListener("click", close);
    $("ta-tabs")?.addEventListener("click", (e) => { const b = e.target.closest("[data-ta-tab]"); if (b) switchTicketTab(b.getAttribute("data-ta-tab")); });
    $("ta-send")?.addEventListener("click", send);
    $("ta-input")?.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
    $("ta-attach")?.addEventListener("click", () => $("ta-file")?.click());
    $("ta-file")?.addEventListener("change", (e) => { const fs = e.target.files ? Array.from(e.target.files) : []; fs.forEach(uploadFile); e.target.value = ""; });
    // Collapse/expand a command row's output; clear a pending upload.
    $("ta-log")?.addEventListener("click", (e) => {
      const h = e.target.closest && e.target.closest("[data-ta-toggle]");
      if (!h) return;
      const body = document.getElementById(h.getAttribute("data-ta-toggle"));
      const chev = h.querySelector(".ta-chev");
      if (body) { const openNow = body.style.display !== "none"; body.style.display = openNow ? "none" : "block"; if (chev) chev.style.transform = openNow ? "" : "rotate(90deg)"; }
    });
    $("ta-attach-chip")?.addEventListener("click", (e) => { const c = e.target.closest("[data-ta-clearfile]"); if (c) { const i = parseInt(c.getAttribute("data-ta-clearfile"), 10); if (i >= 0) pendingUploads.splice(i, 1); showAttachChip(); } });
    // Delegated, CAPTURE-phase so a [data-ta-chat] button opens the chat WITHOUT also
    // triggering its board card's own click (which opens the full ticket drawer).
    document.addEventListener("click", (e) => {
      const b = e.target.closest && e.target.closest("[data-ta-chat]");
      if (!b) return;
      e.stopPropagation();
      e.preventDefault();
      open(b.getAttribute("data-ta-chat"), b.getAttribute("data-ta-key"), b.getAttribute("data-ta-name"));
    }, true);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
