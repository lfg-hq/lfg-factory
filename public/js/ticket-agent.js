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
  let curKey = "";         // ticket key (e.g. CAL-10) for the title
  let activeTab = "details";
  let tasksLoaded = false, gitLoaded = false; // lazy-load Tasks/Git on first view
  // The opening tab is chosen from whether the ticket HAS activity, but the log count
  // isn't known until the first fetch returns. Stays true from open() until either that
  // fetch reconciles the tab or the user picks one themselves (whichever comes first).
  let autoTabPending = false;

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
      (desc ? `<div class="markdown-content" style="margin-top:14px;font-size:13px;color:var(--text-color,#cbd5e1);line-height:1.6;">${md(desc)}</div>` : '<div style="margin-top:14px;opacity:.5;font-size:12.5px;">No description.</div>') +
      `<div id="ta-refs" style="margin-top:14px;"></div>`;
    renderDocRefs(meta);
  }

  /**
   * Documents the ticket cites, as openable rows. The agent writes "Approved design
   * preview: document <uuid>" into the ticket text; the build agent gets the file, but
   * a person reading the ticket was left with a bare uuid.
   */
  function renderDocRefs(meta) {
    const host = $("ta-refs");
    if (!host || !meta) return;
    const text = [meta.name || "", meta.description || "", meta.notes || ""].join("\n");
    let ids = (text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [])
      .map((x) => x.toLowerCase());
    ids = ids.filter((x, i) => ids.indexOf(x) === i);
    if (!ids.length) return;

    const pid = (window.currentProjectId) || (location.pathname.split("/")[3] || "");
    if (!pid) return;
    fetch(`/projects/${pid}/api/files/browser`)
      .then((r) => r.json())
      .then((j) => {
        const hits = ((j && j.files) || []).filter((f) => ids.indexOf(String(f.id).toLowerCase()) !== -1);
        if (!hits.length) return;
        host.innerHTML =
          `<div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;opacity:.55;margin-bottom:6px;">Attached</div>` +
          hits.map((f) => {
            const icon = f.type === "page_preview" ? "fa-window-maximize" : "fa-file-lines";
            return `<a href="/projects/${esc(pid)}?tab=documents&file=${encodeURIComponent(f.id)}" target="_blank" rel="noopener"
              style="display:flex;align-items:center;gap:8px;padding:8px 10px;margin-bottom:6px;border:1px solid var(--border-color,#2a2a2a);border-radius:8px;text-decoration:none;color:var(--text-color,#e2e8f0);font-size:12.5px;">
              <i class="fas ${icon}" style="opacity:.7;font-size:11px;"></i>
              <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(f.name || "Document")}</span>
              <span style="flex:none;font-size:10.5px;opacity:.6;font-family:ui-monospace,Menlo,monospace;">${esc(f.type || "")}</span>
            </a>`;
          }).join("");
      })
      .catch(() => { /* the ticket still reads fine without this */ });
  }

  // ── Ticket actions (Build / Edit / Delete) — on THIS panel, not the list row ──
  function toast(msg) {
    const t = document.createElement("div");
    t.textContent = msg;
    t.style.cssText = "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:10001;background:#111;color:#fff;padding:9px 16px;border-radius:8px;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.3);";
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2000);
  }
  // A ticket is "building" while queued/executing or in progress → drives the Build button
  // spinner (and the Task List row indicator).
  function isBuilding(m) {
    m = m || curMeta || {};
    const q = String(m.queueStatus || m.queue_status || "").toLowerCase();
    const s = String(m.status || "").toLowerCase();
    return /^(queued|executing|building|running)$/.test(q) || /^(in_progress|building)$/.test(s);
  }
  // A chat message runs the agent WITHOUT moving queueStatus, so isBuilding() can't
  // see it. Track that turn locally so "Stop" is offered for a message too — not just
  // for a queued build. Cleared on the turn's terminal log (ai_response / cli_error).
  let chatBusy = false;
  function isBusy() { return chatBusy || isBuilding(); }
  function setBuildUI() {
    const s = $("ta-stop");
    if (s) { s.style.display = isBusy() ? "inline-flex" : "none"; s.disabled = false; s.innerHTML = '<i class="fas fa-stop" style="font-size:10px;"></i>Stop'; }
    const b = $("ta-build"); if (!b) return;
    if (isBuilding()) { b.disabled = true; b.style.opacity = ".9"; b.innerHTML = '<i class="fas fa-spinner fa-spin" style="font-size:10px;"></i>Building…'; }
    else { b.disabled = chatBusy; b.style.opacity = chatBusy ? ".55" : "1"; b.innerHTML = '<i class="fas fa-play" style="font-size:10px;"></i>Build'; }
  }
  // Stop whatever the agent is doing right now (build OR the in-flight chat turn).
  // Same endpoint the Task List drawer uses; it kills the in-VM agent and unblocks
  // the executor, which then bails cleanly instead of finishing the run.
  async function stopTicket() {
    if (!ticketId) return;
    const s = $("ta-stop");
    if (s) { s.disabled = true; s.innerHTML = '<i class="fas fa-spinner fa-spin" style="font-size:10px;"></i>Stopping…'; }
    try {
      const r = await fetch(`/api/projects/${PID()}/tickets/${ticketId}/stop`, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin" });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "failed"); }
      chatBusy = false;
      curMeta = Object.assign({}, curMeta, { queueStatus: "none", status: "open" }); // optimistic
      const t = $("ta-thinking"); if (t) t.remove(); // the turn is over — drop "Agent is working…"
      toast("Stopping the agent…");
    } catch (e) { toast("Couldn't stop: " + (e.message || e)); }
    setBuildUI();
    loadLog();
  }
  async function buildTicket() {
    if (!ticketId || isBuilding()) return;
    try {
      const r = await fetch(`/api/projects/${PID()}/tickets/${ticketId}/queue`, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: "{}" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "failed");
      curMeta = Object.assign({}, curMeta, { queueStatus: "queued", status: "in_progress" }); // optimistic
      setBuildUI();
      renderMeta(curMeta);
      toast("Queued for build — watch the Actions tab.");
      switchTicketTab("actions");
      try { if (window.ArtifactsLoader && window.ArtifactsLoader._checklistProjectId) window.ArtifactsLoader.loadChecklist(window.ArtifactsLoader._checklistProjectId); } catch (_) {}
    } catch (e) { toast("Couldn't queue: " + (e.message || e)); setBuildUI(); }
  }
  async function deleteTicket() {
    if (!ticketId) return;
    if (!window.confirm("Delete this ticket? This can't be undone.")) return;
    try {
      const r = await fetch(`/api/projects/${PID()}/tickets/${ticketId}`, { method: "DELETE", credentials: "same-origin" });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "failed"); }
      toast("Ticket deleted.");
      close();
      // Refresh the Task List so the row disappears.
      try { if (window.ArtifactsLoader && window.ArtifactsLoader._checklistProjectId) window.ArtifactsLoader.loadChecklist(window.ArtifactsLoader._checklistProjectId); } catch (_) {}
    } catch (e) { toast("Couldn't delete: " + (e.message || e)); }
  }
  // Open this ticket's branch in the right-hand Preview panel — switch to the Preview tab and
  // let PreviewTab render it (it starts the branch's preview if it isn't already running).
  function previewTicket() {
    if (!ticketId) return;
    try {
      const tabBtn = document.querySelector('.tab-button[data-tab="preview"]');
      if (tabBtn) tabBtn.click();
      if (window.PreviewTab && window.PreviewTab.open) window.PreviewTab.open(ticketId);
      else toast("Preview panel isn't ready yet — open the Preview tab and try again.");
    } catch (_) { toast("Couldn't open the preview."); }
  }
  // Inline edit — turn the Details pane into an editable form (no separate modal/drawer).
  let editing = false;
  function toggleEdit() {
    if (!curMeta) { toast("No editable fields here."); return; }
    editing = !editing;
    switchTicketTab("details");
    if (editing) renderEditForm(); else renderMeta(curMeta);
    const eb = $("ta-edit"); if (eb) eb.innerHTML = editing ? '<i class="fas fa-xmark" style="font-size:12px;"></i>Cancel' : '<i class="fas fa-pen" style="font-size:11px;"></i>Edit';
  }
  function renderEditForm() {
    const el = $("ta-pane-details"); if (!el) return;
    const m = curMeta || {};
    const opt = (v, cur) => `<option value="${esc(v)}"${String(cur).toLowerCase() === v.toLowerCase() ? " selected" : ""}>${esc(v)}</option>`;
    const fieldStyle = "width:100%;height:34px;padding:0 10px;border-radius:8px;background:var(--background-surface,#0f0f0f);border:1px solid var(--border-color,#333);color:var(--text-color,#e2e8f0);font-size:13px;";
    el.innerHTML =
      `<label style="display:block;font-size:11px;color:var(--text-secondary,#9ca3af);margin-bottom:4px;">Name</label>` +
      `<input id="ta-edit-name" style="${fieldStyle}margin-bottom:12px;" value="${esc(m.name || "")}" />` +
      `<div style="display:flex;gap:10px;margin-bottom:12px;">` +
        `<div style="flex:1;"><label style="display:block;font-size:11px;color:var(--text-secondary,#9ca3af);margin-bottom:4px;">Status</label><select id="ta-edit-status" style="${fieldStyle}">${["open", "in_progress", "review", "done", "blocked"].map((s) => opt(s, m.status || "open")).join("")}</select></div>` +
        `<div style="flex:1;"><label style="display:block;font-size:11px;color:var(--text-secondary,#9ca3af);margin-bottom:4px;">Priority</label><select id="ta-edit-priority" style="${fieldStyle}">${["High", "Medium", "Low"].map((s) => opt(s, m.priority || "Medium")).join("")}</select></div>` +
      `</div>` +
      `<label style="display:block;font-size:11px;color:var(--text-secondary,#9ca3af);margin-bottom:4px;">Description (Markdown)</label>` +
      `<textarea id="ta-edit-desc" style="${fieldStyle}height:220px;padding:10px;line-height:1.5;resize:vertical;font-family:inherit;">${esc(m.description || "")}</textarea>` +
      `<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">` +
        `<button id="ta-edit-save" style="height:34px;padding:0 16px;border-radius:8px;cursor:pointer;background:#7c3aed;color:#fff;border:none;font-size:13px;font-weight:600;">Save</button>` +
      `</div>`;
    $("ta-edit-save")?.addEventListener("click", saveEdit);
  }
  async function saveEdit() {
    if (!ticketId) return;
    const body = {
      name: ($("ta-edit-name") || {}).value,
      status: ($("ta-edit-status") || {}).value,
      priority: ($("ta-edit-priority") || {}).value,
      description: ($("ta-edit-desc") || {}).value,
    };
    const btn = $("ta-edit-save"); if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
    try {
      const r = await fetch(`/api/projects/${PID()}/tickets/${ticketId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(body) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "failed"); }
      curMeta = Object.assign({}, curMeta, body);
      const title = $("ta-title"); if (title && body.name) title.textContent = (curKey ? curKey + " · " : "") + body.name;
      editing = false;
      const eb = $("ta-edit"); if (eb) eb.innerHTML = '<i class="fas fa-pen" style="font-size:11px;"></i>Edit';
      renderMeta(curMeta);
      toast("Saved.");
      try { if (window.ArtifactsLoader && window.ArtifactsLoader._checklistProjectId) window.ArtifactsLoader.loadChecklist(window.ArtifactsLoader._checklistProjectId); } catch (_) {}
    } catch (e) { toast("Couldn't save: " + (e.message || e)); if (btn) { btn.disabled = false; btn.textContent = "Save"; } }
  }

  // ── Tabs: Details / Actions (agent chat) / Tasks / Git ─────────────────────
  var TAB_KEY = "lfg_drawer_tab";   // shared with the tickets-page drawer
  function rememberTab(tab) { try { sessionStorage.setItem(TAB_KEY, tab); } catch (e) {} }
  function preferredTab() {
    try { return sessionStorage.getItem(TAB_KEY) || ""; } catch (e) { return ""; }
  }

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
  // Opening tab: Actions when the ticket has activity to read, Details when it doesn't.
  // The real answer is the log count, which needs a round-trip — so seed from status
  // (anything past "open" implies a build already ran) to avoid a visible tab jump in
  // the common case, then applyAutoTab() corrects it once the count actually lands.
  function seedTab(meta) {
    const s = String((meta && meta.status) || "open").toLowerCase();
    return s === "open" ? "details" : "actions";
  }
  function applyAutoTab(count) {
    // A tab you chose yourself outranks the guess — that's the whole point of it
    // sticking. Only auto-pick when you haven't expressed a preference this session.
    if (preferredTab()) { autoTabPending = false; return; }
    if (!autoTabPending) return;
    autoTabPending = false;
    const want = count > 0 ? "actions" : "details";
    if (activeTab !== want) switchTicketTab(want);
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
    curKey = key || "";
    editing = false;
    const eb0 = $("ta-edit"); if (eb0) eb0.innerHTML = '<i class="fas fa-pen" style="font-size:11px;"></i>Edit';
    tasksLoaded = false; gitLoaded = false;
    chatBusy = false; // per-ticket state — a previous ticket's in-flight turn isn't this one's
    setBuildUI();
    const p = panel();
    if (!p) return;
    const title = $("ta-title");
    if (title) title.textContent = (key ? key + " · " : "") + (name || "Ticket");
    renderMeta(meta);
    // Opened without fields (e.g. from the preview's "Chat with ticket") → fetch them so
    // Details/Edit still work.
    if (!meta) {
      fetch(`/projects/${PID()}/api/checklist/${id}`, { credentials: "same-origin" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!d || !d.ticket || ticketId !== id) return;
          const t = d.ticket;
          curMeta = { name: t.name, description: t.description, status: t.status, priority: t.priority, queueStatus: t.queueStatus, createdAt: t.createdAt, updatedAt: t.updatedAt, attachments: [] };
          if (!editing) renderMeta(curMeta);
          setBuildUI();
        }).catch(() => {});
    }
    p.style.display = "flex";
    const area = $("ta-log");
    if (area) area.innerHTML = '<div style="opacity:.5;padding:24px;text-align:center;">Loading…</div>';
    // "Chat with ticket" means you came to chat → Actions, no second-guessing. From a
    // ticket row, open on whichever tab has something to show (see seedTab/applyAutoTab).
    // Set BEFORE loadLog() so the flag can't be read by its continuation before it exists.
    autoTabPending = !opts.withPreview;
    // "Chat with ticket" always means Actions. Otherwise: your remembered tab if you
    // have one, else the seeded guess.
    var want = opts.withPreview ? "actions" : (preferredTab() || seedTab(meta));
    if (preferredTab()) autoTabPending = false;
    switchTicketTab(want);
    loadLog();
    startPoll();
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
      if (Array.isArray(rows)) { renderAll(rows); applyAutoTab(rows.length); }
    } catch (_) { /* keep last render — a later poll retries the auto-tab */ }
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
    chatBusy = true; setBuildUI(); // reveal Stop — this turn is now running
    try {
      const r = await fetch(`/api/projects/${PID()}/tickets/${ticketId}/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
        body: JSON.stringify({ message: msg }),
      });
      if (!r.ok) { const t = $("ta-thinking"); if (t) t.textContent = "Couldn't reach the agent — try again."; chatBusy = false; setBuildUI(); }
    } catch (_) { const t = $("ta-thinking"); if (t) t.textContent = "Network error — try again."; chatBusy = false; setBuildUI(); }
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
      // Terminal row for a chat turn → the agent is done, hide Stop.
      const lt = msg.log.type || "";
      if (lt === "ai_response" || lt === "cli_error") { chatBusy = false; setBuildUI(); }
    } else if (msg.type === "ticket_status") {
      curMeta = Object.assign({}, curMeta, { status: msg.status, queueStatus: msg.queueStatus }); // reflect build state
      if (String(msg.status || "").toLowerCase() === "stopped") chatBusy = false;
      setBuildUI();
      loadLog();
    } else if (msg.type === "ticket_log_output") {
      loadLog(); // authoritative refresh (folds tool output into its row)
    }
  }
  function startPoll() { stopPoll(); timer = setInterval(loadLog, 12000); } // WS is primary; this is a backstop
  function stopPoll() { if (timer) { clearInterval(timer); timer = null; } }

  window.TicketAgentChat = { open, close, send, onWs, isOpen, attachScreenshot, stop: stopTicket };

  function wire() {
    $("ta-exit")?.addEventListener("click", close);
    $("ta-build")?.addEventListener("click", buildTicket);
    $("ta-stop")?.addEventListener("click", stopTicket);
    $("ta-edit")?.addEventListener("click", toggleEdit);
    $("ta-preview")?.addEventListener("click", previewTicket);
    $("ta-delete")?.addEventListener("click", deleteTicket);
    // A deliberate tab choice outranks the pending auto-switch — never yank the panel
    // out from under someone who just clicked Details while the logs were still loading.
    $("ta-tabs")?.addEventListener("click", (e) => { const b = e.target.closest("[data-ta-tab]"); if (b) { autoTabPending = false; rememberTab(b.getAttribute("data-ta-tab")); switchTicketTab(b.getAttribute("data-ta-tab")); } });
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
