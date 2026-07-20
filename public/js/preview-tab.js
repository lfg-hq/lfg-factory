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

  // Scrollable live log panel (shared by the in-progress and error views).
  function logPanel(flex) {
    return `<pre id="preview-log" style="${flex ? "flex:1;min-height:0;" : "max-height:260px;"}margin:0;overflow:auto;text-align:left;background:var(--background-surface,#141414);border:1px solid var(--border-color,#2a2a2a);border-radius:8px;padding:12px 14px;font-size:12px;line-height:1.55;color:var(--text-color,#cbd5e1);white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${esc(logText || "Starting…")}</pre>`;
  }
  function scrollLog() {
    const el = $("preview-log");
    if (el) el.scrollTop = el.scrollHeight;
  }

  function render(state) {
    current = state;
    const body = $("preview-body");
    if (!body) return;
    const status = state.previewStatus || "idle";

    if (IN_PROGRESS.includes(status)) {
      setSub(STEP_LABEL[status] || "Working…");
      renderActions(btn("Cancel", { action: "stop", icon: "fa-stop" }));
      body.innerHTML = `
        <div style="height:100%;display:flex;flex-direction:column;gap:12px;padding:16px 20px;">
          <div style="display:flex;align-items:center;gap:12px;color:var(--text-color,#e2e8f0);font-size:14px;">
            <div class="spinner" style="width:18px;height:18px;flex:none;"></div>
            <span>${esc(STEP_LABEL[status] || "Setting up your preview…")}</span>
          </div>
          ${logPanel(true)}
        </div>`;
      scrollLog();
      return;
    }

    if (status === "running" && state.previewUrl) {
      setSub("Live" + (state.branch ? ` · ${state.branch}` : ""));
      renderActions(
        btn("Open", { action: "open", icon: "fa-external-link-alt" }) +
        btn("Logs", { action: "togglelog", icon: "fa-terminal" }) +
        btn("Restart", { action: "setup", icon: "fa-redo" }) +
        btn("Stop", { action: "stop", icon: "fa-stop" })
      );
      body.innerHTML = `<iframe id="preview-iframe" src="${esc(state.previewUrl)}" style="width:100%;height:100%;border:0;background:#fff;" allow="clipboard-read; clipboard-write"></iframe>`;
      return;
    }

    if (status === "error") {
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

  function onActionClick(e) {
    const b = e.target.closest("[data-action]");
    if (!b) return;
    const action = b.getAttribute("data-action");
    if (action === "setup") doSetup(false);
    else if (action === "stop") doStop();
    else if (action === "togglelog") toggleLog();
    else if (action === "closeplan") togglePlan();
    else if (action === "saveplan") savePlan();
    else if (action === "reanalyze") reanalyze();
    else if (action === "open" && current && current.previewUrl) window.open(current.previewUrl, "_blank");
  }

  // Live updates pushed from the server over the chat WS. There's one project
  // per page (and the WS keys on the internal id while we hold the public id),
  // so we accept every preview_status/preview_log for this page.
  window.PreviewTab = {
    onStatus(data) {
      const next = {
        previewStatus: data.status || (current && current.previewStatus) || "idle",
        previewUrl: data.previewUrl || (current && current.previewUrl) || null,
        error: data.error || null,
        branch: (current && current.branch) || null,
      };
      // On terminal transitions, pull authoritative state (URL/manifest/branch).
      if (data.status === "running" || data.status === "error" || data.status === "stopped") {
        load();
      } else {
        render(next);
        managePolling(next.previewStatus);
      }
      if (data.message) setSub(data.message);
    },
    onLog(data) {
      if (!data || !data.line) return;
      logText = (logText + data.line + "\n").slice(-16000);
      // Append incrementally if the log panel is visible (preserve scroll pos).
      const el = $("preview-log");
      if (el) {
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        el.textContent = logText;
        if (atBottom) el.scrollTop = el.scrollHeight;
      }
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
