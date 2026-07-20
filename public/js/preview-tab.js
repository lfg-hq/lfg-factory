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
  let manifest = null; // the setup plan
  let stepsData = null; // checkpoint runbook steps
  let currentView = null; // "progress" | "running" | "error" | "idle" — only re-render on change

  // ── In-app browser (tabbed) ──
  let bTabs = [];        // [{ id, url, history:[urls], hi }]
  let bActive = null;    // active tab id
  let bBase = null;      // preview URL the browser was mounted for
  let bSeq = 0;
  let proxyMode = false; // in-app links via the same-origin proxy (may break WS/SignalR)
  let device = "desktop"; // desktop | tablet | mobile viewport
  const DEVICE_W = { mobile: 390, tablet: 834, desktop: 0 };

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
    const style = opts.primary
      ? "background:#7c3aed;color:#fff;border:none;"
      : "background:var(--border-color,#2a2a2a);color:var(--text-color,#e2e8f0);border:1px solid var(--border-color,#333);";
    return `<button data-action="${opts.action}" style="padding:7px 14px;border-radius:6px;cursor:pointer;font-size:13px;display:inline-flex;align-items:center;gap:6px;${style}">${opts.icon ? `<i class="fas ${opts.icon}"></i>` : ""}${esc(label)}</button>`;
  }

  function renderActions(html) {
    const el = $("preview-actions");
    if (el) el.innerHTML = html || "";
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
  // Size the active iframe to the chosen device viewport (centered). Desktop = fill.
  function applyDevice() {
    const frames = document.getElementById("pv-frames");
    if (frames) frames.style.background = device === "desktop" ? "#fff" : "var(--bg-color,#0f0f0f)";
    const w = DEVICE_W[device];
    for (const t of bTabs) {
      const f = document.getElementById(`pv-frame-${t.id}`);
      if (!f) continue;
      const show = t.id === bActive ? "block" : "none";
      f.style.cssText = w
        ? `position:absolute;top:0;bottom:0;left:50%;transform:translateX(-50%);width:${w}px;height:100%;max-width:100%;border:0;background:#fff;box-shadow:0 0 0 1px var(--border-color,#2a2a2a);display:${show};`
        : `position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff;display:${show};`;
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
  function stepsPanel() {
    if (!stepsData || !stepsData.length) return "";
    const rows = stepsData.map((s) => `<div style="display:flex;gap:8px;padding:3px 0;font-size:12px;align-items:baseline;">
      <span style="width:14px;flex:none;text-align:center;">${STEP_ICON[s.status] || STEP_ICON.pending}</span>
      <span style="min-width:64px;flex:none;color:var(--text-secondary,#9ca3af);text-transform:uppercase;font-size:10px;letter-spacing:.4px;padding-top:1px;">${esc(s.phase)}</span>
      <span style="flex:1;color:${s.status === "failed" ? "#ef4444" : "var(--text-color,#e2e8f0)"};word-break:break-word;font-family:ui-monospace,Menlo,monospace;">${esc(s.label)}</span>
    </div>`).join("");
    return `<div style="max-height:34%;overflow:auto;border:1px solid var(--border-color,#2a2a2a);border-radius:8px;padding:8px 12px;background:var(--background-surface,#141414);">
      <div style="font-size:11px;color:var(--text-secondary,#9ca3af);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">Setup steps (checkpointed — a restart resumes here)</div>${rows}</div>`;
  }

  function render(state) {
    current = state;
    const body = $("preview-body");
    if (!body) return;
    const status = state.previewStatus || "idle";

    if (IN_PROGRESS.includes(status)) {
      currentView = "progress";
      setSub(STEP_LABEL[status] || "Working…");
      renderActions(btn("Cancel", { action: "stop", icon: "fa-stop" }));
      body.innerHTML = `
        <div style="height:100%;display:flex;flex-direction:column;gap:10px;padding:16px 20px;">
          <div id="preview-progress-head" style="display:flex;align-items:center;gap:12px;color:var(--text-color,#e2e8f0);font-size:14px;">
            <div class="spinner" style="width:18px;height:18px;flex:none;"></div>
            <span>${esc(STEP_LABEL[status] || "Setting up your preview…")}</span>
          </div>
          <div id="preview-steps-wrap">${stepsPanel()}</div>
          ${logPanel(true)}
        </div>`;
      scrollLog();
      return;
    }

    if (status === "running" && state.previewUrl) {
      currentView = "running";
      setSub("Live" + (state.branch ? ` · ${state.branch}` : ""));
      renderActions(
        btn("Screenshot", { action: "screenshot", icon: "fa-camera" }) +
        btn("Logs", { action: "togglelog", icon: "fa-terminal" }) +
        btn("Restart", { action: "restart", icon: "fa-power-off" }) +
        btn("Stop", { action: "stop", icon: "fa-stop" })
      );
      mountBrowser(body, state.previewUrl);
      return;
    }

    if (status === "error") {
      currentView = "error";
      setSub("Failed");
      renderActions(btn("Try again", { action: "setup", primary: true, icon: "fa-redo" }));
      body.innerHTML = `
        <div style="height:100%;display:flex;flex-direction:column;gap:12px;padding:16px 20px;">
          <div style="display:flex;align-items:center;gap:10px;color:var(--text-color,#e2e8f0);font-size:14px;">
            <i class="fas fa-triangle-exclamation" style="color:#ef4444;font-size:18px;"></i>
            <span>The preview couldn't start${state.error ? " — " + esc(state.error.split("\n")[0].slice(0, 120)) : ""}</span>
          </div>
          <div style="font-size:12px;color:var(--text-secondary,#9ca3af);">Full log — the failing step and its output are below.</div>
          ${logPanel(true)}
        </div>`;
      scrollLog();
      return;
    }

    // idle | stopped | anything else → the intro / start screen
    currentView = "idle";
    const stopped = status === "stopped";
    setSub(stopped ? "Stopped" : "Not running");
    renderActions("");
    body.innerHTML = `
      <div style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:32px;text-align:center;color:var(--text-secondary,#9ca3af);">
        <div style="font-size:30px;color:#7c3aed;"><i class="fas fa-play-circle"></i></div>
        <div style="font-size:15px;color:var(--text-color,#e2e8f0);font-weight:600;">${stopped ? "Preview stopped" : "Run this project live"}</div>
        <div style="font-size:13px;max-width:420px;line-height:1.5;">
          Spins up a sandbox, detects the stack, provisions the databases it needs, seeds data,
          and starts the app — then shows it right here. First run takes a couple of minutes.
        </div>
        ${btn(stopped ? "Start preview" : "Set up preview", { action: "setup", primary: true, icon: "fa-play" })}
      </div>`;
  }

  async function load() {
    if (!projectId) return;
    try {
      const r = await api("");
      if (!r.ok) throw new Error("state " + r.status);
      const state = await r.json();
      if (typeof state.log === "string" && state.log) logText = state.log;
      if (state.manifest) manifest = state.manifest;
      if (Array.isArray(state.steps)) stepsData = state.steps;
      render(state);
      managePolling(state.previewStatus);
    } catch (e) {
      console.warn("[preview] load failed", e);
      if (!current) render({ previewStatus: "idle" });
    }
  }

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
      await api("/setup", { method: "POST", body: JSON.stringify({ rebuildManifest: !!rebuildManifest }) });
    } catch (e) {
      render({ previewStatus: "error", error: "Could not start setup: " + e.message });
    }
  }

  // Toggle a log overlay on top of the running iframe.
  function toggleLog() {
    const body = $("preview-body");
    if (!body) return;
    const existing = document.getElementById("preview-log-overlay");
    if (existing) { existing.remove(); return; }
    const overlay = document.createElement("div");
    overlay.id = "preview-log-overlay";
    overlay.style.cssText = "position:absolute;inset:0;padding:16px 20px;background:var(--bg-color,#0f0f0f);display:flex;flex-direction:column;gap:8px;z-index:5;";
    overlay.innerHTML = `<div style="font-size:12px;color:var(--text-secondary,#9ca3af);">Setup log</div>${logPanel(true)}`;
    body.appendChild(overlay);
    scrollLog();
  }

  // ── Setup plan viewer/editor (the exact instructions used to run the app) ──
  function planSummary(m) {
    if (!m) return "";
    const row = (k, v) => (v && v.length) ? `<div style="display:flex;gap:10px;padding:4px 0;border-bottom:1px solid var(--border-color,#2a2a2a);"><div style="min-width:120px;color:var(--text-secondary,#9ca3af);">${k}</div><div style="flex:1;color:var(--text-color,#e2e8f0);word-break:break-word;">${esc(Array.isArray(v) ? v.join("\n") : v)}</div></div>` : "";
    const dbs = (m.databases || []).map((d) => `${d.engine} → ${d.connectionEnvVar} (${d.connectionFormat})`);
    return [
      row("stack", m.stack || `${m.runtime}/${m.framework}`),
      row("port", String(m.port)),
      row("startup project", m.startupProject),
      row("toolchain", m.toolchain),
      row("install", m.installCmd),
      row("build", m.buildCmd),
      row("databases", dbs),
      row("migrations", m.migrations),
      row("sql scripts", m.sqlScripts),
      row("seed", m.seedCmd),
      row("run", m.runCmd),
    ].filter(Boolean).join("");
  }

  function togglePlan() {
    const body = $("preview-body");
    if (!body) return;
    const existing = document.getElementById("preview-plan-overlay");
    if (existing) { existing.remove(); return; }
    const overlay = document.createElement("div");
    overlay.id = "preview-plan-overlay";
    overlay.style.cssText = "position:absolute;inset:0;padding:16px 20px;background:var(--bg-color,#0f0f0f);display:flex;flex-direction:column;gap:10px;z-index:6;overflow:auto;";
    overlay.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <div style="font-size:14px;color:var(--text-color,#e2e8f0);font-weight:600;">Setup plan — the exact instructions used to run this project</div>
        <button data-action="closeplan" style="background:none;border:none;color:var(--text-secondary,#9ca3af);cursor:pointer;font-size:16px;"><i class="fas fa-times"></i></button>
      </div>
      ${manifest ? `<div style="font-size:12.5px;">${planSummary(manifest)}</div>
      <div style="font-size:12px;color:var(--text-secondary,#9ca3af);margin-top:6px;">Edit the plan JSON and Save to re-run with your changes, or Re-analyze to rebuild it from the code:</div>
      <textarea id="preview-plan-json" spellcheck="false" style="flex:1;min-height:180px;background:var(--background-surface,#141414);color:var(--text-color,#cbd5e1);border:1px solid var(--border-color,#2a2a2a);border-radius:8px;padding:12px;font-family:ui-monospace,Menlo,monospace;font-size:12px;">${esc(JSON.stringify(manifest, null, 2))}</textarea>
      <div id="preview-plan-msg" style="font-size:12px;color:var(--text-secondary,#9ca3af);min-height:16px;"></div>`
      : `<div style="color:var(--text-secondary,#9ca3af);font-size:13px;">No plan yet — run "Set up preview", or Re-analyze to build one from the code.</div>`}
      <div style="display:flex;gap:8px;">
        ${btn("Re-analyze", { action: "reanalyze", icon: "fa-rotate" })}
        ${manifest ? btn("Save plan", { action: "saveplan", primary: true, icon: "fa-floppy-disk" }) : ""}
      </div>`;
    body.appendChild(overlay);
  }

  async function savePlan() {
    const ta = $("preview-plan-json");
    const msg = $("preview-plan-msg");
    if (!ta) return;
    let parsed;
    try { parsed = JSON.parse(ta.value); } catch (e) { if (msg) { msg.textContent = "Invalid JSON: " + e.message; msg.style.color = "#ef4444"; } return; }
    try {
      const r = await api("/manifest", { method: "PUT", body: JSON.stringify(parsed) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
      manifest = j.manifest || parsed;
      if (msg) { msg.textContent = "Saved ✓ — click Set up preview to run with this plan."; msg.style.color = "#10b981"; }
    } catch (e) { if (msg) { msg.textContent = "Save failed: " + e.message; msg.style.color = "#ef4444"; } }
  }

  async function reanalyze() {
    const msg = $("preview-plan-msg");
    if (msg) { msg.textContent = "Re-analyzing the codebase…"; msg.style.color = "var(--text-secondary,#9ca3af)"; }
    try {
      const r = await api("/detect", { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
      manifest = j.manifest;
      togglePlan(); togglePlan(); // rebuild the overlay with the new plan
    } catch (e) { if (msg) { msg.textContent = "Re-analyze failed: " + e.message + " (the sandbox must exist — run Set up preview first)"; msg.style.color = "#ef4444"; } }
  }

  async function doStop() {
    setSub("Stopping…");
    try { await api("/stop", { method: "POST" }); } catch (_) {}
    load();
  }

  // Restart = restart the app SERVER (fast: reuses install/build). Different from
  // "reload" (which just refreshes the current page in the in-app browser).
  async function doRestart() {
    setSub("Restarting the app…");
    logText = "";
    render({ previewStatus: "starting" });
    managePolling("starting");
    try { await api("/restart", { method: "POST" }); }
    catch (e) { render({ previewStatus: "error", error: "Restart failed: " + e.message }); }
  }

  function onActionClick(e) {
    const b = e.target.closest("[data-action]");
    if (!b) return;
    const action = b.getAttribute("data-action");
    if (action === "setup") doSetup(false);
    else if (action === "restart") doRestart();
    else if (action === "stop") doStop();
    else if (action === "togglelog") toggleLog();
    else if (action === "copylog") copyLog();
    else if (action === "screenshot") takeScreenshot(b);
    else if (action === "closeplan") togglePlan();
    else if (action === "saveplan") savePlan();
    else if (action === "reanalyze") reanalyze();
    else if (action === "open" && current && current.previewUrl) window.open(current.previewUrl, "_blank");
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

  window.PreviewTab = {
    onStatus(data) {
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
    onLog(data) {
      if (!data || !data.line) return;
      logText = (logText + data.line + "\n").slice(-100000);
      const el = $("preview-log");
      if (el) {
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        el.textContent = logText;
        if (atBottom) el.scrollTop = el.scrollHeight; // only autoscroll if already at bottom
      }
    },
    onSteps(data) {
      if (!data || !Array.isArray(data.steps)) return;
      stepsData = data.steps;
      const wrap = $("preview-steps-wrap");
      if (wrap) wrap.innerHTML = stepsPanel(); // update in place; no full rebuild
    },
  };

  function init() {
    const root = $("preview-root");
    if (!root) return;
    projectId = root.getAttribute("data-project-id");
    $("preview-actions")?.addEventListener("click", onActionClick);
    $("preview-body")?.addEventListener("click", onActionClick);
    $("preview-plan-btn")?.addEventListener("click", () => { if (!current) load(); togglePlan(); });

    // Load when the Preview tab is opened (and once up front if already active).
    const tabBtn = document.querySelector('.tab-button[data-tab="preview"]');
    tabBtn?.addEventListener("click", () => { if (!loadedOnce) { loadedOnce = true; } load(); });
    if (document.getElementById("preview")?.classList.contains("active")) load();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
