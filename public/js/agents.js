/**
 * Agents — Client-side logic (settings panel only)
 *
 * Chat/WebSocket/streaming is handled by chat.js (reused as-is).
 * This file handles: CRUD, lifecycle, settings, data room, schedules, memory, tabs.
 */

(function () {
  "use strict";

  const agentId = document.body.dataset.agentId;

  // ── Agent status updates via WebSocket ────────────────────────────
  // chat.js connects the WebSocket; we listen for agent_status messages
  // via a global handler that chat.js calls if defined.

  const STATUS_COLORS = {
    idle: "#6b7280", starting: "#f59e0b", running: "#22c55e",
    paused: "#3b82f6", error: "#ef4444", stopped: "#6b7280",
  };
  const STATUS_LABELS = {
    idle: "Ready", starting: "Starting", running: "Working",
    paused: "Paused", error: "Error", stopped: "Ready",
  };

  window.__handleAgentWsMessage__ = function (data) {
    if (data.type === "agent_status") {
      updateAgentStatus(data.agent_id, data.status, data.message);
    } else if (data.type === "connector_required") {
      if (!agentId || data.agent_id === agentId) {
        renderConnectorRequired(data.toolkit, data.redirect_url);
      }
    } else if (data.type === "connector_connected") {
      // Either the user connected via the inline button (matching agent_id)
      // or via the connectors modal (no agent_id). In both cases, if we're
      // sitting in an agent chat, auto-resend the last user message so the
      // agent can fulfill the original request.
      if (!agentId || data.agent_id === agentId || data.agent_id == null) {
        resubmitLastUserMessage(data.toolkit);
      }
    }
  };

  function renderConnectorRequired(toolkit, redirectUrl) {
    const messagesEl = document.getElementById("chat-messages");
    if (!messagesEl) return;
    const wrap = document.createElement("div");
    wrap.className = "message assistant connector-cta";
    wrap.setAttribute("data-connector-cta", toolkit);
    wrap.innerHTML =
      '<div class="message-content">' +
        '<div style="display:flex;align-items:center;gap:0.75rem;padding:0.5rem 0;">' +
          '<i class="fas fa-plug" style="color:var(--primary-color);"></i>' +
          '<span>Connect <strong>' + escapeHtml(toolkit) + '</strong> to continue.</span>' +
          '<button class="btn btn-primary btn-sm" style="margin-left:auto;" ' +
            'onclick="openConnectorPopup(\'' + encodeURIComponent(redirectUrl) + '\', \'' + escapeHtml(toolkit) + '\')">' +
            '<i class="fas fa-external-link-alt"></i> Connect ' + escapeHtml(toolkit) +
          '</button>' +
        '</div>' +
      '</div>';
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  window.openConnectorPopup = function (encodedUrl, toolkit) {
    const url = decodeURIComponent(encodedUrl);
    const w = 520, h = 720;
    const left = (window.screen.width - w) / 2;
    const top = (window.screen.height - h) / 2;
    window.open(url, "composio-oauth-" + toolkit, "width=" + w + ",height=" + h + ",left=" + left + ",top=" + top);
  };

  function resubmitLastUserMessage(toolkit) {
    // Remove any pending connector CTA bubbles for this toolkit
    document.querySelectorAll('[data-connector-cta="' + toolkit + '"]').forEach((el) => el.remove());

    // Find the most recent user message and re-send it
    const userMsgs = document.querySelectorAll(".message.user .message-content, .message-user .message-content");
    const last = userMsgs[userMsgs.length - 1];
    if (!last) {
      console.log("[agents] No prior user message to resubmit");
      return;
    }
    const text = (last.textContent || "").trim();
    if (!text) return;

    // Programmatically populate the chat input and submit. chat.js owns the
    // actual send pipeline (WS, state mgmt, file uploads); we just trigger it.
    const input = document.getElementById("chat-input") || document.querySelector("textarea[name='message']");
    const form = document.getElementById("chat-form");
    if (!input || !form) {
      console.warn("[agents] chat input/form not found — can't auto-resend");
      return;
    }
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    // Small delay so the toast/render settles, then submit
    setTimeout(() => form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true })), 200);
  }

  function updateAgentStatus(id, status, _message) {
    const color = STATUS_COLORS[status] || "#6b7280";
    const label = STATUS_LABELS[status] || status;

    // Detail page badge
    const badge = document.getElementById("agent-status-badge");
    const statusText = document.getElementById("agent-status-text");
    const statusDot = document.getElementById("agent-status-dot");
    if (badge && statusText && (id === agentId || !agentId)) {
      badge.style.color = color;
      badge.style.background = color + "15";
      badge.title = label;
      statusText.textContent = label;
      if (statusDot) statusDot.style.background = color;
    }

    // List page card badge
    const card = document.querySelector('.agent-card[data-agent-id="' + id + '"]');
    if (card) {
      const cardBadge = card.querySelector(".agent-status-badge");
      if (cardBadge) {
        cardBadge.style.color = color;
        cardBadge.style.background = color + "15";
        cardBadge.innerHTML = '<span class="status-dot" style="background:' + color + ';"></span>' + label;
      }
    }
  }

  window.togglePauseAgent = async function (id) {
    // Reserved: hook this to a /pause endpoint once schedule-level pause exists.
    // For now, no-op with a hint.
    console.log("[agents] Pause toggle not yet wired", id);
  };

  // ── Agent CRUD ──────────────────────────────────────────────────────

  // Create a fresh agent and redirect into its chat. The agent is live
  // from message 1 — the LLM picks up a name + instructions from the
  // conversation and saves them via proposeAgentConfig.
  window.createNewAgent = async function () {
    try {
      var res = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        var result = await res.json();
        window.location.href = "/agents/" + result.agent.agentId;
      } else {
        var err = await res.json().catch(function () { return {}; });
        alert(err.error || "Failed to create agent");
      }
    } catch (err) {
      alert("Network error: " + err.message);
    }
  };

  window.deleteAgent = async function (id, name) {
    if (!confirm('Delete agent "' + name + '"? This cannot be undone.')) return;
    try {
      var res = await fetch("/api/agents/" + id, { method: "DELETE" });
      if (res.ok) {
        window.location.href = "/agents";
      } else {
        alert("Failed to delete agent");
      }
    } catch (err) {
      alert("Error: " + err.message);
    }
  };

  // ── Settings ────────────────────────────────────────────────────────

  window.handleSaveSettings = async function (e) {
    e.preventDefault();
    if (!agentId) return;

    var form = e.target;
    var runTimeoutMin = parseInt(form.run_timeout_minutes?.value || "30", 10);
    var autoStopMin = parseInt(form.auto_stop_minutes?.value || "0", 10);
    var data = {
      name: form.name.value,
      personality: form.personality.value,
      instructions: form.instructions.value,
      composio_toolkits: Array.from(form.querySelectorAll('input[name="composio_toolkits"]:checked')).map(function (cb) { return cb.value; }),
      run_timeout_ms: runTimeoutMin > 0 ? runTimeoutMin * 60000 : null,
      auto_stop_after_idle_ms: autoStopMin > 0 ? autoStopMin * 60000 : null,
    };

    try {
      var res = await fetch("/api/agents/" + agentId, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        var nameDisplay = document.getElementById("agent-name-display");
        if (nameDisplay) nameDisplay.textContent = data.name;
        showToast("Settings saved");
      }
    } catch (err) {
      alert("Error: " + err.message);
    }
  };

  window.copyWebhookUrl = function () {
    var input = document.querySelector('input[readonly][value*="/api/agents/webhook/"]');
    if (!input) return;
    var fullUrl = location.origin + input.value;
    navigator.clipboard.writeText(fullUrl).then(function () {
      showToast("Webhook URL copied");
    }).catch(function () {
      alert(fullUrl);
    });
  };

  // ── Tabs ────────────────────────────────────────────────────────────

  window.switchTab = function (tabName) {
    // Update tab buttons
    document.querySelectorAll(".tab-button").forEach(function (t) { t.classList.remove("active"); });
    document.querySelector('.tab-button[data-tab="' + tabName + '"]')?.classList.add("active");

    // Update tab panes
    document.querySelectorAll(".tab-pane").forEach(function (c) { c.classList.remove("active"); });
    document.getElementById(tabName)?.classList.add("active");

    if (tabName === "data") loadDataFiles();
    if (tabName === "schedules") loadSchedules();
    if (tabName === "secrets") loadSecrets();
    if (tabName === "runs") loadRuns();
    if (tabName === "state") loadState();
  };

  // ── Data Room ───────────────────────────────────────────────────────

  async function loadDataFiles() {
    if (!agentId) return;
    var el = document.getElementById("data-files-list");
    try {
      var res = await fetch("/api/agents/" + agentId + "/data");
      var data = await res.json();
      if (!data.files?.length) {
        el.innerHTML = '<p style="color:var(--text-secondary);font-size:0.875rem;">No files yet.</p>';
        return;
      }
      el.innerHTML = data.files.map(function (f) {
        var size = f.file_size ? formatFileSize(f.file_size) : "";
        return '<div class="data-file-item">' +
          '<i class="fas fa-file data-file-icon"></i>' +
          '<div class="data-file-info">' +
            '<div class="data-file-name">' + escapeHtml(f.file_name) + '</div>' +
            '<div class="data-file-meta">' + size + ' · ' + (f.file_type || "unknown") + '</div>' +
          '</div>' +
          '<a href="/api/agents/' + agentId + '/data/' + f.id + '" class="btn btn-sm btn-secondary" download>' +
            '<i class="fas fa-download"></i>' +
          '</a>' +
          '<button class="btn btn-sm btn-danger-outline" onclick="deleteDataFile(\'' + f.id + '\')">' +
            '<i class="fas fa-trash"></i>' +
          '</button>' +
        '</div>';
      }).join("");
    } catch {
      el.innerHTML = '<p style="color:var(--danger-color);">Failed to load files.</p>';
    }
  }

  window.handleFileUpload = async function (e) {
    var file = e.target.files[0];
    if (!file || !agentId) return;

    var formData = new FormData();
    formData.append("file", file);

    try {
      var res = await fetch("/api/agents/" + agentId + "/data", {
        method: "POST",
        body: formData,
      });
      if (res.ok) {
        loadDataFiles();
        showToast("File uploaded");
      }
    } catch (err) {
      alert("Upload failed: " + err.message);
    }
    e.target.value = "";
  };

  window.deleteDataFile = async function (fileId) {
    if (!agentId || !confirm("Delete this file?")) return;
    try {
      await fetch("/api/agents/" + agentId + "/data/" + fileId, { method: "DELETE" });
      loadDataFiles();
    } catch (err) {
      alert("Error: " + err.message);
    }
  };

  // ── Schedules ───────────────────────────────────────────────────────

  async function loadSchedules() {
    if (!agentId) return;
    var el = document.getElementById("schedules-list");
    try {
      var res = await fetch("/api/agents/" + agentId + "/schedules");
      var data = await res.json();
      if (!data.schedules?.length) {
        el.innerHTML = '<p style="color:var(--text-secondary);font-size:0.875rem;">No scheduled tasks.</p>';
        return;
      }
      el.innerHTML = data.schedules.map(function (s) {
        return '<div class="schedule-item">' +
          '<div class="schedule-item-header">' +
            '<span class="schedule-name">' + escapeHtml(s.name) + '</span>' +
            '<div style="display:flex;gap:0.375rem;align-items:center;">' +
              '<span class="schedule-cron">' + escapeHtml(s.cron_expression) + '</span>' +
              '<button class="btn btn-sm btn-secondary" onclick="runScheduleNow(\'' + s.id + '\')" style="padding:0.25rem 0.5rem;" title="Run now">' +
                '<i class="fas fa-play"></i>' +
              '</button>' +
              '<button class="btn btn-sm btn-danger-outline" onclick="deleteSchedule(\'' + s.id + '\')" style="padding:0.25rem 0.5rem;">' +
                '<i class="fas fa-trash"></i>' +
              '</button>' +
            '</div>' +
          '</div>' +
          '<div class="schedule-command">' + escapeHtml((s.command || "").slice(0, 120)) + '</div>' +
          (s.next_run_at ? '<div style="font-size:0.6875rem;color:var(--text-secondary);margin-top:0.25rem;">Next: ' + new Date(s.next_run_at).toLocaleString() + '</div>' : "") +
        '</div>';
      }).join("");
    } catch {
      el.innerHTML = '<p style="color:var(--danger-color);">Failed to load schedules.</p>';
    }
  }

  window.showAddScheduleForm = function () {
    document.getElementById("add-schedule-form").style.display = "block";
  };

  window.handleAddSchedule = async function () {
    if (!agentId) return;
    var name = document.getElementById("schedule-name").value.trim();
    var cron = document.getElementById("schedule-cron").value.trim();
    var command = document.getElementById("schedule-command").value.trim();

    if (!name || !cron || !command) { alert("All fields required"); return; }

    try {
      var res = await fetch("/api/agents/" + agentId + "/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name, cron_expression: cron, command: command }),
      });
      if (res.ok) {
        document.getElementById("add-schedule-form").style.display = "none";
        document.getElementById("schedule-name").value = "";
        document.getElementById("schedule-cron").value = "";
        document.getElementById("schedule-command").value = "";
        loadSchedules();
        showToast("Schedule added");
      }
    } catch (err) {
      alert("Error: " + err.message);
    }
  };

  window.deleteSchedule = async function (scheduleId) {
    if (!agentId || !confirm("Delete this schedule?")) return;
    try {
      await fetch("/api/agents/" + agentId + "/schedules/" + scheduleId, { method: "DELETE" });
      loadSchedules();
    } catch (err) {
      alert("Error: " + err.message);
    }
  };

  // ── Memory ──────────────────────────────────────────────────────────

  window.handleSyncMemory = async function () {
    if (!agentId) return;
    try {
      var res = await fetch("/api/agents/" + agentId + "/sync-memory", { method: "POST" });
      var data = await res.json();
      var editor = document.getElementById("memory-editor");
      if (editor && data.memory) {
        editor.value = data.memory;
      }
      showToast("Memory synced from sandbox");
    } catch (err) {
      alert("Sync failed: " + err.message);
    }
  };

  window.handleSaveMemory = async function () {
    if (!agentId) return;
    var editor = document.getElementById("memory-editor");
    if (!editor) return;

    try {
      await fetch("/api/agents/" + agentId + "/memory", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memory: editor.value }),
      });
      showToast("Memory saved");
    } catch (err) {
      alert("Save failed: " + err.message);
    }
  };

  // ── Secrets ─────────────────────────────────────────────────────────

  async function loadSecrets() {
    if (!agentId) return;
    var el = document.getElementById("secrets-list");
    if (!el) return;
    try {
      var res = await fetch("/api/agents/" + agentId + "/secrets");
      var data = await res.json();
      if (!data.secrets?.length) {
        el.innerHTML = '<p style="color:var(--text-secondary);font-size:0.875rem;">No secrets yet. Add one to let the agent call APIs directly.</p>';
        return;
      }
      el.innerHTML = data.secrets.map(function (s) {
        return '<div class="schedule-item">' +
          '<div class="schedule-item-header">' +
            '<span class="schedule-name" style="font-family:monospace;">' + escapeHtml(s.key) + '</span>' +
            '<div style="display:flex;gap:0.375rem;align-items:center;">' +
              (s.service ? '<span class="schedule-cron">' + escapeHtml(s.service) + '</span>' : '') +
              '<button class="btn btn-sm btn-danger-outline" onclick="deleteSecret(\'' + s.id + '\')" style="padding:0.25rem 0.5rem;">' +
                '<i class="fas fa-trash"></i>' +
              '</button>' +
            '</div>' +
          '</div>' +
          (s.description ? '<div class="schedule-command">' + escapeHtml(s.description) + '</div>' : '') +
        '</div>';
      }).join("");
    } catch {
      el.innerHTML = '<p style="color:var(--danger-color);">Failed to load secrets.</p>';
    }
  }

  window.showAddSecretForm = function () {
    document.getElementById("add-secret-form").style.display = "block";
  };

  window.handleAddSecret = async function () {
    if (!agentId) return;
    var key = document.getElementById("secret-key").value.trim();
    var value = document.getElementById("secret-value").value;
    var service = document.getElementById("secret-service").value.trim();
    var description = document.getElementById("secret-description").value.trim();

    if (!key || !value) { alert("Key and value required"); return; }

    try {
      var res = await fetch("/api/agents/" + agentId + "/secrets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: key, value: value, service: service || undefined, description: description || undefined }),
      });
      if (res.ok) {
        document.getElementById("add-secret-form").style.display = "none";
        document.getElementById("secret-key").value = "";
        document.getElementById("secret-value").value = "";
        document.getElementById("secret-service").value = "";
        document.getElementById("secret-description").value = "";
        loadSecrets();
        showToast("Secret saved");
      } else {
        var err = await res.json();
        alert(err.error || "Failed to save secret");
      }
    } catch (err) {
      alert("Error: " + err.message);
    }
  };

  window.deleteSecret = async function (secretId) {
    if (!agentId || !confirm("Delete this secret?")) return;
    try {
      await fetch("/api/agents/" + agentId + "/secrets/" + secretId, { method: "DELETE" });
      loadSecrets();
    } catch (err) {
      alert("Error: " + err.message);
    }
  };

  // ── Runs ────────────────────────────────────────────────────────────

  window.loadRuns = async function () {
    if (!agentId) return;
    var el = document.getElementById("runs-list");
    if (!el) return;
    try {
      var res = await fetch("/api/agents/" + agentId + "/runs?limit=50");
      var data = await res.json();
      if (!data.runs?.length) {
        el.innerHTML = '<p style="color:var(--text-secondary);font-size:0.875rem;">No runs yet.</p>';
        return;
      }
      var statusColors = {
        queued: "#6b7280",
        running: "#22c55e",
        success: "#22c55e",
        error: "#ef4444",
        timeout: "#f59e0b",
        cancelled: "#6b7280",
      };
      el.innerHTML = data.runs.map(function (r) {
        var color = statusColors[r.status] || "#6b7280";
        var duration = "";
        if (r.started_at && r.finished_at) {
          var ms = new Date(r.finished_at) - new Date(r.started_at);
          duration = Math.round(ms / 1000) + "s";
        } else if (r.started_at) {
          duration = "running";
        }
        return '<div class="schedule-item">' +
          '<div class="schedule-item-header">' +
            '<span class="schedule-name" style="text-transform:capitalize;">' + escapeHtml(r.trigger_type) + '</span>' +
            '<div style="display:flex;gap:0.375rem;align-items:center;">' +
              '<span class="schedule-cron" style="color:' + color + ';background:' + color + '15;">' + escapeHtml(r.status) + '</span>' +
              (duration ? '<span class="schedule-cron">' + escapeHtml(duration) + '</span>' : '') +
            '</div>' +
          '</div>' +
          '<div class="schedule-command">' + escapeHtml((r.prompt || "").slice(0, 140)) + '</div>' +
          (r.error_message ? '<div style="color:var(--danger-color);font-size:0.6875rem;margin-top:0.25rem;">' + escapeHtml(r.error_message) + '</div>' : '') +
          (r.output_summary ? '<div style="font-size:0.6875rem;color:var(--text-secondary);margin-top:0.25rem;">' + escapeHtml(r.output_summary.slice(0, 200)) + '</div>' : '') +
          '<div style="font-size:0.6875rem;color:var(--text-secondary);margin-top:0.25rem;">' +
            new Date(r.created_at).toLocaleString() +
          '</div>' +
        '</div>';
      }).join("");
    } catch {
      el.innerHTML = '<p style="color:var(--danger-color);">Failed to load runs.</p>';
    }
  };

  window.runScheduleNow = async function (scheduleId) {
    if (!agentId) return;
    try {
      var res = await fetch("/api/agents/" + agentId + "/schedules/" + scheduleId + "/run-now", { method: "POST" });
      if (res.ok) {
        showToast("Schedule triggered");
      } else {
        var err = await res.json();
        alert(err.error || "Failed to trigger");
      }
    } catch (err) {
      alert("Error: " + err.message);
    }
  };

  // ── State ───────────────────────────────────────────────────────────

  window.loadState = async function () {
    if (!agentId) return;
    var el = document.getElementById("state-editor");
    if (!el) return;
    try {
      var res = await fetch("/api/agents/" + agentId + "/state");
      var data = await res.json();
      el.value = JSON.stringify(data.state ?? {}, null, 2);
    } catch {
      el.value = "{}";
    }
  };

  window.handleSaveState = async function () {
    if (!agentId) return;
    var el = document.getElementById("state-editor");
    if (!el) return;
    var parsed;
    try {
      parsed = JSON.parse(el.value);
    } catch (err) {
      alert("Invalid JSON: " + err.message);
      return;
    }
    try {
      await fetch("/api/agents/" + agentId + "/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: parsed }),
      });
      showToast("State saved");
    } catch (err) {
      alert("Error: " + err.message);
    }
  };

  // ── Utilities ───────────────────────────────────────────────────────

  function escapeHtml(str) {
    if (!str) return "";
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
  }

  function showToast(message) {
    var toast = document.createElement("div");
    toast.textContent = message;
    toast.style.cssText = "position:fixed;bottom:1.5rem;right:1.5rem;background:var(--primary-color);color:#fff;padding:0.625rem 1.25rem;border-radius:var(--radius);font-size:0.875rem;z-index:9999;animation:fadeIn 0.2s;";
    document.body.appendChild(toast);
    setTimeout(function () { toast.remove(); }, 2500);
  }

  // ── Artifacts panel toggle (for agent settings panel) ─────────────
  // Replicate the toggle behavior from artifacts.js

  var panel = document.getElementById("artifacts-panel");
  var toggleBtn = document.getElementById("artifacts-toggle");
  var settingsBtn = document.getElementById("artifacts-button");
  var appContainer = document.querySelector(".app-container");

  function toggleSettingsPanel() {
    if (!panel) return;
    var isExpanded = panel.classList.toggle("expanded");
    if (appContainer) {
      if (isExpanded) {
        appContainer.classList.add("artifacts-expanded");
      } else {
        appContainer.classList.remove("artifacts-expanded");
      }
    }
  }

  if (toggleBtn) toggleBtn.addEventListener("click", toggleSettingsPanel);
  if (settingsBtn) settingsBtn.addEventListener("click", toggleSettingsPanel);

  // ── Pause button — show only when the agent has schedules ─────────
  // Otherwise there's nothing to pause: chat-driven runs are already
  // "paused" by virtue of the user not sending messages.
  (async function syncPauseButtonVisibility() {
    if (!agentId) return;
    var btn = document.getElementById("agent-pause-btn");
    if (!btn) return;
    try {
      var res = await fetch("/api/agents/" + agentId + "/schedules");
      if (!res.ok) return;
      var data = await res.json();
      if ((data.schedules || []).length > 0) btn.style.display = "inline-flex";
    } catch { /* ignore */ }
  })();

  // ── Lightweight WebSocket for pages without chat.js (list/central) ──
  // On the detail page, chat.js manages the WS and forwards agent_status
  // messages via window.__handleAgentWsMessage__. On other pages, we need
  // our own connection for real-time status updates.

  var hasChatJs = !!document.getElementById("chat-form");
  if (!hasChatJs) {
    var userId = document.body.dataset.userId;
    if (userId) {
      (function connectAgentWs() {
        var proto = location.protocol === "https:" ? "wss" : "ws";
        var ws = new WebSocket(proto + "://" + location.host + "/ws/chat");
        ws.onmessage = function (event) {
          try {
            var data = JSON.parse(event.data);
            if (data.type === "agent_status") {
              updateAgentStatus(data.agent_id, data.status, data.message);
            }
          } catch { /* ignore */ }
        };
        ws.onclose = function () { setTimeout(connectAgentWs, 3000); };
        ws.onerror = function () { ws.close(); };
      })();
    }
  }
})();
