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
  let taskRequest = 0;
  // The opening tab is chosen from whether the ticket HAS activity, but the log count
  // isn't known until the first fetch returns. Stays true from open() until either that
  // fetch reconciles the tab or the user picks one themselves (whichever comes first).
  let autoTabPending = false;

  // The ticket is positioned inside .chat-body, which already excludes the right
  // panel through its parent's padding. Keep the template's 12px inset: subtracting
  // the panel width here again collapses the ticket when the workspace is open.
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
    const savedCriteria = meta.acceptanceCriteria ?? meta.acceptance_criteria;
    const criteria = Array.isArray(savedCriteria) ? savedCriteria.filter(c => typeof c === "string" && c.trim()) : [];
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
      `<section aria-label="Acceptance criteria" style="margin-top:18px;font-size:13px;line-height:1.6;">` +
        `<h3 style="font-size:13px;margin:0 0 8px;">Acceptance criteria</h3>` +
        (criteria.length ? `<ol style="margin:0;padding-left:22px;">${criteria.map(c => `<li style="margin-bottom:6px;">${esc(c)}</li>`).join("")}</ol>` :
          `<p style="margin:0;color:var(--text-secondary,#9ca3af);">No acceptance criteria have been saved for this ticket.</p>`) +
      `</section>` +
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
    const linkedIds = meta.details && Array.isArray(meta.details.sourceDocumentIds) ? meta.details.sourceDocumentIds : [];
    ids = [...ids, meta.sourceDocumentId, ...linkedIds].filter(x => typeof x === "string" && x).map(x => x.toLowerCase());
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
  // for a queued build. Cleared by executor state after the whole turn finishes.
  let chatBusy = false;
  function isBusy() { return chatBusy || isBuilding(); }
  function hasPreviousBuild(m) {
    m = m || {};
    return !!(m.githubCommitSha || m.github_commit_sha || m.lastExecutionAt || m.last_execution_at)
      || /^(review|in_review|done|completed|archived)$/.test(String(m.status || "").toLowerCase());
  }
  let buildPending = false;
  function setBuildUI() {
    const s = $("ta-stop");
    if (s) { s.style.display = isBusy() ? "inline-flex" : "none"; s.disabled = false; s.innerHTML = '<i class="fas fa-stop" style="font-size:10px;"></i>Stop'; }
    // The send arrow becomes a red STOP while the agent is working: you can't queue a
    // second message (that used to start a second agent in the same sandbox), but you
    // can stop this turn — and whatever you've typed is sent the moment it stops.
    const send = $("ta-send");
    if (send) {
      const busy = isBusy();
      send.style.background = busy ? "#dc2626" : "#7c3aed";
      send.title = busy ? "Stop the agent (your message sends right after)" : "Send";
      send.innerHTML = busy ? '<i class="fas fa-stop" style="font-size:11px;"></i>' : '<i class="fas fa-arrow-up"></i>';
    }
    const input = $("ta-input");
    if (input) {
      input.placeholder = isBusy() ? "Agent is working — press ■ to stop and send…" : "Send a message to the agent…";
    }
    renderChecksButton();
    const b = $("ta-build"); if (!b) return;
    if (isBusy()) { b.disabled = true; b.style.opacity = ".9"; b.innerHTML = '<i class="fas fa-spinner fa-spin" style="font-size:10px;"></i>' + (isBuilding() ? "Building…" : "Working…"); }
    else { b.disabled = chatBusy || buildPending; b.style.opacity = b.disabled ? ".55" : "1"; b.innerHTML = '<i class="fas fa-play" style="font-size:10px;"></i>' + (hasPreviousBuild(curMeta) ? "Re-build" : "Build"); b.title = hasPreviousBuild(curMeta) ? "Re-build this ticket" : "Build this ticket"; }
  }
  // Checks for this ticket: its own on/off choice, or the project default.
  function checksOn(m) { return !!m && (m.validationEnabled !== false || m.featureTestingEnabled !== false); }
  function renderChecksButton() {
    const b = $("ta-checks"); if (!b) return;
    if (!curMeta || curMeta.checksMode === undefined) { b.style.display = "none"; return; }
    const on = checksOn(curMeta);
    b.style.display = "inline-flex";
    b.setAttribute("aria-pressed", String(on));
    b.querySelector(".ta-checks-label").textContent = on ? "Checks on" : "Checks off";
    const icon = b.querySelector(".ta-checks-icon");
    icon.className = "fas ta-checks-icon " + (on ? "fa-toggle-on" : "fa-toggle-off"); icon.style.color = on ? "#16a34a" : "#94a3b8";
    b.title = (on ? "Checks run after this ticket builds" : "This ticket builds without checks") +
      (curMeta.checksMode === "project" ? " (project default). Click to change for this ticket only." : " (set for this ticket). Click to switch.");
    b.disabled = isBusy();
  }
  async function loadChecksSetting() {
    if (!ticketId) return;
    const id = ticketId;
    try {
      const r = await fetch(`/api/projects/${PID()}/tickets/${id}`, { credentials: "same-origin" });
      if (!r.ok || id !== ticketId) return;
      const t = (await r.json()).ticket || {};
      curMeta = Object.assign({}, curMeta, { checksMode: t.checksMode, validationEnabled: t.validationEnabled, featureTestingEnabled: t.featureTestingEnabled, projectChecksEnabled: t.projectChecksEnabled });
      renderChecksButton();
    } catch (_) {}
  }
  async function toggleChecks() {
    if (!ticketId || !curMeta || isBusy()) return;
    const want = !checksOn(curMeta);
    // Back to the project default when that already matches; otherwise pin this ticket.
    const mode = want === !!curMeta.projectChecksEnabled ? "project" : (want ? "on" : "off");
    const b = $("ta-checks"); if (b) b.disabled = true;
    try {
      const r = await fetch(`/api/projects/${PID()}/tickets/${ticketId}/checks`, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ mode }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "failed");
      curMeta = Object.assign({}, curMeta, { checksMode: j.checksMode, validationEnabled: j.validationEnabled, featureTestingEnabled: j.featureTestingEnabled });
      toast(want ? "Checks will run after this ticket builds." : "This ticket will build without checks.");
      if (currentLogRows.length) renderAll(currentLogRows);
    } catch (e) { toast("Couldn't change checks: " + (e.message || e)); }
    renderChecksButton();
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
    if (!ticketId || isBusy() || buildPending) return;
    if (hasPreviousBuild(curMeta) && !window.confirm("Re-build this ticket? The agent will run again on its existing branch and may make additional code changes.")) return;
    const buildingId = ticketId;
    buildPending = true;
    setBuildUI();
    try {
      const r = await fetch(`/api/projects/${PID()}/tickets/${ticketId}/queue`, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: "{}" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "failed");
      if (ticketId !== buildingId) return;
      curMeta = Object.assign({}, curMeta, { queueStatus: "queued", status: "in_progress" }); // optimistic
      setBuildUI();
      renderMeta(curMeta);
      toast("Queued for build — watch the Actions tab.");
      switchTicketTab("actions");
      try { if (window.ArtifactsLoader && window.ArtifactsLoader._checklistProjectId) window.ArtifactsLoader.loadChecklist(window.ArtifactsLoader._checklistProjectId); } catch (_) {}
    } catch (e) { toast("Couldn't queue: " + (e.message || e)); }
    finally { buildPending = false; setBuildUI(); }
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

  async function loadTasks(quiet = false) {
    const el = $("ta-pane-tasks");
    if (!el || !ticketId) return;
    const id = ticketId, request = ++taskRequest;
    if (!quiet) el.innerHTML = '<div style="opacity:.5;padding:20px;text-align:center;">Loading tasks…</div>';
    try {
      const r = await fetch(`/api/projects/${PID()}/tickets/${id}/tasks`, { credentials: "same-origin" });
      if (!r.ok) throw new Error('Task request failed');
      const rows = await r.json();
      if (ticketId !== id || request !== taskRequest) return;
      if (!Array.isArray(rows) || !rows.length) { el.innerHTML = '<div style="opacity:.55;padding:24px;text-align:center;">No tasks yet.</div>'; setTabCount("tasks", 0); return; }
      const dot = (s) => { s = (s || "").toLowerCase(); const c = s === "success" ? "#22c55e" : s === "in_progress" ? "#3b82f6" : s === "fail" ? "#ef4444" : "#6b7280"; return `<span style="width:8px;height:8px;border-radius:50%;background:${c};flex:none;margin-top:5px;"></span>`; };
      el.innerHTML = rows.map((t) => `<div style="display:flex;gap:9px;padding:8px 0;border-bottom:1px solid var(--border-color,#2a2a2a);">${dot(t.status)}<span style="font-size:13px;color:var(--text-color,#cbd5e1);line-height:1.45;${/success/i.test(t.status) ? "opacity:.55;text-decoration:line-through;" : ""}">${esc(t.description || "")}</span></div>`).join("");
      setTabCount("tasks", rows.length);
    } catch (e) { if (!quiet && ticketId === id && request === taskRequest) el.innerHTML = '<div style="opacity:.55;padding:24px;text-align:center;">Couldn\'t load tasks.</div>'; }
  }

  function renderDiff(diff) {
    return String(diff).slice(0, 60000).split("\n").map((ln) => {
      const e = esc(ln);
      if (ln.startsWith("+") && !ln.startsWith("+++")) return `<span class="ta-git-add">${e}</span>`;
      if (ln.startsWith("-") && !ln.startsWith("---")) return `<span class="ta-git-del">${e}</span>`;
      if (ln.startsWith("@@")) return `<span class="ta-git-hunk">${e}</span>`;
      return e;
    }).join("\n");
  }
  // Split a unified diff into per-file patches, keyed by the new path.
  function patchesByFile(diff) {
    const map = {};
    for (const part of String(diff || "").split(/\n(?=diff --git )/)) {
      const m = part.match(/^diff --git a\/.+? b\/(.+)\n/); if (!m) continue;
      map[m[1]] = part.split("\n").filter((l) => !/^(diff --git|--- |\+\+\+ |index )/.test(l)).join("\n");
    }
    return map;
  }
  function relTime(sec) {
    if (!sec) return "";
    const d = Math.max(0, Date.now() / 1000 - sec);
    return d < 3600 ? Math.max(1, Math.round(d / 60)) + "m ago" : d < 86400 ? Math.round(d / 3600) + "h ago" : Math.round(d / 86400) + "d ago";
  }
  async function loadGit() {
    const el = $("ta-pane-git");
    if (!el || !ticketId) return;
    const id = ticketId;
    el.innerHTML = '<div class="ta-git-empty"><i class="fas fa-spinner fa-spin"></i> Reading the branch from GitHub…</div>';
    try {
      const r = await fetch(`/api/projects/${PID()}/tickets/${id}/git/diff`, { credentials: "same-origin" });
      const d = await r.json();
      if (ticketId !== id) return;
      if (d.error) { el.innerHTML = `<div class="ta-git-empty">${esc(d.error)}</div>`; return; }
      const files = Array.isArray(d.files) ? d.files : [];
      const commits = Array.isArray(d.commits) ? d.commits : [];
      const added = files.reduce((n, f) => n + (f.added || 0), 0), removed = files.reduce((n, f) => n + (f.removed || 0), 0);
      const patches = patchesByFile(d.diff);
      let html = `<div class="ta-git-head">
        <div class="ta-git-route"><i class="fas fa-code-branch"></i><code>${esc(d.head || "")}</code><i class="fas fa-arrow-right ta-git-arrow"></i><code>${esc(d.base || "main")}</code>${d.merged ? '<span class="ta-git-badge is-merged">Merged</span>' : '<span class="ta-git-badge">Not merged</span>'}</div>
        <div class="ta-git-stats"><span>${files.length} file${files.length !== 1 ? "s" : ""}</span><span class="ta-git-add">+${added}</span><span class="ta-git-del">−${removed}</span><span>${commits.length} commit${commits.length !== 1 ? "s" : ""}</span>${d.compareUrl ? `<a href="${esc(d.compareUrl)}" target="_blank" rel="noopener">View on GitHub <i class="fas fa-arrow-up-right-from-square"></i></a>` : ""}</div>
      </div>`;
      if (commits.length) html += `<div class="ta-git-section"><div class="ta-git-label">Commits</div>${commits.map((c) => `<div class="ta-git-commit"><code>${esc(c.sha || "")}</code><span>${esc(c.subject || "")}</span><small>${esc(relTime(c.when))}</small></div>`).join("")}</div>`;
      if (files.length) html += `<div class="ta-git-section"><div class="ta-git-label">Files changed</div>${files.map((f) => {
        const patch = patches[f.path];
        return `<details class="ta-git-file"><summary><i class="fas fa-chevron-right ta-chev"></i><span class="ta-git-path">${esc(f.path)}</span><span class="ta-git-add">+${f.added}</span><span class="ta-git-del">−${f.removed}</span></summary>${patch ? `<pre>${renderDiff(patch)}</pre>` : '<p class="ta-git-empty">No text diff for this file.</p>'}</details>`;
      }).join("")}</div>`;
      else html += '<div class="ta-git-empty">No file changes on this branch yet.</div>';
      el.innerHTML = html;
      setTabCount("git", files.length);
    } catch (e) { if (ticketId === id) el.innerHTML = '<div class="ta-git-empty">Couldn\'t load the changes. Try the tab again.</div>'; }
  }

  function open(id, key, name, meta, opts) {
    opts = opts || {};
    ticketId = id;
    curMeta = meta || null;
    currentLogRows = [];
    curKey = key || "";
    editing = false;
    const eb0 = $("ta-edit"); if (eb0) eb0.innerHTML = '<i class="fas fa-pen" style="font-size:11px;"></i>Edit';
    tasksLoaded = false; gitLoaded = false;
    chatBusy = meta?.agentBusy === true;
    setBuildUI();
    void loadChecksSetting();
    // A turn started before this page loaded is still running server-side — ask, so the
    // button opens as Stop instead of inviting a second message that would be rejected.
    fetch(`/api/projects/${PID()}/tickets/${id}/chat/status`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && ticketId === id) { chatBusy = !!d.busy; setBuildUI(); } })
      .catch(() => {});
    const p = panel();
    if (!p) return;
    const title = $("ta-title");
    if (title) title.textContent = (key ? key + " · " : "") + (name || "Ticket");
    renderMeta(meta);
    // Refresh authoritative build history even when a checklist supplied cached metadata.
    {
      fetch(`/api/projects/${PID()}/tickets/${id}`, { credentials: "same-origin" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!d || !d.ticket || ticketId !== id) return;
          const t = d.ticket;
          curMeta = Object.assign({}, curMeta, t, { attachments: (curMeta && curMeta.attachments) || [] });
          if (!editing) renderMeta(curMeta);
          setBuildUI();
          renderAll(currentLogRows);
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
    // Track actual size changes, including CSS transitions and either resize handle.
    if (art && !fitObs) { fitObs = new ResizeObserver(syncChatPadding); fitObs.observe(art); }
    window.addEventListener("resize", syncChatPadding);
    const input = $("ta-input");
    if (input) setTimeout(() => input.focus(), 80);
  }

  function close() {
    const p = panel();
    if (p) p.style.display = "none";
    renderMeta(null);
    stopPoll();
    if (fitObs) { fitObs.disconnect(); fitObs = null; }
    window.removeEventListener("resize", syncChatPadding);
    const art = document.getElementById("artifacts-panel");
    if (art && prevArtWidth !== null) { art.style.width = prevArtWidth; prevArtWidth = null; } // restore the preview width
    syncChatPadding(); // reflow the chat to the restored panel width (no dead gap)
    ticketId = null;
  }

  async function loadLog() {
    if (!ticketId) return;
    const requestedTicket = ticketId;
    try {
      const rows = await window.TicketActionPhases.load(`/api/projects/${PID()}/tickets/${ticketId}/logs`);
      if (ticketId === requestedTicket && Array.isArray(rows)) { renderAll(rows); applyAutoTab(rows.length); }
    } catch (_) { /* keep last render — a later poll retries the auto-tab */ }
  }

  // Stable job identities fold polling snapshots without hiding distinct commands/retries.
  let currentLogRows = [];
  function groupOperations(rows) {
    const result = [], jobs = new Map();
    for (const row of rows) {
      const match = String(row.message || "").match(/^Background job ([a-zA-Z0-9-]+) (.*)/s);
      if (!match || (row.type && row.type !== "command")) {
        if (["ai_response", "cli_error", "user_message"].includes(row.type)) {
          for (const job of jobs.values()) if (job.jobStatus && job.jobStatus.startsWith("Running")) job.jobStatus = "Completion not recorded";
          jobs.clear();
        }
        result.push(row); continue;
      }
      let job = jobs.get(match[1]);
      if (!job) {
        job = Object.assign({}, row, { id: "job-" + match[1], message: "Background operation", output: "", job: true });
        jobs.set(match[1], job); result.push(job);
      }
      if (match[2].startsWith("started; command: ")) job.message = match[2].slice(18).split("; logs:")[0];
      job.output = match[2];
      job.jobStatus = match[2].startsWith("finished") ? (match[2].includes("exit 0,") ? "Completed" : "Failed") : "Running · waiting for completion";
    }
    return mergeActionResults(result);
  }

  // One row per action: a tool logs "Editing x", then its result, often "Editing x" again.
  // Fold the result into the action and drop the repeat, so each step reads once.
  const TAG_RE = /^\[(Validation|Feature testing)\]\s*/;
  function isActionText(text) { return text.charAt(0) === "$" || ACTION_RE.test(text); }
  function mergeActionResults(rows) {
    const out = []; let last = null;
    for (const row of rows) {
      const type = row.type || "command";
      const msg = String(row.message || "").trim();
      const text = msg.replace(TAG_RE, "");
      if (type !== "command" || row.job) { out.push(row); last = null; continue; }
      if (isActionText(text)) {
        const tag = (msg.match(TAG_RE) || [""])[0];
        if (last && last.text === text && last.tag === tag) { if (row.output && !last.row.output) last.row.output = row.output; continue; }
        const copy = Object.assign({}, row, { action: true });
        out.push(copy); last = { row: copy, text, tag }; continue;
      }
      if (last && !last.row.resultText && !/^(The |I['’]|I )/.test(text) && text.split(" ").length < 40) {
        last.row.resultText = text;
        last.row.output = last.row.output ? last.row.output + "\n" + text : text;
        continue;
      }
      out.push(row); last = null;
    }
    return out;
  }
  function resultSummary(row) {
    const r = String(row.resultText || "");
    if (row.jobStatus) return row.jobStatus;
    if (row.exitCode != null) return row.exitCode === 0 ? "done" : "failed";
    let m;
    if ((m = r.match(/^Successfully wrote (\d+) bytes/))) return (+m[1] >= 1024 ? (+m[1] / 1024).toFixed(1) + " KB" : m[1] + " B") + " written";
    if ((m = r.match(/^Successfully replaced (\d+) block/))) return m[1] + (m[1] === "1" ? " change" : " changes");
    if (/^Command failed|error|failed/i.test(r)) return "failed";
    if (r === "(no output)") return "done";
    return r ? "output" : "";
  }
  const VERB_ICONS = [[/^Editing/, "fa-pen"], [/^(Creating|Writing)/, "fa-file-circle-plus"], [/^(Reading|Listing|Searching|Inspecting|Checking)/, "fa-eye"], [/^Browser:/, "fa-globe"],
    [/^(Committing|Committed)/, "fa-code-commit"], [/^(Merging|Merged)/, "fa-code-merge"], [/^(Pushing|Pushed)/, "fa-cloud-arrow-up"],
    [/^(Installing|Building|Build|Starting|Started|Spinning|Setting up|Restarting)/, "fa-gear"]];

  function renderAll(rows) {
    const area = $("ta-log");
    if (!area) return;
    currentLogRows = rows;
    const expanded = new Set(Array.from(area.querySelectorAll(".ta-cmd-body")).filter(el => el.style.display !== "none").map(el => el.id));
    const atBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 100;
    window.TicketActionPhases.render(area, groupOperations(rows), curMeta, 'chat:' + ticketId, row => {
      const holder = document.createElement('div'); holder.innerHTML = renderRow(row);
      return holder.firstElementChild;
    }, `/api/projects/${PID()}/tickets/${ticketId}/logs`, loadLog);
    for (const id of expanded) { const body = document.getElementById(id); if (body) body.style.display = "block"; }
    if (atBottom) area.scrollTop = area.scrollHeight;
  }

  let rowSeq = 0;
  const ACTION_RE = /^(Running|Reading|Editing|Writing|Creating|Searching|Listing|Merging|Merged|Committing|Committed|Pushed|Pushing|Building|Build |Installing|Started|Starting|Cloning|Fetching|Restarting|Verifying|Continuing|Spinning|Setting up|Inspecting|Checking|Browser:)/;
  function renderRow(row) {
    const type = row.type || "command";
    const msg = (row.message || "").trim();
    if (type === "user_message") return `<div class="ta-user">${renderUserMsg(msg)}</div>`;
    if (type === "ai_response" || type === "agent_progress") {
      const fail = msg.charAt(0) === "❌" || msg.indexOf("Build failed") === 0;
      return `<div class="ta-agent${fail ? " ta-agent-fail" : ""}"><div class="ta-agent-label">Agent</div><div class="markdown-content">${md(msg)}</div></div>`;
    }
    if (type === "cli_error") return `<div class="ta-error"><i class="fas fa-triangle-exclamation"></i> ${esc(msg)}</div>`;
    if (type === "question") {
      // The agent asked something back instead of guessing — tagged, not a plain reply.
      const opts = Array.isArray(row.options) ? row.options : [];
      const btns = opts.length
        ? `<div class="ta-qopts">${opts.map((o) => `<button class="ta-qopt" data-ta-answer="${esc(o)}">${esc(o)}</button>`).join("")}</div>`
        : "";
      return `<div class="ta-question"><div class="ta-question-label"><i class="fas fa-circle-question"></i> Needs your answer</div><div class="markdown-content">${md(msg)}</div>${btns}</div>`;
    }
    // A tool action: verb icon, what it did, a short result; expandable only with output.
    const out = String(row.output || "");
    const text = msg.replace(TAG_RE, "");
    const id = "tarow-" + String(row.id || (++rowSeq)).replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!row.action && !row.job && !isActionText(text)) {
      // Stray output with no action to belong to: a quiet line, full text on hover.
      return `<div class="ta-outline" title="${esc(text)}">${esc(text.split("\n")[0]) || "(no output)"}</div>`;
    }
    const icon = (VERB_ICONS.find(([re]) => re.test(text)) || [null, "fa-terminal"])[1];
    const summary = resultSummary(row);
    const failed = summary === "failed" || row.jobStatus === "Failed";
    const expandable = out.length > 0 && out.trim() !== text;
    const label = esc(text.split("\n")[0]) || "(no output)";
    return `<div class="ta-cmdrow ta-act${failed ? " is-failed" : ""}">
      <div class="ta-cmd-header"${expandable ? ` data-ta-toggle="${id}"` : ""}><i class="fas ${icon} ta-verb" aria-hidden="true"></i><span class="ta-cmd-text">${label}</span>${summary ? `<small class="ta-result">${esc(summary)}</small>` : ""}${expandable ? '<i class="fas fa-chevron-right ta-chev" aria-hidden="true"></i>' : ""}</div>
      ${expandable ? `<div id="${id}" class="ta-cmd-body" style="display:none;">${esc(out)}</div>` : ""}
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

  // The arrow is a Stop button while a turn runs: stop first, then send what's typed.
  // Waits for the executor to actually bail (the "stopped" broadcast) so the new
  // message can't land on top of a still-dying agent.
  async function stopThenSend() {
    const id = ticketId;
    await stopTicket();
    // Ask the SERVER when the turn is really over — the local flag is optimistic, and
    // sending into a still-unwinding turn just earns a 409.
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 400));
      if (ticketId !== id) return;
      try {
        const r = await fetch(`/api/projects/${PID()}/tickets/${id}/chat/status`, { credentials: "same-origin" });
        const j = r.ok ? await r.json() : null;
        if (j && !j.busy) break;
      } catch (_) { break; } // can't ask → try the send and let the 409 speak
    }
    chatBusy = false; setBuildUI();
    const input = $("ta-input");
    if (input && (input.value.trim() || pendingUploads.length)) await send();
  }

  async function send() {
    if (isBusy()) return stopThenSend();
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
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        const t = $("ta-thinking");
        // 409 = a turn is already running (someone else's tab, or a build). Keep the
        // Stop affordance up and put the message back so nothing is lost.
        if (r.status === 409) {
          if (t) t.remove();
          if (input) input.value = typed;
          chatBusy = true; setBuildUI();
          toast(j.error || "The agent is still working — stop it to send this.");
          return;
        }
        if (t) t.textContent = "Couldn't reach the agent — try again.";
        chatBusy = false; setBuildUI();
      }
    } catch (_) { const t = $("ta-thinking"); if (t) t.textContent = "Network error — try again."; chatBusy = false; setBuildUI(); }
    // Live WS updates replace the thinking row with the agent's streamed response.
  }

  // Live updates arrive over the chat page's existing WebSocket (chat.js routes the
  // per-user ticket_log/ticket_log_output/ticket_status events here). The interval is
  // just a slow safety net in case a socket message is missed.
  function onWs(msg) {
    if (!msg || !ticketId) return;
    if (msg.ticketId && msg.ticketId !== ticketId) return;
    if (msg.type === "tasks_updated") {
      tasksLoaded = false;
      if (activeTab === "tasks") { tasksLoaded = true; loadTasks(true); }
    } else if (msg.type === "ticket_log" && msg.log) {
      const area = $("ta-log");
      if (!area) return;
      const th = $("ta-thinking"); if (th) th.remove();
      const empty = area.querySelector("[data-empty]"); if (empty) area.innerHTML = "";
      const atBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 120;
      const existing = currentLogRows.findIndex(row => row.id && row.id === msg.log.id);
      if (existing >= 0) currentLogRows[existing] = msg.log; else currentLogRows.push(msg.log);
      renderAll(currentLogRows);
      if (atBottom) area.scrollTop = area.scrollHeight;
      // A reply can precede commit/cleanup. The authoritative activity event (or
      // the polling backstop) ends the spinner and Stop control.
    } else if (msg.type === "ticket_chat_state") {
      // Authoritative busy signal from the executor (a chat turn never moves
      // queueStatus, so this is the only way the button knows it's over).
      chatBusy = !!msg.busy;
      setBuildUI();
    } else if (msg.type === "ticket_status") {
      curMeta = Object.assign({}, curMeta, { status: msg.status, queueStatus: msg.queueStatus }); // reflect build state
      if (String(msg.status || "").toLowerCase() === "stopped") chatBusy = false;
      setBuildUI();
      loadLog();
    } else if (msg.type === "ticket_log_output") {
      loadLog(); // authoritative refresh (folds tool output into its row)
    }
  }
  async function refreshTicketState() {
    const id = ticketId;
    if (!id) return;
    try {
      const r = await fetch(`/api/projects/${PID()}/tickets/${id}`, { credentials: "same-origin" });
      const d = r.ok ? await r.json() : null;
      if (!d || !d.ticket || ticketId !== id) return;
      const settingsChanged = curMeta?.validationEnabled !== d.ticket.validationEnabled || curMeta?.featureTestingEnabled !== d.ticket.featureTestingEnabled;
      curMeta = Object.assign({}, curMeta, d.ticket);
      if (typeof d.ticket.agentBusy === "boolean") chatBusy = d.ticket.agentBusy;
      setBuildUI();
      if (settingsChanged) renderAll(currentLogRows);
    } catch (_) {}
  }
  window.addEventListener('focus', () => { if (ticketId) refreshTicketState(); });
  function startPoll() { stopPoll(); timer = setInterval(() => { loadLog(); refreshTicketState(); if (activeTab === "tasks") loadTasks(true); }, 12000); } // WS is primary; this is a backstop
  function stopPoll() { if (timer) { clearInterval(timer); timer = null; } }

  window.TicketAgentChat = { open, close, send, onWs, isOpen, attachScreenshot, stop: stopTicket };

  function wire() {
    $("ta-exit")?.addEventListener("click", close);
    $("ta-build")?.addEventListener("click", buildTicket);
    $("ta-stop")?.addEventListener("click", stopTicket);
    $("ta-edit")?.addEventListener("click", toggleEdit);
    $("ta-preview")?.addEventListener("click", previewTicket);
    $("ta-checks")?.addEventListener("click", toggleChecks);
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
      // Answer a tagged question by clicking one of its options.
      const opt = e.target.closest && e.target.closest("[data-ta-answer]");
      if (opt) {
        const input = $("ta-input");
        if (input) input.value = opt.getAttribute("data-ta-answer") || "";
        opt.parentElement?.querySelectorAll(".ta-qopt").forEach((b) => { b.disabled = true; });
        send();
        return;
      }
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
