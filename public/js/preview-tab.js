/**
 * Preview tab — runs the connected project live in its sandbox and shows it in
 * an iframe. Talks to /api/projects/:projectId/preview (GET state, POST setup /
 * stop). Live status arrives over the chat WebSocket as `preview_status`
 * (dispatched here via window.PreviewTab.onStatus); polling is a fallback.
 */
(function () {
  const IN_PROGRESS = ["detecting", "provisioning", "installing", "seeding", "starting"];
  const STEP_LABEL = {
    detecting: "Analyzing the codebase & fetching code…",
    provisioning: "Provisioning databases…",
    installing: "Installing dependencies…",
    seeding: "Running migrations & seed data…",
    starting: "Starting the app…",
  };

  let projectId = null;
  let pollTimer = null;
  let current = null; // last known state
  let loadedOnce = false;
  let logText = ""; // accumulated setup log
  let appLogText = ""; // the RUNNING app's own runtime log (preview.log), fetched on demand
  let dbLogs = []; // [{engine, log}] — each provisioned DB's docker log, shown under App logs
  let appLogView = "app"; // which App-logs sub-tab is shown: "app" | "<engine>"
  let appLogTimer = null; // auto-refresh poll while the App-logs tab is open
  let manifest = null; // the setup plan (derived from the profile)
  let profileData = null; // the App Profile — the detailed "how to run this app" plan
  let stepsData = null; // checkpoint runbook steps
  let currentView = null; // "progress" | "running" | "error" | "idle" — only re-render on change
  let progressTab = "logs"; // during setup: "logs" | "steps"
  let branches = [{ id: "default", label: "Default branch", ticketId: null }]; // previewable branches
  let branchId = "default"; // which branch is currently being previewed
  let preferTicket = null; // when opened from a ticket drawer: default the selector to this ticket's branch

  // ── In-app browser (tabbed) ──
  let bTabs = [];        // [{ id, url, history:[urls], hi }]
  let bActive = null;    // active tab id
  let bBase = null;      // preview URL the browser was mounted for
  let bSeq = 0;
  let proxyMode = false; // in-app links via the same-origin proxy (may break WS/SignalR)
  let _pvResizeObs = null; // re-scales the device viewport when the pane resizes
  let device = "desktop"; // desktop | tablet | mobile viewport
  // Desktop renders at a REAL desktop width (1280) and is scaled down to fit the
  // pane — otherwise the iframe fills the ~1100px pane and the SITE's own media
  // queries treat that as tablet, showing the tablet layout in "desktop" mode.
  const DEVICE_W = { mobile: 390, tablet: 834, desktop: 1280 };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function api(path, opts) {
    return fetch(`/api/projects/${projectId}/preview${path}`, {
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      ...opts,
    });
  }

  function setSub(text) {
    const el = $("preview-substatus");
    if (el) el.textContent = text || "";
  }

  function btn(label, opts = {}) {
    const base = "height:32px;padding:0 12px;border-radius:7px;cursor:pointer;font-size:12.5px;display:inline-flex;align-items:center;justify-content:center;gap:7px;font-weight:500;white-space:nowrap;transition:background .12s,border-color .12s;";
    const style = opts.primary
      ? "background:#7c3aed;color:#fff;border:1px solid #7c3aed;"
      : opts.danger
        ? "background:transparent;color:#f87171;border:1px solid var(--border-color,#333);"
        : "background:transparent;color:var(--text-color,#cbd5e1);border:1px solid var(--border-color,#333);";
    const pad = opts.iconOnly ? "padding:0 9px;" : "";
    return `<button data-action="${opts.action}" title="${esc(opts.title || label)}" style="${base}${style}${pad}">${opts.icon ? `<i class="fas ${opts.icon}"></i>` : ""}${opts.iconOnly ? "" : esc(label)}</button>`;
  }
  // A thin vertical divider between button groups in the toolbar.
  function tbDiv() { return `<span style="width:1px;height:20px;background:var(--border-color,#333);margin:0 3px;flex:none;"></span>`; }

  // --- Multi-app service switcher ---------------------------------------------
  // Which app's URL the iframe currently shows (null → primary). Persists across
  // renders within a session so a re-render (branch sync etc.) doesn't snap back.
  let activeService = null;
  // The named service the iframe should point at, given the latest state.
  function activeSvc(state) {
    const svcs = (state && state.services) || [];
    if (!svcs.length) return null;
    return svcs.find((s) => s.name === activeService && s.url) || svcs.find((s) => s.primary) || svcs[0];
  }
  // Inline chips for the toolbar: one per app. Clickable when it has a live URL
  // (switches the iframe); companions carry an ON/OFF toggle. "" for single-app.
  function serviceChips(state) {
    const svcs = (state && state.services) || [];
    if (svcs.length < 2) return "";
    const active = activeSvc(state);
    const chips = svcs.map((s) => {
      const isActive = active && s.name === active.name;
      const clickable = !!s.url;
      const chip = `padding:0 10px;height:32px;border-radius:7px;font-size:12px;cursor:${clickable ? "pointer" : "default"};border:1px solid ${isActive ? "#7c3aed" : "var(--border-color,#333)"};background:${isActive ? "rgba(124,58,237,.14)" : "transparent"};color:${clickable ? "var(--text-color,#cbd5e1)" : "var(--text-secondary,#9ca3af)"};display:inline-flex;align-items:center;gap:7px;font-weight:500;white-space:nowrap;`;
      const toggle = s.primary
        ? ""
        : `<span data-action="svctoggle:${esc(s.name)}:${s.enabled ? "0" : "1"}" title="${s.enabled ? "Turn this app off" : "Turn this app on"}" style="font-size:10px;font-weight:600;padding:1px 6px;border-radius:5px;letter-spacing:.5px;background:${s.enabled ? "rgba(16,185,129,.18)" : "rgba(148,163,184,.15)"};color:${s.enabled ? "#10b981" : "#94a3b8"};cursor:pointer;">${s.enabled ? "ON" : "OFF"}</span>`;
      return `<button ${clickable ? `data-action="svc:${esc(s.name)}"` : ""} title="${esc(s.name)}${s.port ? " · :" + s.port : ""}" style="${chip}"><span>${esc(s.name)}</span>${toggle}</button>`;
    }).join("");
    return chips + tbDiv();
  }

  function renderActions(html) {
    const el = $("preview-actions");
    if (el) el.innerHTML = html || "";
  }
  // The running-view toolbar. "Chat with ticket" (only on a ticket branch) sits right
  // NEXT TO the branch selector. Re-rendered after loadBranches so it appears on first load.
  function renderRunningActions() {
    const st = current || {};
    const branchSel = `<select data-branch title="Run a ticket's branch or the default" style="height:32px;padding:0 10px;border-radius:7px;font-size:12.5px;background:transparent;color:var(--text-color,#cbd5e1);border:1px solid var(--border-color,#333);max-width:180px;cursor:pointer;">${branchOptions()}</select>`;
    const te = branches.find((b) => b.id === branchId);
    const chatBtn = (te && te.ticketId) ? btn("Chat with ticket", { action: "tickchat", icon: "fa-comments", title: "Chat with this ticket's agent — this preview stays on the right" }) : "";
    renderActions(
      serviceChips(st) +
      (chatBtn ? chatBtn : "") +
      branchSel +
      tbDiv() +
      btn("Screenshot", { action: "screenshot", icon: "fa-camera", iconOnly: true, title: "Screenshot to chat" }) +
      btn("Logs", { action: "togglelog", icon: "fa-terminal", iconOnly: true, title: "Logs (setup + app)" }) +
      tbDiv() +
      btn("More", { action: "prevmenu", icon: "fa-ellipsis-vertical", iconOnly: true, title: "More — Env Profile, Restart, Stop" })
    );
  }

  // Scrollable live log panel with a Copy button (shared by in-progress + error).
  function logPanel(flex) {
    return `<div style="position:relative;${flex ? "flex:1;min-height:0;" : ""}display:flex;flex-direction:column;">
      <button data-action="copylog" title="Copy logs" style="position:absolute;top:8px;right:10px;z-index:2;padding:5px 10px;font-size:12px;border-radius:6px;cursor:pointer;background:var(--border-color,#2a2a2a);color:var(--text-color,#e2e8f0);border:1px solid var(--border-color,#333);display:inline-flex;align-items:center;gap:5px;"><i class="fas fa-copy"></i><span>Copy</span></button>
      <pre id="preview-log" style="${flex ? "flex:1;min-height:0;" : "max-height:260px;"}margin:0;overflow:auto;text-align:left;background:var(--background-surface,#141414);border:1px solid var(--border-color,#2a2a2a);border-radius:8px;padding:12px 14px;font-size:12px;line-height:1.55;color:var(--text-color,#cbd5e1);white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${esc(logText || "Starting…")}</pre>
    </div>`;
  }
  function scrollLog() {
    const el = $("preview-log");
    if (el) el.scrollTop = el.scrollHeight;
  }

  // ── Shared Logs | Steps toggle (used in the progress, running-overlay, and
  // error views). `progressTab` is the shared state; refreshPanes() swaps the
  // visible pane(s) in place so no view is rebuilt (keeps the iframe mounted). ──
  function segInner() {
    const seg = (id, label) => `<button data-ptab="${id}" style="padding:5px 14px;border-radius:7px;cursor:pointer;font-size:12.5px;border:1px solid var(--border-color,#333);background:${progressTab === id ? "#7c3aed" : "var(--border-color,#2a2a2a)"};color:${progressTab === id ? "#fff" : "var(--text-color,#e2e8f0)"};">${label}</button>`;
    return seg("logs", "Setup") + seg("applogs", "App logs") + seg("steps", "Steps");
  }
  function segButtons() { return `<div data-ptab-header style="display:flex;gap:4px;flex:none;">${segInner()}</div>`; }
  function activePane() {
    if (progressTab === "steps") return stepsPanel(true);
    if (progressTab === "applogs") return appLogPanel();
    return logPanel(true);
  }

  // App logs = the app's own runtime output + each provisioned DB's docker log, chosen
  // via a SWITCHER (App / Postgres / …) — one log at a time, not stacked. A "Reset DB"
  // button wipes + reseeds a broken/foreign database.
  function appLogPanel() {
    return `<div style="position:relative;flex:1;min-height:0;display:flex;flex-direction:column;gap:8px;">
      <div style="display:flex;align-items:center;gap:8px;">
        <div id="applog-tabs" style="display:flex;gap:5px;flex:1;flex-wrap:wrap;min-width:0;">${appLogTabs()}</div>
        <button data-action="resetdb" title="Wipe the database + reseed (fixes a broken/foreign DB)" style="flex:none;padding:6px 12px;font-size:12px;font-weight:600;border-radius:6px;cursor:pointer;background:#dc2626;color:#fff;border:1px solid #dc2626;box-shadow:0 1px 4px rgba(0,0,0,.3);display:inline-flex;align-items:center;gap:6px;"><i class="fas fa-rotate-left"></i><span>Reset DB</span></button>
        <button data-action="refreshapplog" title="Refresh" style="flex:none;padding:6px 10px;font-size:12px;border-radius:6px;cursor:pointer;background:var(--border-color,#2a2a2a);color:var(--text-color,#e2e8f0);border:1px solid var(--border-color,#333);display:inline-flex;align-items:center;gap:5px;"><i class="fas fa-rotate-right"></i><span>Refresh</span></button>
      </div>
      <pre id="app-log" style="flex:1;min-height:0;margin:0;overflow:auto;text-align:left;background:var(--background-surface,#141414);border:1px solid var(--border-color,#2a2a2a);border-radius:8px;padding:12px 14px;font-size:12px;line-height:1.55;color:var(--text-color,#cbd5e1);white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${esc(appLogBody())}</pre>
    </div>`;
  }
  function appLogTabs() {
    const tab = (id, label, color) => `<button data-action="alog:${id}" style="padding:4px 12px;border-radius:7px;cursor:pointer;font-size:12px;white-space:nowrap;border:1px solid ${appLogView === id ? color : "var(--border-color,#333)"};background:${appLogView === id ? color : "var(--border-color,#2a2a2a)"};color:${appLogView === id ? "#fff" : "var(--text-color,#e2e8f0)"};font-weight:${appLogView === id ? "600" : "400"};">${esc(label)}</button>`;
    const cap = (s) => (s || "db").charAt(0).toUpperCase() + (s || "db").slice(1);
    let html = tab("app", "App", "#7c3aed");
    for (const d of dbLogs) html += tab(d.engine, cap(d.engine), "#059669");
    return html;
  }
  function appLogBody() {
    if (appLogView === "app") return appLogText || "Loading the app's runtime log…";
    const d = dbLogs.find((x) => x.engine === appLogView);
    return d ? d.log : "(no log for this database)";
  }
  function paintAppLog(keepScroll) {
    const tabs = $("applog-tabs"); if (tabs) tabs.innerHTML = appLogTabs();
    const el = $("app-log");
    if (el) { const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80; el.textContent = appLogBody(); if (!keepScroll || atBottom) el.scrollTop = el.scrollHeight; }
  }
  async function loadAppLog() {
    try {
      const r = await api("/app-logs");
      if (!r.ok) {
        appLogText = r.status === 404
          ? "App-log endpoint not found (HTTP 404) — the server needs a redeploy to pick up this feature."
          : "App log unavailable (HTTP " + r.status + ").";
        dbLogs = [];
      } else {
        const j = await r.json();
        appLogText = (j && j.log) || "(no output yet — the app hasn't printed anything, or the preview isn't running)";
        dbLogs = (j && Array.isArray(j.dbs)) ? j.dbs : [];
      }
    } catch (e) { appLogText = "Could not reach the app-log endpoint (" + ((e && e.message) || "network error") + ")."; dbLogs = []; }
    if (appLogView !== "app" && !dbLogs.some((d) => d.engine === appLogView)) appLogView = "app"; // selected DB vanished
    paintAppLog(true);
  }
  async function doResetDb() {
    if (!confirm("Reset the database? This WIPES all preview data and re-initializes a fresh database, then restarts the preview (your migrations reseed the schema). This can't be undone.")) return;
    toast("Resetting the database…");
    try {
      const r = await api("/reset-db", { method: "POST", body: JSON.stringify({}) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
      toast("Database reset — restarting the preview…");
      load();
    } catch (e) { toast("Reset failed: " + e.message); }
  }
  function startAppPoll() { stopAppPoll(); appLogTimer = setInterval(loadAppLog, 4000); }
  function stopAppPoll() { if (appLogTimer) { clearInterval(appLogTimer); appLogTimer = null; } }
  function refreshPanes() {
    document.querySelectorAll("[data-ptab-header]").forEach((h) => { h.innerHTML = segInner(); });
    document.querySelectorAll("[data-pane]").forEach((p) => { p.innerHTML = activePane(); });
    if (progressTab === "logs") scrollLog();
  }
  async function copyLog() {
    try { await navigator.clipboard.writeText(logText || ""); toast("Logs copied"); }
    catch { const ta = document.createElement("textarea"); ta.value = logText || ""; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); toast("Logs copied"); }
  }
  function toast(msg) {
    const t = document.createElement("div");
    t.textContent = msg;
    t.style.cssText = "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:9999;background:#111;color:#fff;padding:9px 16px;border-radius:8px;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.3);";
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1800);
  }

  // ── In-app tabbed browser ──────────────────────────────────────────────────
  // NOTE: the preview is a CROSS-ORIGIN iframe (apps.mags.run), so the browser
  // can't read where the user navigates inside it or intercept the app's own
  // target="_blank" links — that's a hard browser-security boundary. What we CAN
  // do: multiple tabs, an editable address bar, reload, back/forward over the
  // URLs WE load, and a "＋" to open any URL (paste a link) in a new in-app tab.
  const tabById = (id) => bTabs.find((t) => t.id === id);
  function mountBrowser(body, previewUrl) {
    // Already mounted for this preview → keep the live iframes (don't reload).
    if (bBase === previewUrl && document.getElementById("pv-frames")) return;
    bBase = previewUrl;
    if (!bTabs.length) { const id = ++bSeq; bTabs = [{ id, url: previewUrl, history: [previewUrl], hi: 0 }]; bActive = id; }
    body.innerHTML = `
      <div style="height:100%;display:flex;flex-direction:column;background:var(--bg-color,#0f0f0f);">
        <div id="pv-tabstrip" style="display:flex;align-items:center;gap:3px;padding:6px 8px 0;overflow-x:auto;"></div>
        <div style="display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--border-color,#2a2a2a);">
          <button data-bx="back" title="Back" style="${navBtn()}"><i class="fas fa-arrow-left"></i></button>
          <button data-bx="fwd" title="Forward" style="${navBtn()}"><i class="fas fa-arrow-right"></i></button>
          <button data-bx="reload" title="Reload page" style="${navBtn()}"><i class="fas fa-rotate-right"></i></button>
          <input id="pv-addr" spellcheck="false" style="flex:1;min-width:0;padding:7px 12px;border-radius:8px;border:1px solid var(--border-color,#2a2a2a);background:var(--background-surface,#141414);color:var(--text-color,#e2e8f0);font-size:12.5px;font-family:ui-monospace,Menlo,monospace;" />
          <div style="display:flex;gap:2px;flex:none;">
            <button data-dev="desktop" title="Desktop view" style="${navBtn()}"><i class="fas fa-desktop"></i></button>
            <button data-dev="tablet" title="Tablet view (834px)" style="${navBtn()}"><i class="fas fa-tablet-screen-button"></i></button>
            <button data-dev="mobile" title="Mobile view (390px)" style="${navBtn()}"><i class="fas fa-mobile-screen-button"></i></button>
          </div>
          <button id="pv-proxy" data-bx="proxy" title="Keep links inside this browser (in-app links). May break real-time features like SignalR/WebSockets." style="${navBtn()}"><i class="fas fa-link"></i></button>
          <button data-bx="external" title="Open in a real browser tab" style="${navBtn()}"><i class="fas fa-external-link-alt"></i></button>
        </div>
        <div id="pv-frames" style="flex:1;position:relative;background:#fff;"></div>
      </div>`;
    renderTabs(); renderFrames(); syncAddr();
    const strip = document.getElementById("pv-tabstrip");
    const addr = document.getElementById("pv-addr");
    document.querySelectorAll("[data-bx]").forEach((el) => el.addEventListener("click", () => bxAction(el.getAttribute("data-bx"))));
    document.querySelectorAll("[data-dev]").forEach((el) => el.addEventListener("click", () => { device = el.getAttribute("data-dev"); applyDevice(); }));
    // Re-scale the iframe when the pane resizes (panel drag, window resize) so the
    // desktop viewport stays correctly fitted instead of clipping/misaligning.
    const frames = document.getElementById("pv-frames");
    if (frames && window.ResizeObserver) {
      if (_pvResizeObs) _pvResizeObs.disconnect();
      // Coalesce to ONE applyDevice per animation frame — otherwise dragging the panel
      // fires the observer on every pixel and applyDevice rewrites every iframe's cssText,
      // which makes the drag laggy.
      let raf = 0;
      _pvResizeObs = new ResizeObserver(() => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; applyDevice(); }); });
      _pvResizeObs.observe(frames);
    }
    strip?.addEventListener("click", onTabStripClick);
    addr?.addEventListener("keydown", (e) => { if (e.key === "Enter") navigate(bActive, addr.value.trim()); });
  }
  const navBtn = () => "padding:6px 9px;border-radius:7px;cursor:pointer;background:var(--border-color,#2a2a2a);color:var(--text-color,#e2e8f0);border:1px solid var(--border-color,#333);font-size:12px;flex:none;";
  // The actual iframe src: raw app URL, or routed through our same-origin proxy
  // so links (incl. target=_blank) stay in-app. Address bar always shows the real URL.
  function frameSrc(u) {
    if (!proxyMode) return u;
    try { const x = new URL(u); return `/preview-proxy/${projectId}` + x.pathname + x.search; } catch (_) { return u; }
  }
  function updateProxyBtn() {
    const b = document.getElementById("pv-proxy");
    if (b) { b.style.background = proxyMode ? "#7c3aed" : "var(--border-color,#2a2a2a)"; b.style.color = proxyMode ? "#fff" : "var(--text-color,#e2e8f0)"; }
  }
  // Size the active iframe to the chosen device viewport. The iframe always gets
  // the device's REAL CSS width (so the site's media queries pick the right
  // layout), then it's scaled down to fit the pane if the pane is narrower —
  // exactly how browser "responsive design mode" works. Desktop=1280 scaled to
  // fit gives a true computer layout even in a ~1100px pane.
  function applyDevice() {
    const frames = document.getElementById("pv-frames");
    if (frames) frames.style.background = device === "desktop" ? "#fff" : "var(--bg-color,#0f0f0f)";
    const w = DEVICE_W[device];
    const contW = frames ? frames.clientWidth : w;
    const contH = frames ? frames.clientHeight : 0;
    const scale = Math.min(1, contW / w); // never upscale
    const fh = scale < 1 && contH ? Math.ceil(contH / scale) : 0; // fill height after scaling
    for (const t of bTabs) {
      const f = document.getElementById(`pv-frame-${t.id}`);
      if (!f) continue;
      const show = t.id === bActive ? "block" : "none";
      f.style.cssText =
        `position:absolute;top:0;left:50%;` +
        `transform:translateX(-50%) scale(${scale});transform-origin:top center;` +
        `width:${w}px;height:${fh ? fh + "px" : "100%"};border:0;background:#fff;` +
        `box-shadow:0 0 0 1px var(--border-color,#2a2a2a);display:${show};`;
    }
    document.querySelectorAll("[data-dev]").forEach((el) => {
      const on = el.getAttribute("data-dev") === device;
      el.style.background = on ? "#7c3aed" : "var(--border-color,#2a2a2a)";
      el.style.color = on ? "#fff" : "var(--text-color,#e2e8f0)";
    });
  }
  function renderTabs() {
    const strip = document.getElementById("pv-tabstrip");
    if (!strip) return;
    strip.innerHTML = bTabs.map((t) => {
      const on = t.id === bActive;
      let host = t.url; try { host = new URL(t.url).host; } catch (_) {}
      return `<div data-tab="${t.id}" style="display:flex;align-items:center;gap:6px;max-width:200px;padding:6px 10px;border-radius:8px 8px 0 0;cursor:pointer;font-size:12px;white-space:nowrap;${on ? "background:#fff;color:#111;" : "background:var(--background-surface,#141414);color:var(--text-secondary,#9ca3af);"}">
        <span style="overflow:hidden;text-overflow:ellipsis;">${esc(host)}</span>
        ${bTabs.length > 1 ? `<span data-close="${t.id}" style="opacity:.7;">✕</span>` : ""}
      </div>`;
    }).join("") + `<button data-newtab="1" title="New tab" style="${navBtn()}margin-left:4px;"><i class="fas fa-plus"></i></button>`;
  }
  function renderFrames() {
    const frames = document.getElementById("pv-frames");
    if (!frames) return;
    // Keep an iframe per tab; show only the active one (so switching tabs doesn't reload).
    for (const t of bTabs) {
      let f = document.getElementById(`pv-frame-${t.id}`);
      if (!f) {
        f = document.createElement("iframe");
        f.id = `pv-frame-${t.id}`;
        f.src = frameSrc(t.url);
        f.setAttribute("allow", "clipboard-read; clipboard-write");
        frames.appendChild(f);
      }
    }
    // Remove frames for closed tabs.
    Array.from(frames.querySelectorAll("iframe")).forEach((f) => {
      const id = Number(f.id.replace("pv-frame-", ""));
      if (!tabById(id)) f.remove();
    });
    applyDevice();
  }
  function syncAddr() { const a = document.getElementById("pv-addr"); const t = tabById(bActive); if (a && t) a.value = t.url; }
  function normalizeUrl(u) {
    u = (u || "").trim(); if (!u) return "";
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith("/")) { try { return new URL(u, bBase).href; } catch (_) { return u; } }
    return "https://" + u;
  }
  function navigate(tabId, raw) {
    const t = tabById(tabId); if (!t) return;
    const url = normalizeUrl(raw); if (!url) return;
    t.url = url; t.history = t.history.slice(0, t.hi + 1); t.history.push(url); t.hi = t.history.length - 1;
    const f = document.getElementById(`pv-frame-${tabId}`); if (f) f.src = frameSrc(url);
    renderTabs(); syncAddr();
  }
  function bxAction(kind) {
    const t = tabById(bActive); if (!t) return;
    const f = document.getElementById(`pv-frame-${t.id}`);
    if (kind === "reload" && f) { f.src = f.src; }
    else if (kind === "back" && t.hi > 0) { t.hi--; t.url = t.history[t.hi]; if (f) f.src = frameSrc(t.url); syncAddr(); renderTabs(); }
    else if (kind === "fwd" && t.hi < t.history.length - 1) { t.hi++; t.url = t.history[t.hi]; if (f) f.src = frameSrc(t.url); syncAddr(); renderTabs(); }
    else if (kind === "external") { window.open(t.url, "_blank"); }
    else if (kind === "proxy") {
      proxyMode = !proxyMode;
      updateProxyBtn();
      toast(proxyMode ? "In-app links ON (real-time features may not work)" : "In-app links OFF");
      // Reload every tab through/without the proxy.
      for (const tt of bTabs) { const ff = document.getElementById(`pv-frame-${tt.id}`); if (ff) ff.src = frameSrc(tt.url); }
    }
  }
  function onTabStripClick(e) {
    const nt = e.target.closest("[data-newtab]");
    if (nt) { const id = ++bSeq; bTabs.push({ id, url: bBase, history: [bBase], hi: 0 }); bActive = id; renderTabs(); renderFrames(); syncAddr(); const a = document.getElementById("pv-addr"); if (a) { a.focus(); a.select(); } return; }
    const cl = e.target.closest("[data-close]");
    if (cl) { const id = Number(cl.getAttribute("data-close")); bTabs = bTabs.filter((t) => t.id !== id); if (bActive === id) bActive = bTabs[bTabs.length - 1]?.id ?? null; renderTabs(); renderFrames(); syncAddr(); return; }
    const tb = e.target.closest("[data-tab]");
    if (tb) { bActive = Number(tb.getAttribute("data-tab")); renderTabs(); renderFrames(); syncAddr(); }
  }

  // Checkpoint runbook — the ordered command list with per-step status.
  const STEP_ICON = { done: '<span style="color:#10b981;">✓</span>', running: '<span class="spinner" style="width:11px;height:11px;display:inline-block;vertical-align:middle;"></span>', failed: '<span style="color:#ef4444;">✗</span>', pending: '<span style="color:var(--text-secondary,#9ca3af);">○</span>' };
  function stepsPanel(flex) {
    if (!stepsData || !stepsData.length) return `<div style="color:var(--text-secondary,#9ca3af);font-size:13px;padding:8px;">No setup steps yet — the plan is being built.</div>`;
    const rows = stepsData.map((s) => {
      const row = `<div style="display:flex;gap:8px;padding:3px 0;font-size:12px;align-items:flex-start;line-height:18px;">
        <span style="width:14px;height:18px;flex:none;display:flex;align-items:center;justify-content:center;">${STEP_ICON[s.status] || STEP_ICON.pending}</span>
        <span style="min-width:64px;flex:none;color:var(--text-secondary,#9ca3af);text-transform:uppercase;font-size:10px;letter-spacing:.4px;line-height:18px;">${esc(s.phase)}</span>
        <span style="flex:1;color:${s.status === "failed" ? "#ef4444" : "var(--text-color,#e2e8f0)"};word-break:break-word;font-family:ui-monospace,Menlo,monospace;line-height:18px;">${esc(s.label)}</span>
      </div>`;
      // Show WHY a step failed (its captured error) so it's not just a mystery ✗.
      if (s.status === "failed" && s.error) {
        return row + `<div style="margin:0 0 6px 84px;padding:6px 10px;border-left:2px solid #ef4444;background:rgba(239,68,68,0.06);border-radius:0 6px 6px 0;color:#fca5a5;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Menlo,monospace;max-height:160px;overflow:auto;">${esc(String(s.error).slice(-900))}</div>`;
      }
      return row;
    }).join("");
    return `<div id="preview-steps-wrap" style="${flex ? "flex:1;min-height:0;" : "max-height:34%;"}overflow:auto;border:1px solid var(--border-color,#2a2a2a);border-radius:8px;padding:8px 12px;background:var(--background-surface,#141414);">
      <div style="font-size:11px;color:var(--text-secondary,#9ca3af);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">Setup steps (checkpointed — a restart resumes here)</div>${rows}</div>`;
  }

  // Repaint the Steps pane WITHOUT losing the user's scroll position — otherwise
  // every 4s poll / WS steps update rebuilds the list and yanks it back to the top
  // while you're trying to read a step.
  function paintSteps(pane) {
    if (!pane) return;
    const prev = pane.querySelector("#preview-steps-wrap");
    const top = prev ? prev.scrollTop : 0;
    pane.innerHTML = stepsPanel(true);
    const next = pane.querySelector("#preview-steps-wrap");
    if (next && top) next.scrollTop = top;
  }

  function render(state) {
    current = state;
    const body = $("preview-body");
    if (!body) return;
    const la = $("preview-left-actions"); if (la) la.innerHTML = ""; // only the running view fills it
    const status = state.previewStatus || "idle";

    if (IN_PROGRESS.includes(status)) {
      currentView = "progress";
      setSub(STEP_LABEL[status] || "Working…");
      // Show the branch selector DURING setup/sync too — switching branches while a
      // build runs shouldn't require waiting for it to finish. Selecting a branch
      // supersedes the current run (doRunBranch → restart on the chosen branch).
      syncBranchFromState(state);
      const pOpts = branchOptions();
      const pBranchSel = branches.length > 1 ? `<select data-branch title="Switch branch (supersedes the current build)" style="padding:6px 8px;border-radius:6px;font-size:12.5px;background:var(--border-color,#2a2a2a);color:var(--text-color,#e2e8f0);border:1px solid var(--border-color,#333);max-width:200px;">${pOpts}</select>` : "";
      renderActions(pBranchSel + btn("Cancel", { action: "stop", icon: "fa-stop" }));
      // Branch list may not be loaded yet during an early setup phase — fetch it and
      // drop the selector in without disturbing the progress log.
      loadBranches().then(() => {
        if (currentView !== "progress") return;
        syncBranchFromState(current);
        const opts2 = branchOptions();
        const sel = document.querySelector("#preview-actions [data-branch]");
        if (sel) { sel.innerHTML = opts2; }
        else if (branches.length > 1) renderActions(`<select data-branch title="Switch branch (supersedes the current build)" style="padding:6px 8px;border-radius:6px;font-size:12.5px;background:var(--border-color,#2a2a2a);color:var(--text-color,#e2e8f0);border:1px solid var(--border-color,#333);max-width:200px;">${opts2}</select>` + btn("Cancel", { action: "stop", icon: "fa-stop" }));
      });
      body.innerHTML = `
        <div style="height:100%;display:flex;flex-direction:column;gap:10px;padding:16px 20px;">
          <div style="display:flex;align-items:center;gap:12px;">
            <div id="preview-progress-head" style="display:flex;align-items:center;gap:10px;color:var(--text-color,#e2e8f0);font-size:14px;flex:1;min-width:0;">
              <div class="spinner" style="width:18px;height:18px;flex:none;"></div>
              <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(STEP_LABEL[status] || "Setting up your preview…")}</span>
            </div>
            ${segButtons()}
          </div>
          <div id="preview-pane" data-pane style="flex:1;min-height:0;display:flex;flex-direction:column;">${activePane()}</div>
        </div>`;
      if (progressTab === "logs") scrollLog();
      return;
    }

    if (status === "running" && state.previewUrl) {
      currentView = "running";
      setSub("Live" + (state.branch ? ` · ${state.branch}` : ""));
      syncBranchFromState(state); // reflect the actually-running branch
      renderRunningActions();
      // Multi-app: show the selected app's URL (falls back to the primary appUrl).
      mountBrowser(body, (activeSvc(state) && activeSvc(state).url) || state.previewUrl);
      // Refresh the branch list (ticket worktrees may have appeared), re-sync to the
      // running branch, then re-render the actions — so "Chat with ticket" appears on the
      // FIRST load (branches aren't known on the initial render, not only after a tab switch).
      loadBranches().then(() => { syncBranchFromState(current); renderRunningActions(); });
      return;
    }

    if (status === "error") {
      currentView = "error";
      setSub("Failed");
      syncBranchFromState(state);
      const eopts = branchOptions();
      const eBranchSel = branches.length > 1 ? `<select data-branch title="Run a branch" style="padding:6px 8px;border-radius:6px;font-size:12.5px;background:var(--border-color,#2a2a2a);color:var(--text-color,#e2e8f0);border:1px solid var(--border-color,#333);max-width:200px;">${eopts}</select>` : "";
      // "Run default branch" (fast restart of main — the known-good state) is the
      // clear way back after a ticket-branch attempt failed. Re-setup rebuilds from
      // scratch; the dropdown re-runs a specific ticket.
      const eActions = () => (branches.length > 1
        ? `<select data-branch title="Run a branch" style="padding:6px 8px;border-radius:6px;font-size:12.5px;background:var(--border-color,#2a2a2a);color:var(--text-color,#e2e8f0);border:1px solid var(--border-color,#333);max-width:200px;">${branchOptions()}</select>`
        : "")
        + btn("Run default branch", { action: "rundefault", primary: true, icon: "fa-house" })
        + btn("Re-setup", { action: "setup", icon: "fa-rotate" });
      renderActions(eActions());
      // Load branches so the selector can offer "Default branch" / other tickets.
      loadBranches().then(() => { if (currentView === "error") renderActions(eActions()); });
      body.innerHTML = `
        <div style="height:100%;display:flex;flex-direction:column;gap:12px;padding:16px 20px;">
          <div style="display:flex;align-items:center;gap:10px;color:var(--text-color,#e2e8f0);font-size:14px;">
            <i class="fas fa-triangle-exclamation" style="color:#ef4444;font-size:18px;"></i>
            <span>The preview couldn't start${state.error ? " — " + esc(state.error.split("\n")[0].slice(0, 120)) : ""}</span>
          </div>
          <div style="display:flex;align-items:center;gap:12px;">
            <div style="flex:1;font-size:12px;color:var(--text-secondary,#9ca3af);">The failing step and its output are below.</div>
            ${segButtons()}
          </div>
          <div data-pane style="flex:1;min-height:0;display:flex;flex-direction:column;">${activePane()}</div>
        </div>`;
      scrollLog();
      return;
    }

    // idle | stopped | anything else → the intro / start screen
    currentView = "idle";
    const stopped = status === "stopped";
    // Already set up (stopped, not first-run) → let the user CHOOSE which branch to
    // start right here, instead of forcing default-first-then-switch.
    const setupDone = !!(state && state.setupComplete);
    const canPick = setupDone && branches.length > 1;
    setSub(stopped ? "Stopped" : "Not running");
    renderActions("");
    const opts = branches.map((b) => {
      const runnable = b.id === "default" || !!b.ticketId;
      return `<option value="${esc(b.id)}"${b.id === branchId ? " selected" : ""}${runnable ? "" : " disabled"}>${esc(b.label)}</option>`;
    }).join("");
    const branchSel = canPick ? `<div style="display:flex;flex-direction:column;gap:6px;align-items:center;margin-top:4px;">
        <div style="font-size:12px;color:var(--text-secondary,#9ca3af);">Choose which branch to preview</div>
        <select data-branch style="height:36px;padding:0 12px;border-radius:8px;font-size:13px;background:var(--card-bg,#161616);color:var(--text-color,#e2e8f0);border:1px solid var(--border-color,#333);max-width:340px;cursor:pointer;">${opts}</select>
      </div>` : "";
    body.innerHTML = `
      <div style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:32px;text-align:center;color:var(--text-secondary,#9ca3af);">
        <div style="font-size:30px;color:#7c3aed;"><i class="fas fa-play-circle"></i></div>
        <div style="font-size:15px;color:var(--text-color,#e2e8f0);font-weight:600;">${stopped ? "Preview stopped" : "Run this project live"}</div>
        <div style="font-size:13px;max-width:420px;line-height:1.5;">
          Spins up a sandbox, detects the stack, provisions the databases it needs, seeds data,
          and starts the app — then shows it right here. First run takes a couple of minutes.
        </div>
        ${branchSel}
        ${btn(canPick ? "Start preview" : (stopped ? "Start preview" : "Set up preview"), { action: setupDone ? "startbranch" : "setup", primary: true, icon: "fa-play" })}
      </div>`;
    // Populate the branch list (ticket worktrees) so the selector has real options.
    if (setupDone && branches.length <= 1) loadBranches().then(() => { if (currentView === "idle" && current) render(current); });
  }

  async function load() {
    if (!projectId) return;
    try {
      const r = await api("");
      if (!r.ok) throw new Error("state " + r.status);
      const state = await r.json();
      // Never SHRINK the log — WS may have appended newer lines than the DB copy.
      if (typeof state.log === "string" && state.log.length > logText.length) logText = state.log;
      if (state.manifest) manifest = state.manifest;
      if (Array.isArray(state.steps)) stepsData = state.steps;
      const nextView = statusView(state.previewStatus);
      current = state;
      if (nextView === currentView && currentView === "progress") {
        // Same in-progress view → update the active pane in place (don't rebuild →
        // keeps scroll + the live WS-appended log lines).
        if (progressTab === "steps") {
          paintSteps(document.getElementById("preview-pane"));
        } else {
          const el = document.getElementById("preview-log");
          if (el) { const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40; el.textContent = logText; if (atBottom) el.scrollTop = el.scrollHeight; }
        }
      } else {
        render(state);
      }
      managePolling(state.previewStatus);
    } catch (e) {
      console.warn("[preview] load failed", e);
      if (!current) render({ previewStatus: "idle" });
    }
  }
  const statusView = (s) => IN_PROGRESS.includes(s) ? "progress" : s === "running" ? "running" : s === "error" ? "error" : "idle";

  function managePolling(status) {
    if (IN_PROGRESS.includes(status)) {
      if (!pollTimer) pollTimer = setInterval(load, 4000);
    } else if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function doSetup(rebuildManifest) {
    logText = ""; // fresh run → fresh log
    bTabs = []; bBase = null; bActive = null; // fresh browser on a new build
    render({ previewStatus: "detecting" });
    managePolling("detecting");
    try {
      await api("/setup", { method: "POST", body: JSON.stringify({ rebuildManifest: !!rebuildManifest, conversationId: window.currentConversationId || null }) });
    } catch (e) {
      render({ previewStatus: "error", error: "Could not start setup: " + e.message });
    }
  }

  // Toggle a log overlay on top of the running iframe.
  // ⋮ overflow menu (Env Profile / Restart / Stop) anchored under the "More" button.
  function togglePrevMenu(anchor) {
    const existing = document.getElementById("preview-more-menu");
    if (existing) { existing.remove(); return; }
    const m = document.createElement("div");
    m.id = "preview-more-menu";
    m.style.cssText = "position:fixed;z-index:100;min-width:180px;background:var(--card-bg,#161616);border:1px solid var(--border-color,#333);border-radius:10px;box-shadow:0 12px 34px rgba(0,0,0,.45);padding:5px;display:flex;flex-direction:column;gap:2px;";
    const item = (label, act, icon, danger) => `<button data-menu="${act}" style="text-align:left;padding:9px 11px;border-radius:7px;cursor:pointer;font-size:12.5px;background:transparent;color:${danger ? "#f87171" : "var(--text-color,#e2e8f0)"};border:none;display:flex;align-items:center;gap:10px;"><i class="fas ${icon}" style="width:14px;text-align:center;opacity:.85;"></i>${label}</button>`;
    m.innerHTML = item("Env Profile", "profile", "fa-list-check") + item("Restart", "restart", "fa-power-off") + item("Stop", "stop", "fa-stop", true);
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    m.style.top = (r.bottom + 6) + "px";
    m.style.left = Math.max(8, r.right - m.offsetWidth) + "px";
    m.addEventListener("mouseover", (e) => { const it = e.target.closest("[data-menu]"); if (it) it.style.background = "var(--border-color,#2a2a2a)"; });
    m.addEventListener("mouseout", (e) => { const it = e.target.closest("[data-menu]"); if (it) it.style.background = "transparent"; });
    m.addEventListener("click", (e) => {
      const it = e.target.closest("[data-menu]"); if (!it) return;
      const a = it.getAttribute("data-menu"); m.remove();
      if (a === "profile") togglePlan(); else if (a === "restart") doRestart(); else if (a === "stop") doStop();
    });
    setTimeout(() => document.addEventListener("click", function onDoc(ev) { if (!m.contains(ev.target) && ev.target !== anchor && !anchor.contains(ev.target)) { m.remove(); document.removeEventListener("click", onDoc); } }), 0);
  }

  function toggleLog() {
    const body = $("preview-body");
    if (!body) return;
    const existing = document.getElementById("preview-log-overlay");
    if (existing) { existing.remove(); stopAppPoll(); return; }
    // App is up → default to App logs (its runtime + DB logs), not the setup log.
    if (currentView === "running") progressTab = "applogs";
    const overlay = document.createElement("div");
    overlay.id = "preview-log-overlay";
    overlay.style.cssText = "position:absolute;inset:0;padding:16px 20px;background:var(--bg-color,#0f0f0f);display:flex;flex-direction:column;gap:10px;z-index:5;";
    overlay.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;">
        <div style="flex:1;font-size:12px;color:var(--text-secondary,#9ca3af);">Preview</div>
        ${segButtons()}
        <button data-action="togglelog" title="Close" style="flex:none;padding:5px 9px;border-radius:6px;cursor:pointer;font-size:12px;background:var(--border-color,#2a2a2a);color:var(--text-color,#e2e8f0);border:1px solid var(--border-color,#333);"><i class="fas fa-times"></i></button>
      </div>
      <div data-pane style="flex:1;min-height:0;display:flex;flex-direction:column;">${activePane()}</div>`;
    body.appendChild(overlay);
    if (progressTab === "applogs") { loadAppLog(); startAppPoll(); }
    else if (progressTab === "logs") scrollLog();
  }

  // ── Profile panel — the detailed, persisted "how to run this app" plan ──
  // (probe output: stack, ordered schema recipe, DBs, required secrets, config
  // quirks, and the self-healing learnings). Reviewable + editable + re-probeable.
  const sect = (title, inner) => inner ? `<div style="margin-top:14px;"><div style="font-size:11px;color:var(--text-secondary,#9ca3af);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">${esc(title)}</div>${inner}</div>` : "";
  const kv = (k, v) => (v && String(v).length) ? `<div style="display:flex;gap:10px;padding:4px 0;border-bottom:1px solid var(--border-color,#2a2a2a);"><div style="min-width:120px;color:var(--text-secondary,#9ca3af);">${esc(k)}</div><div style="flex:1;color:var(--text-color,#e2e8f0);word-break:break-word;font-family:ui-monospace,Menlo,monospace;font-size:12px;">${esc(Array.isArray(v) ? v.join("\n") : v)}</div></div>` : "";
  const bullets = (arr, color) => (arr && arr.length) ? `<div style="display:flex;flex-direction:column;gap:5px;">${arr.map((s) => `<div style="display:flex;gap:8px;font-size:12px;color:${color || "var(--text-color,#e2e8f0)"};"><span style="color:var(--text-secondary,#9ca3af);">•</span><span style="flex:1;word-break:break-word;">${esc(s)}</span></div>`).join("")}</div>` : "";

  function profileSections(p) {
    if (!p) return "";
    const KIND = { migration: "#60a5fa", sqlScript: "#a78bfa", seed: "#34d399" };
    const dbs = (p.databases || []).map((d) => `${d.engine} → ${d.connectionEnvVar} (${d.connectionFormat})`);
    const schema = (p.schemaSteps || []).map((s, i) => `<div style="display:flex;gap:8px;padding:5px 0;border-bottom:1px solid var(--border-color,#222);font-size:12px;align-items:baseline;">
      <span style="min-width:18px;color:var(--text-secondary,#9ca3af);">${i + 1}.</span>
      <span style="min-width:74px;flex:none;color:${KIND[s.kind] || "#9ca3af"};text-transform:uppercase;font-size:10px;letter-spacing:.4px;">${esc(s.kind)}</span>
      <span style="flex:1;"><span style="font-family:ui-monospace,Menlo,monospace;color:var(--text-color,#e2e8f0);word-break:break-word;">${esc(s.command)}</span>${s.note ? `<div style="color:var(--text-secondary,#9ca3af);margin-top:2px;">${esc(s.note)}</div>` : ""}</span>
    </div>`).join("");
    const secrets = (p.secretsRequired || []).map((s) => `<div style="padding:7px 10px;margin-bottom:6px;border-left:2px solid #f59e0b;background:rgba(245,158,11,0.06);border-radius:0 6px 6px 0;font-size:12px;">
      <div style="color:#fbbf24;font-family:ui-monospace,Menlo,monospace;font-weight:600;">${esc(s.key)}</div>
      <div style="color:var(--text-color,#e2e8f0);margin-top:2px;">${esc(s.description)}</div>
      <div style="color:var(--text-secondary,#9ca3af);margin-top:2px;">↳ where to get it: ${esc(s.whereToGet)}</div>
    </div>`).join("");
    return `<div style="font-size:12.5px;">
      ${kv("stack", p.stack || `${p.runtime}/${p.framework}`)}
      ${kv("runtime version", p.runtimeVersion)}
      ${kv("port", String(p.port))}
      ${kv("startup project", p.startupProject)}
      ${kv("toolchain", p.toolchain)}
      ${kv("install", p.installCmd)}
      ${kv("build", p.buildCmd)}
      ${kv("run", p.runCmd)}
    </div>
    ${sect("databases", dbs.length ? `<div style="font-size:12.5px;">${dbs.map((d) => kv("", d)).join("")}</div>` : "")}
    ${sect("schema recipe (in dependency order)", schema || `<div style="color:var(--text-secondary,#9ca3af);font-size:12px;">none</div>`)}
    ${sect("external credentials (optional — for full functionality)", secrets || `<div style="color:var(--text-secondary,#9ca3af);font-size:12px;">none needed</div>`)}
    ${sect("config quirks (respected by the run agents)", bullets(p.configQuirks, "#fca5a5") || `<div style="color:var(--text-secondary,#9ca3af);font-size:12px;">none</div>`)}
    ${sect("build quirks", bullets(p.buildQuirks))}
    ${sect("learnings from past runs (self-healing memory)", bullets(p.learnings, "#93c5fd") || `<div style="color:var(--text-secondary,#9ca3af);font-size:12px;">none yet — corrections found during runs accumulate here</div>`)}`;
  }

  // Editable "mandatory directives" block — user-authored + agent-appended must-do
  // rules the run/preview agents are required to verify every run.
  function directivesEditorHtml(p) {
    const val = (p.directives || []).join("\n");
    return `<div style="margin-bottom:16px;padding:10px 12px;border:1px solid #f59e0b55;background:rgba(245,158,11,0.06);border-radius:8px;">
      <div style="font-size:11px;color:#fbbf24;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">▣ Mandatory directives — always enforced (one per line)</div>
      <div style="font-size:11px;color:var(--text-secondary,#9ca3af);margin-bottom:6px;">Project-specific must-do rules. Every run/preview agent must verify these. The agent also appends here when it solves a blocker.</div>
      <textarea id="preview-directives" spellcheck="false" placeholder="e.g. All appsettings SQL connections must point at the local MSSQL, not a dev/prod host" style="width:100%;box-sizing:border-box;min-height:90px;background:var(--background-surface,#141414);color:var(--text-color,#e2e8f0);border:1px solid var(--border-color,#2a2a2a);border-radius:6px;padding:10px;font-size:12px;line-height:1.5;">${esc(val)}</textarea>
      <div style="margin-top:6px;">${btn("Save directives", { action: "savedirectives", primary: true, icon: "fa-floppy-disk" })}</div>
    </div>`;
  }

  // Inner body of the panel — split so a re-probe can refresh it in place.
  function profileBodyHtml() {
    if (profileData) {
      return `${directivesEditorHtml(profileData)}${profileSections(profileData)}
        <div style="margin-top:16px;">
          <button data-action="toggleprofilejson" style="background:none;border:none;color:#7c3aed;cursor:pointer;font-size:12px;padding:0;">▸ Edit as JSON (advanced)</button>
          <div id="preview-profile-json-wrap" style="display:none;margin-top:8px;">
            <div style="font-size:12px;color:var(--text-secondary,#9ca3af);margin-bottom:6px;">Edit the profile and Save — the next run derives its steps from this.</div>
            <textarea id="preview-plan-json" spellcheck="false" style="width:100%;box-sizing:border-box;min-height:220px;background:var(--background-surface,#141414);color:var(--text-color,#cbd5e1);border:1px solid var(--border-color,#2a2a2a);border-radius:8px;padding:12px;font-family:ui-monospace,Menlo,monospace;font-size:12px;">${esc(JSON.stringify(profileData, null, 2))}</textarea>
          </div>
        </div>
        <div id="preview-plan-msg" style="font-size:12px;color:var(--text-secondary,#9ca3af);min-height:16px;margin-top:8px;"></div>`;
    }
    return `<div style="color:var(--text-secondary,#9ca3af);font-size:13px;">No profile yet — run <b>Set up preview</b> to probe the codebase, or click <b>Re-probe</b> below (the repo must already be cloned).</div>
      <div id="preview-plan-msg" style="font-size:12px;color:var(--text-secondary,#9ca3af);min-height:16px;margin-top:8px;"></div>`;
  }

  function renderProfileBody() {
    const el = document.getElementById("preview-plan-body");
    if (el) el.innerHTML = profileBodyHtml();
    const foot = document.getElementById("preview-plan-foot");
    if (foot) foot.innerHTML = `${btn("Re-probe", { action: "reprobe", icon: "fa-rotate" })}${profileData ? btn("Save profile", { action: "saveprofile", primary: true, icon: "fa-floppy-disk" }) : ""}`;
  }

  async function togglePlan() {
    const body = $("preview-body");
    if (!body) return;
    const existing = document.getElementById("preview-plan-overlay");
    if (existing) { existing.remove(); return; }
    const overlay = document.createElement("div");
    overlay.id = "preview-plan-overlay";
    overlay.style.cssText = "position:absolute;inset:0;padding:16px 20px;background:var(--bg-color,#0f0f0f);display:flex;flex-direction:column;gap:6px;z-index:6;overflow:auto;";
    overlay.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;flex:none;">
        <div style="font-size:14px;color:var(--text-color,#e2e8f0);font-weight:600;">App profile — how this project is set up &amp; run</div>
        <button data-action="closeplan" style="background:none;border:none;color:var(--text-secondary,#9ca3af);cursor:pointer;font-size:16px;"><i class="fas fa-times"></i></button>
      </div>
      <div id="preview-plan-body" style="flex:1;min-height:0;">
        <div style="color:var(--text-secondary,#9ca3af);font-size:13px;padding:8px 0;">Loading profile…</div>
      </div>
      <div id="preview-plan-foot" style="display:flex;gap:8px;flex:none;padding-top:6px;"></div>`;
    body.appendChild(overlay);
    // Fetch the saved profile, then render.
    try {
      const r = await api("/profile");
      const j = await r.json();
      profileData = j.profile || null;
    } catch (_) { profileData = null; }
    renderProfileBody();
  }

  async function saveProfile() {
    const ta = $("preview-plan-json");
    const msg = $("preview-plan-msg");
    if (!ta) { if (msg) { msg.textContent = "Open “Edit as JSON” to edit the profile."; } return; }
    let parsed;
    try { parsed = JSON.parse(ta.value); } catch (e) { if (msg) { msg.textContent = "Invalid JSON: " + e.message; msg.style.color = "#ef4444"; } return; }
    try {
      const r = await api("/profile", { method: "PUT", body: JSON.stringify(parsed) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
      profileData = j.profile || parsed;
      renderProfileBody();
      const m2 = $("preview-plan-msg"); if (m2) { m2.textContent = "Saved ✓ — the next run derives its steps from this."; m2.style.color = "#10b981"; }
    } catch (e) { if (msg) { msg.textContent = "Save failed: " + e.message; msg.style.color = "#ef4444"; } }
  }

  // Save just the mandatory directives (merges into the profile, keeps everything else).
  async function saveDirectives() {
    const ta = $("preview-directives");
    const msg = $("preview-plan-msg");
    if (!ta || !profileData) return;
    const directives = ta.value.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 40);
    const next = Object.assign({}, profileData, { directives });
    try {
      const r = await api("/profile", { method: "PUT", body: JSON.stringify(next) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
      profileData = j.profile || next;
      if (msg) { msg.textContent = "Directives saved ✓ — every future run must satisfy them."; msg.style.color = "#10b981"; }
    } catch (e) { if (msg) { msg.textContent = "Save failed: " + e.message; msg.style.color = "#ef4444"; } }
  }

  async function reprobe() {
    const msg = $("preview-plan-msg");
    if (msg) { msg.textContent = "Re-probing the codebase — watch the logs…"; msg.style.color = "var(--text-secondary,#9ca3af)"; }
    try {
      const r = await api("/profile/reprobe", { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
      // Result arrives via the preview_profile WS event → onProfile refreshes the panel.
    } catch (e) { if (msg) { msg.textContent = "Re-probe failed: " + e.message; msg.style.color = "#ef4444"; } }
  }

  async function doStop() {
    setSub("Stopping…");
    try { await api("/stop", { method: "POST" }); } catch (_) {}
    load();
  }

  // Restart = restart the app SERVER (fast: reuses install/build). Different from
  // "reload" (which just refreshes the current page in the in-app browser).
  async function doRestart() {
    // The API restarts by TICKET id, so map the selection back through the list
    // (synthetic "branch:<name>" entries carry the ticket id when we could infer it).
    const entry = branches.find((b) => b.id === branchId);
    const ticketId = branchId && branchId !== "default" ? (entry ? entry.ticketId : branchId) : null;
    setSub(ticketId ? "Running branch…" : "Restarting the app…");
    logText = "";
    render({ previewStatus: "starting" });
    managePolling("starting");
    try { await api("/restart", { method: "POST", body: JSON.stringify({ ticketId, conversationId: window.currentConversationId || null }) }); }
    catch (e) { render({ previewStatus: "error", error: "Restart failed: " + e.message }); }
  }

  // Options for the branch <select>. An entry with no ticketId other than
  // "default" is one we discovered from the running state but can't re-launch
  // (the API restarts by ticket id) — show it, selected, but not pickable.
  function branchOptions() {
    return branches.map((b) => {
      const runnable = b.id === "default" || !!b.ticketId;
      return `<option value="${esc(b.id)}"${b.id === branchId ? " selected" : ""}${runnable ? "" : " disabled"}>${esc(b.label)}</option>`;
    }).join("");
  }

  // Fetch the previewable branches (default + ticket worktrees) for the selector.
  async function loadBranches() {
    try {
      const r = await api("/branches");
      const j = await r.json();
      if (Array.isArray(j.branches) && j.branches.length) branches = j.branches;
    } catch (_) { /* keep default */ }
  }

  // Sync the selector to the branch the server says is ACTUALLY running
  // (state.branch = the stored previewBranch), so a refresh reflects reality
  // instead of resetting to "Default branch".
  function syncBranchFromState(state) {
    const sb = (state && state.branch) || "";
    // No branch recorded yet (the run is still being set up) → keep whatever the
    // user picked. Resetting here is what made the selector say "Default branch"
    // while a ticket branch was building.
    if (!sb) {
      // Opened from a ticket drawer → default the selector to that ticket's branch
      // so the first Restart/Run targets it (a running branch below overrides this).
      if (preferTicket) { const pm = branches.find((b) => b.id === preferTicket || b.ticketId === preferTicket); if (pm) branchId = pm.id; }
      return;
    }
    if (sb === "(default)") { branchId = "default"; return; }
    const m = branches.find((b) => b.branch === sb);
    if (m) { branchId = m.id; return; }
    // Running a branch the list doesn't know about. Match the ticket id out of
    // the conventional name if that ticket IS listed, otherwise show the raw
    // branch — never fall through to "default", which would misreport what's
    // actually running.
    const tm = sb.match(/^feature\/ticket-(.+)$/);
    if (tm && branches.find((b) => b.id === tm[1])) { branchId = tm[1]; return; }
    const synthetic = "branch:" + sb;
    if (!branches.find((b) => b.id === synthetic)) branches.push({ id: synthetic, label: sb, ticketId: tm ? tm[1] : null, branch: sb });
    branchId = synthetic;
  }

  // Switch which branch the preview runs (default or a ticket's worktree).
  async function doRunBranch(id) {
    branchId = id || "default";
    // If a build/sync is in flight, cancel it first so we don't race two runs —
    // then start the chosen branch. (Selecting a branch supersedes the current one.)
    if (currentView === "progress") {
      try { await api("/stop", { method: "POST" }); } catch (_) {}
    }
    doRestart();
  }

  function onActionClick(e) {
    // Logs | Steps toggle (present in progress, running-overlay, and error views).
    const pt = e.target.closest("[data-ptab]");
    if (pt) {
      progressTab = pt.getAttribute("data-ptab");
      refreshPanes();
      if (progressTab === "applogs") { loadAppLog(); startAppPoll(); } else { stopAppPoll(); }
      return;
    }
    const b = e.target.closest("[data-action]");
    if (!b) return;
    const action = b.getAttribute("data-action");
    if (action === "setup") doSetup(false);
    else if (action === "startbranch") { const sel = document.querySelector("#preview-body [data-branch]"); doRunBranch(sel ? sel.value : "default"); }
    else if (action === "tickchat") {
      const e = branches.find((x) => x.id === branchId);
      if (e && e.ticketId && window.TicketAgentChat) { const p = (e.label || "").split(" — "); window.TicketAgentChat.open(e.ticketId, p[0] || "", p.slice(1).join(" — ") || e.label || ""); }
    }
    else if (action === "prevmenu") togglePrevMenu(b);
    else if (action === "profile") togglePlan();
    else if (action === "restart") doRestart();
    else if (action === "rundefault") { branchId = "default"; doRestart(); } // back to main (fast path)
    else if (action === "stop") doStop();
    else if (action === "togglelog") toggleLog();
    else if (action === "refreshapplog") loadAppLog();
    else if (action === "resetdb") doResetDb();
    else if (action.indexOf("alog:") === 0) { appLogView = action.slice(5); paintAppLog(false); }
    else if (action === "copylog") copyLog();
    else if (action === "screenshot") takeScreenshot(b);
    else if (action === "closeplan") togglePlan();
    else if (action === "saveprofile") saveProfile();
    else if (action === "savedirectives") saveDirectives();
    else if (action === "reprobe") reprobe();
    else if (action === "toggleprofilejson") {
      const w = document.getElementById("preview-profile-json-wrap");
      if (w) { const open = w.style.display !== "none"; w.style.display = open ? "none" : "block"; if (b) b.textContent = (open ? "▸" : "▾") + " Edit as JSON (advanced)"; }
    }
    else if (action === "open" && current && current.previewUrl) window.open(current.previewUrl, "_blank");
    else if (action.indexOf("svc:") === 0) switchService(action.slice(4));
    else if (action.indexOf("svctoggle:") === 0) {
      const parts = action.slice("svctoggle:".length).split(":");
      toggleService(parts[0], parts[1] === "1");
    }
  }

  // Point the iframe at another app's live URL. render() mounts activeSvc()'s URL
  // and repaints the chips; mountBrowser no-ops if the URL is unchanged.
  function switchService(name) {
    const svc = (current && current.services || []).find((s) => s.name === name);
    if (!svc || !svc.url) return;
    activeService = name;
    if (current) render(current);
  }

  // Turn a companion app ON/OFF. The backend persists the choice, kills the port
  // on OFF, and restarts the enabled set; state reloads via the restart flow.
  async function toggleService(name, enabled) {
    toast((enabled ? "Starting " : "Stopping ") + name + "…");
    try {
      const r = await api("/services", { method: "POST", body: JSON.stringify({ name, enabled }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
      if (!enabled && activeService === name) activeService = null; // don't strand the iframe on a dead app
      load(); // pull fresh state (restart is async; the WS/poll will keep it current)
    } catch (e) {
      toast("Couldn't toggle " + name + ": " + e.message);
    }
  }

  async function takeScreenshot(btn) {
    const label = btn ? btn.querySelector("span") : null;
    const orig = label ? label.textContent : "";
    if (label) label.textContent = "Capturing…";
    if (btn) btn.style.pointerEvents = "none";
    try {
      const r = await api("/screenshot", { method: "POST", body: JSON.stringify({ conversationId: window.currentConversationId || null }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
      toast("Screenshot saved to chat");
    } catch (e) {
      toast("Screenshot failed: " + e.message);
    } finally {
      if (label) label.textContent = orig;
      if (btn) btn.style.pointerEvents = "";
    }
  }

  // Live updates pushed from the server over the chat WS. There's one project
  // per page (and the WS keys on the internal id while we hold the public id),
  // so we accept every preview_status/preview_log for this page.
  const viewOf = (s) => IN_PROGRESS.includes(s) ? "progress" : s === "running" ? "running" : s === "error" ? "error" : "idle";

  // The chat WS delivers preview events for EVERY project the user has open, so
  // drop anything that isn't for THIS project (else two open projects cross-talk).
  const forOther = (data) => data && data.projectId && projectId && data.projectId !== projectId;

  window.PreviewTab = {
    onStatus(data) {
      if (forOther(data)) return;
      const nextStatus = data.status || (current && current.previewStatus) || "idle";
      const nextView = viewOf(nextStatus);
      // Terminal transitions (→ running/error/stopped) need authoritative state.
      if (data.status === "running" || data.status === "error" || data.status === "stopped") {
        load();
        if (data.message) setSub(data.message);
        return;
      }
      // Same view (still in-progress): DON'T rebuild the DOM — that resets the log
      // scroll / closes overlays. Just update the header line + substatus in place.
      if (nextView === currentView && currentView === "progress") {
        current = { ...(current || {}), previewStatus: nextStatus };
        if (data.message) {
          setSub(data.message);
          const head = document.querySelector("#preview-progress-head span");
          if (head) head.textContent = data.message;
        }
        managePolling(nextStatus);
        return;
      }
      // View changed → full render.
      render({ previewStatus: nextStatus, previewUrl: (current && current.previewUrl) || null, error: data.error || null, branch: (current && current.branch) || null });
      managePolling(nextStatus);
      if (data.message) setSub(data.message);
    },
    // A companion app came up / went down → pull authoritative state (which carries
    // the full services[] with each app's URL) and repaint the switcher chips.
    onServices(data) {
      if (forOther(data)) return;
      load();
    },
    onLog(data) {
      if (!data || !data.line || forOther(data)) return;
      logText = (logText + data.line + "\n").slice(-100000);
      const el = $("preview-log");
      if (el) {
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        el.textContent = logText;
        if (atBottom) el.scrollTop = el.scrollHeight; // only autoscroll if already at bottom
      }
    },
    // Open the live log overlay (used when @preview is tagged so its activity shows).
    showLogs() {
      try {
        if (currentView === "running" && !document.getElementById("preview-log-overlay")) toggleLog();
      } catch (_) {}
    },
    onSteps(data) {
      if (!data || !Array.isArray(data.steps) || forOther(data)) return;
      stepsData = data.steps;
      if (progressTab === "steps") paintSteps(document.getElementById("preview-pane")); // update in place, keep scroll
    },
    // A re-probe finished → refresh the open Profile panel with the new profile.
    onProfile(data) {
      if (forOther(data)) return;
      if (data && data.profile) profileData = data.profile;
      if (!document.getElementById("preview-plan-overlay")) return;
      if (data && data.error) {
        const msg = document.getElementById("preview-plan-msg");
        if (msg) { msg.textContent = "Re-probe: " + data.error; msg.style.color = "#ef4444"; }
        return;
      }
      renderProfileBody();
      const msg = document.getElementById("preview-plan-msg");
      if (msg) { msg.textContent = "Re-probe complete ✓ — profile updated."; msg.style.color = "#10b981"; }
    },
    // Open the preview scoped to a ticket (ticket drawer → switchDrawerTab). Behaviour:
    // if the preview is ALREADY running THIS ticket's branch → just render it; otherwise
    // start that branch through the normal steps (worktree → DB → migrate → run).
    open(ticketId) {
      loadedOnce = true;
      preferTicket = ticketId || null;
      loadBranches().then(async () => {
        await load(); // current running state
        if (!ticketId) return;
        const entry = branches.find((b) => b.id === ticketId || b.ticketId === ticketId);
        const st = current || {};
        const runningThis = st.previewStatus === "running" && !!st.branch && !!entry && st.branch === entry.branch;
        if (runningThis) return; // already live on this ticket's branch → render as-is
        // Not this branch (different branch running, stopped, or idle) → start it. Only if
        // setup exists (a first-ever run needs full setup, which the idle screen offers).
        if (st.setupComplete) { branchId = entry ? entry.id : ticketId; doRunBranch(branchId); }
      });
    },
  };

  function init() {
    const root = $("preview-root");
    if (!root) return;
    projectId = root.getAttribute("data-project-id");
    $("preview-actions")?.addEventListener("click", onActionClick);
    $("preview-left-actions")?.addEventListener("click", onActionClick);
    $("preview-body")?.addEventListener("click", onActionClick);
    // Branch selector (running view) — switch which branch/ticket the preview runs.
    $("preview-actions")?.addEventListener("change", (e) => {
      const sel = e.target.closest("[data-branch]");
      if (sel) doRunBranch(sel.value);
    });
    $("preview-plan-btn")?.addEventListener("click", () => { if (!current) load(); togglePlan(); });

    // Load when the Preview tab is opened (and once up front if already active).
    const tabBtn = document.querySelector('.tab-button[data-tab="preview"]');
    tabBtn?.addEventListener("click", () => { if (!loadedOnce) { loadedOnce = true; } load(); });
    if (document.getElementById("preview")?.classList.contains("active")) load();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
