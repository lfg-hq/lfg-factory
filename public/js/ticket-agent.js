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

  function open(id, key, name) {
    ticketId = id;
    const p = panel();
    if (!p) return;
    const title = $("ta-title");
    if (title) title.textContent = (key ? key + " · " : "") + (name || "Ticket");
    p.style.display = "flex";
    const area = $("ta-log");
    if (area) area.innerHTML = '<div style="opacity:.5;padding:24px;text-align:center;">Loading…</div>';
    loadLog();
    startPoll();
    // Right panel → the live preview for THIS ticket's branch (render if running, else start).
    try {
      const tabBtn = document.querySelector('.tab-button[data-tab="preview"]');
      if (tabBtn) tabBtn.click();
      if (window.PreviewTab && window.PreviewTab.open) window.PreviewTab.open(id);
    } catch (_) {}
    const input = $("ta-input");
    if (input) setTimeout(() => input.focus(), 50);
  }

  function close() {
    const p = panel();
    if (p) p.style.display = "none";
    stopPoll();
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
    if (type === "user_message") return `<div class="ta-user">${esc(msg)}</div>`;
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

  // ── File upload (attach a file for the agent) ──────────────────────────────
  let pendingUpload = null;
  function showAttachChip() {
    const chip = $("ta-attach-chip");
    if (!chip) return;
    if (!pendingUpload) { chip.style.display = "none"; chip.innerHTML = ""; return; }
    chip.style.display = "flex";
    chip.innerHTML = `<i class="fas fa-paperclip"></i><span>${esc(pendingUpload.name)}</span><button data-ta-clearfile title="Remove" style="background:none;border:none;color:var(--text-secondary,#9ca3af);cursor:pointer;padding:0 4px;"><i class="fas fa-times"></i></button>`;
  }
  async function uploadFile(file) {
    if (!file || !ticketId) return;
    const chip = $("ta-attach-chip");
    if (chip) { chip.style.display = "flex"; chip.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Uploading ${esc(file.name)}…`; }
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch(`/api/projects/${PID()}/tickets/${ticketId}/chat/upload`, { method: "POST", body: fd, credentials: "same-origin" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "upload failed");
      pendingUpload = { path: j.path, url: j.url, name: file.name, isImage: j.isImage };
    } catch (e) { pendingUpload = null; }
    showAttachChip();
  }

  async function send() {
    const input = $("ta-input");
    if (!input) return;
    let msg = input.value.trim();
    if ((!msg && !pendingUpload) || !ticketId) return;
    input.value = "";
    const upload = pendingUpload;
    if (upload) {
      const ref = upload.path
        ? `I uploaded a file to ${upload.path} (original name: ${upload.name}). Use it as needed.`
        : `I attached a file (${upload.name}) available at ${upload.url}. It will be placed in the sandbox on the next build.`;
      msg = (msg ? msg + "\n\n" : "") + ref;
      pendingUpload = null;
      showAttachChip();
    }
    const area = $("ta-log");
    if (area) {
      const ph = area.querySelector("[data-empty]");
      if (ph) area.innerHTML = "";
      let bubble = `<div class="ta-user">${esc(input.value.trim() || (upload ? "(attachment)" : ""))}</div>`;
      if (upload && upload.isImage && upload.url) bubble += `<div class="ta-user" style="padding:0;background:none;"><a href="${esc(upload.url)}" target="_blank" rel="noopener"><img src="${esc(upload.url)}" alt="${esc(upload.name)}" style="max-width:220px;max-height:180px;border-radius:8px;border:1px solid var(--border-color,#2a2a2a);"></a></div>`;
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

  window.TicketAgentChat = { open, close, send, onWs };

  function wire() {
    $("ta-exit")?.addEventListener("click", close);
    $("ta-send")?.addEventListener("click", send);
    $("ta-input")?.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
    $("ta-attach")?.addEventListener("click", () => $("ta-file")?.click());
    $("ta-file")?.addEventListener("change", (e) => { const f = e.target.files && e.target.files[0]; if (f) uploadFile(f); e.target.value = ""; });
    // Collapse/expand a command row's output; clear a pending upload.
    $("ta-log")?.addEventListener("click", (e) => {
      const h = e.target.closest && e.target.closest("[data-ta-toggle]");
      if (!h) return;
      const body = document.getElementById(h.getAttribute("data-ta-toggle"));
      const chev = h.querySelector(".ta-chev");
      if (body) { const openNow = body.style.display !== "none"; body.style.display = openNow ? "none" : "block"; if (chev) chev.style.transform = openNow ? "" : "rotate(90deg)"; }
    });
    $("ta-attach-chip")?.addEventListener("click", (e) => { if (e.target.closest("[data-ta-clearfile]")) { pendingUpload = null; showAttachChip(); } });
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
