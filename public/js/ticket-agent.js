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

  function renderRow(row) {
    const type = row.type || "command";
    const msg = (row.message || "").trim();
    if (type === "user_message") return `<div class="ta-user">${esc(msg)}</div>`;
    if (type === "ai_response") return `<div class="ta-agent"><div class="ta-agent-label">Agent</div><div class="markdown-content">${md(msg)}</div></div>`;
    // command / tool output / other → a compact monospace row
    let html = "";
    if (msg) html += `<div class="ta-cmd"><i class="fas fa-angle-right" style="opacity:.5;margin-right:6px;"></i>${esc(msg)}</div>`;
    if (row.output) html += `<div class="ta-out">${esc(String(row.output).slice(0, 4000))}</div>`;
    return html || "";
  }

  async function send() {
    const input = $("ta-input");
    if (!input) return;
    const msg = input.value.trim();
    if (!msg || !ticketId) return;
    input.value = "";
    const area = $("ta-log");
    if (area) {
      const ph = area.querySelector("[data-empty]");
      if (ph) area.innerHTML = "";
      area.insertAdjacentHTML("beforeend", `<div class="ta-user">${esc(msg)}</div><div class="ta-thinking" id="ta-thinking"><i class="fas fa-spinner fa-spin"></i> Agent is working…</div>`);
      area.scrollTop = area.scrollHeight;
    }
    try {
      const r = await fetch(`/api/projects/${PID()}/tickets/${ticketId}/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
        body: JSON.stringify({ message: msg }),
      });
      if (!r.ok) { const t = $("ta-thinking"); if (t) t.textContent = "Couldn't reach the agent — try again."; }
    } catch (_) { const t = $("ta-thinking"); if (t) t.textContent = "Network error — try again."; }
    // The 3s poll picks up the agent's streamed response + the thinking row gets replaced.
  }

  function startPoll() { stopPoll(); timer = setInterval(loadLog, 3000); }
  function stopPoll() { if (timer) { clearInterval(timer); timer = null; } }

  window.TicketAgentChat = { open, close, send };

  function wire() {
    $("ta-exit")?.addEventListener("click", close);
    $("ta-send")?.addEventListener("click", send);
    $("ta-input")?.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
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
