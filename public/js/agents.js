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
        // Also open the Connectors modal pre-filtered to this toolkit so the
        // user sees the full integration card (logo, description, Connect
        // button) without having to click the inline chat button first.
        if (typeof window.openConnectorsModal === "function") {
          window.openConnectorsModal(data.toolkit);
        }
      }
    } else if (data.type === "connector_connected") {
      if (!agentId || data.agent_id === agentId || data.agent_id == null) {
        resubmitLastUserMessage(data.toolkit);
      }
    } else if (data.type === "secret_required") {
      if (!agentId || data.agent_id === agentId) {
        renderSecretRequired(data.key, data.description, data.service);
      }
    } else if (data.type === "agent_data_file_created") {
      if (!agentId || data.agent_id === agentId) {
        // Register so future [CHART: name] markers can find this artifact
        artifactsByName.set(data.file_name, data);
        // Fill any placeholder slots the LLM already wrote with this name
        fillPlaceholderSlots(data);
        // Also keep the "cluster under the bubble" rendering for files the
        // LLM forgot to reference inline — but only if no slot exists for it
        const hasSlot = document.querySelector('.agent-chart-slot[data-chart-filename="' + data.file_name.replace(/"/g, '\\"') + '"]');
        if (!hasSlot) renderDataFileInline(data);
      }
    }
  };

  // ── Julius-style chart interleaving ────────────────────────────────
  // The LLM weaves [CHART: filename.html] markers into its narrative.
  // We swap each marker with an inline iframe for that artifact, right
  // where the LLM placed it. Tracked here so the swap survives chat.js's
  // streaming innerHTML re-renders (which wipe our DOM changes on every
  // chunk — we just re-apply via MutationObserver).
  const artifactsByName = new Map();

  function buildArtifactInnerHTML(d) {
    const ext = (d.file_type || "").toLowerCase();
    const isImage = ["png","jpg","jpeg","gif","webp","svg"].includes(ext);
    const isHtml = ["html","htm"].includes(ext);
    if (isImage) {
      return (
        '<div class="agent-artifact-image">' +
          '<img src="' + d.download_url + '" alt="' + escapeHtml(d.file_name) + '" />' +
          '<div class="agent-artifact-caption">' +
            '<i class="fas fa-image"></i> ' + escapeHtml(d.file_name) +
            ' <span class="muted">' + formatFileSize(d.file_size) + '</span>' +
            ' · <a href="' + d.download_url + '?disposition=attachment" download>download</a>' +
          '</div>' +
        '</div>'
      );
    }
    if (isHtml) {
      return (
        '<div class="agent-artifact-html-inline">' +
          '<div class="agent-artifact-caption">' +
            '<i class="fas fa-chart-line"></i> ' + escapeHtml(d.file_name) +
            ' <span class="muted">' + formatFileSize(d.file_size) + '</span>' +
            ' · <a href="' + d.download_url + '" target="_blank" rel="noopener">open full-screen</a>' +
            ' · <a href="' + d.download_url + '?disposition=attachment" download>download</a>' +
          '</div>' +
          '<iframe class="agent-artifact-html-iframe" src="' + d.download_url + '" sandbox="allow-scripts allow-same-origin" loading="lazy"></iframe>' +
        '</div>'
      );
    }
    return (
      '<div class="agent-artifact-file">' +
        '<i class="fas fa-file"></i> ' +
        '<strong>' + escapeHtml(d.file_name) + '</strong> ' +
        '<span class="muted">' + formatFileSize(d.file_size) + ' · ' + (d.file_type || "file") + '</span> · ' +
        '<a href="' + d.download_url + '?disposition=attachment" download>download</a>' +
      '</div>'
    );
  }

  // Replace [CHART: filename] markers in a text node with inline artifact
  // elements. Idempotent — already-replaced markers don't appear as text
  // nodes anymore so they won't be re-processed.
  function substituteMarkersInTextNode(textNode) {
    const text = textNode.nodeValue || "";
    const re = /\[CHART:\s*([^\]\s][^\]]*?)\s*\]/g;
    if (!re.test(text)) return;
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let lastIdx = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > lastIdx) frag.appendChild(document.createTextNode(text.slice(lastIdx, m.index)));
      const fileName = m[1].trim();
      const slot = document.createElement("div");
      slot.className = "agent-chart-slot";
      slot.setAttribute("data-chart-filename", fileName);
      const known = artifactsByName.get(fileName);
      slot.innerHTML = known
        ? buildArtifactInnerHTML(known)
        : '<div class="agent-chart-placeholder"><i class="fas fa-spinner fa-spin"></i> Rendering ' + escapeHtml(fileName) + '…</div>';
      frag.appendChild(slot);
      lastIdx = re.lastIndex;
    }
    if (lastIdx < text.length) frag.appendChild(document.createTextNode(text.slice(lastIdx)));
    textNode.parentNode.replaceChild(frag, textNode);
  }

  function scanAndReplaceMarkers(root) {
    if (!root || !root.querySelectorAll) return;
    const contents = root.matches && root.matches(".message-content")
      ? [root]
      : root.querySelectorAll(".message.assistant .message-content");
    contents.forEach(function (content) {
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) {
          // Skip inside <code>/<pre> — markers there are intentional code
          let p = n.parentNode;
          while (p && p !== content) {
            const tag = (p.tagName || "").toUpperCase();
            if (tag === "CODE" || tag === "PRE") return NodeFilter.FILTER_REJECT;
            p = p.parentNode;
          }
          return /\[CHART:/.test(n.nodeValue || "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      });
      const targets = [];
      let n;
      while ((n = walker.nextNode())) targets.push(n);
      targets.forEach(substituteMarkersInTextNode);
    });
  }

  // Fill any already-rendered placeholder slots when a new artifact arrives.
  function fillPlaceholderSlots(d) {
    document.querySelectorAll('.agent-chart-slot[data-chart-filename="' + d.file_name.replace(/"/g, '\\"') + '"]').forEach(function (slot) {
      slot.innerHTML = buildArtifactInnerHTML(d);
    });
  }

  // Single global observer for marker substitution — runs after every
  // streaming innerHTML re-render so swapped markers re-appear instantly.
  function startMarkerObserver() {
    const messagesEl = document.getElementById("chat-messages");
    if (!messagesEl) return;
    if (messagesEl._markerObserver) return;
    const obs = new MutationObserver(function (mutations) {
      for (let i = 0; i < mutations.length; i++) {
        const m = mutations[i];
        if (m.type === "childList") {
          m.addedNodes.forEach(function (n) {
            if (n.nodeType === 1) scanAndReplaceMarkers(n);
          });
        } else if (m.type === "characterData") {
          if (m.target.parentNode) substituteMarkersInTextNode(m.target);
        }
      }
    });
    obs.observe(messagesEl, { childList: true, subtree: true, characterData: true });
    messagesEl._markerObserver = obs;
    // Initial scan for already-rendered content (history load)
    scanAndReplaceMarkers(messagesEl);
  }

  // Run once DOM is interactive
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startMarkerObserver);
  } else {
    startMarkerObserver();
  }

  // Queue for artifacts whose WS event arrived before the assistant bubble
  // existed (sync fires the moment runInSandbox returns, but the LLM might
  // still be streaming its text response). Flushed by a MutationObserver
  // when a new .message.assistant appears.
  const pendingArtifacts = [];
  let artifactObserver = null;

  function ensureArtifactObserver() {
    if (artifactObserver) return;
    const messagesEl = document.getElementById("chat-messages");
    if (!messagesEl) return;
    artifactObserver = new MutationObserver(function () {
      if (!pendingArtifacts.length) return;
      const assistantBubbles = messagesEl.querySelectorAll(".message.assistant");
      const lastBubble = assistantBubbles[assistantBubbles.length - 1];
      if (lastBubble) {
        const queue = pendingArtifacts.splice(0);
        console.log("[agent-artifact] flushing", queue.length, "queued artifacts under assistant bubble");
        queue.forEach(function (d) { renderDataFileInline(d, lastBubble); });
      }
    });
    artifactObserver.observe(messagesEl, { childList: true, subtree: true });
  }

  // Renders a new Data Room file as an inline preview attached AFTER the
  // most recent assistant message bubble. Important: insert as a SIBLING of
  // the bubble, not inside .message-content — chat.js's streaming render
  // does contentDiv.innerHTML = marked.parse(...) on every chunk, which
  // would wipe any artifact appended INSIDE the content div. Siblings
  // survive the re-render.
  //
  // If no assistant bubble exists yet (sync arrived before LLM finished
  // streaming), queue the artifact and flush when a bubble appears.
  function renderDataFileInline(data, explicitBubble) {
    console.log("[agent-artifact] render", data.file_name, "type=", data.file_type, "agent=", data.agent_id);
    const messagesEl = document.getElementById("chat-messages");
    if (!messagesEl) {
      console.warn("[agent-artifact] no #chat-messages element");
      return;
    }

    // Find the latest assistant bubble (the one the LLM just sent / is sending)
    const assistantBubbles = messagesEl.querySelectorAll(".message.assistant");
    const lastBubble = explicitBubble || assistantBubbles[assistantBubbles.length - 1];
    if (!lastBubble) {
      console.log("[agent-artifact] queuing", data.file_name, "until assistant bubble appears");
      pendingArtifacts.push(data);
      ensureArtifactObserver();
      return;
    }

    const ext = (data.file_type || "").toLowerCase();
    const isImage = ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext);
    const isHtml = ["html", "htm"].includes(ext);

    const wrap = document.createElement("div");
    wrap.className = "agent-artifact";
    wrap.setAttribute("data-file-id", data.file_id);

    if (isImage) {
      wrap.innerHTML =
        '<div class="agent-artifact-image">' +
          '<img src="' + data.download_url + '" alt="' + escapeHtml(data.file_name) + '" />' +
          '<div class="agent-artifact-caption">' +
            '<i class="fas fa-image"></i> ' + escapeHtml(data.file_name) +
            ' <span class="muted">' + formatFileSize(data.file_size) + '</span>' +
            ' · <a href="' + data.download_url + '" download>download</a>' +
          '</div>' +
        '</div>';
    } else if (isHtml) {
      // Inline iframe for interactive charts (Plotly etc.). The download
      // endpoint now serves Content-Disposition: inline by default so the
      // browser renders the HTML instead of trying to download it.
      // Download link explicitly asks for attachment via ?disposition=.
      wrap.innerHTML =
        '<div class="agent-artifact-html-inline">' +
          '<div class="agent-artifact-caption">' +
            '<i class="fas fa-chart-line"></i> ' + escapeHtml(data.file_name) +
            ' <span class="muted">' + formatFileSize(data.file_size) + '</span>' +
            ' · <a href="' + data.download_url + '" target="_blank" rel="noopener">open full-screen</a>' +
            ' · <a href="' + data.download_url + '?disposition=attachment" download>download</a>' +
          '</div>' +
          '<iframe class="agent-artifact-html-iframe" src="' + data.download_url + '" ' +
                  'sandbox="allow-scripts allow-same-origin" loading="lazy"></iframe>' +
        '</div>';
    } else {
      wrap.innerHTML =
        '<div class="agent-artifact-file">' +
          '<i class="fas fa-file"></i> ' +
          '<strong>' + escapeHtml(data.file_name) + '</strong> ' +
          '<span class="muted">' + formatFileSize(data.file_size) + ' · ' + (data.file_type || "file") + '</span> · ' +
          '<a href="' + data.download_url + '" download>download</a>' +
        '</div>';
    }

    // Insert AFTER the bubble (as a sibling) so streaming innerHTML updates
    // on the bubble's .message-content can't wipe our artifact.
    if (lastBubble && lastBubble.parentNode) {
      lastBubble.parentNode.insertBefore(wrap, lastBubble.nextSibling);
    } else {
      messagesEl.appendChild(wrap);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;

    // Catch the "artifact appeared then vanished" bug — MutationObserver
    // tells us exactly what removed our node. Disconnects itself after the
    // first detection so it doesn't leak.
    const watch = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var removed = muts[i].removedNodes;
        for (var j = 0; j < removed.length; j++) {
          if (removed[j] === wrap || (removed[j].contains && removed[j].contains(wrap))) {
            console.warn("[agent-artifact] vanished:", data.file_name, "removed by mutation in", muts[i].target);
            watch.disconnect();
            return;
          }
        }
      }
    });
    watch.observe(messagesEl, { childList: true, subtree: true });
    setTimeout(function () { watch.disconnect(); }, 30000);
  }

  // After chat.js loads conversation history, the artifacts that previously
  // rendered live (via WS) are no longer in the DOM — they were ephemeral.
  // Fetch the agent's data files once history is rendered and re-inline them
  // so charts survive a refresh. Polled because chat.js doesn't fire an event
  // we can hook directly; checks for the message-container being populated.
  if (agentId) {
    let triedHistoryReload = false;
    const historyPoll = setInterval(function () {
      const messagesEl = document.getElementById("chat-messages");
      if (!messagesEl) return;
      const bubbles = messagesEl.querySelectorAll(".message");
      if (bubbles.length === 0) return;
      if (triedHistoryReload) { clearInterval(historyPoll); return; }
      triedHistoryReload = true;
      clearInterval(historyPoll);

      fetch("/api/agents/" + agentId + "/data")
        .then(function (r) { return r.ok ? r.json() : { files: [] }; })
        .then(function (data) {
          var files = (data.files || []);
          if (!files.length) return;
          console.log("[agent-artifact] hydrating", files.length, "files from history");
          // Populate the registry FIRST so marker scan can find them.
          files.forEach(function (f) {
            artifactsByName.set(f.file_name, {
              agent_id: agentId,
              file_id: f.id,
              file_name: f.file_name,
              file_type: f.file_type,
              file_size: f.file_size,
              download_url: "/api/agents/" + agentId + "/data/" + f.id,
            });
          });
          // Re-scan rendered content — markers in old assistant messages
          // (from history) will now find their artifacts and inline-render.
          scanAndReplaceMarkers(messagesEl);
          // For any file that wasn't referenced by an inline marker, fall
          // back to the "append under last bubble" cluster behaviour.
          files.reverse().forEach(function (f) {
            const hasSlot = document.querySelector('.agent-chart-slot[data-chart-filename="' + f.file_name.replace(/"/g, '\\"') + '"]');
            if (hasSlot) return;
            renderDataFileInline({
              agent_id: agentId,
              file_id: f.id,
              file_name: f.file_name,
              file_type: f.file_type,
              file_size: f.file_size,
              download_url: "/api/agents/" + agentId + "/data/" + f.id,
            });
          });
        });
    }, 300);
    setTimeout(function () { clearInterval(historyPoll); }, 10000);
  }

  window.openHtmlArtifact = function (url, name) {
    const overlay = document.createElement("div");
    overlay.className = "artifact-modal-overlay";
    overlay.innerHTML =
      '<div class="artifact-modal">' +
        '<div class="artifact-modal-header">' +
          '<span><i class="fas fa-chart-line"></i> ' + escapeHtml(name) + '</span>' +
          '<button class="artifact-modal-close" aria-label="Close">×</button>' +
        '</div>' +
        '<iframe class="artifact-modal-iframe" src="' + url + '" sandbox="allow-scripts allow-same-origin allow-popups"></iframe>' +
      '</div>';
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay || e.target.classList.contains("artifact-modal-close")) {
        overlay.remove();
      }
    });
    document.body.appendChild(overlay);
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

  function renderSecretRequired(key, description, service) {
    const messagesEl = document.getElementById("chat-messages");
    if (!messagesEl) return;
    const wrap = document.createElement("div");
    wrap.className = "message assistant secret-cta";
    wrap.setAttribute("data-secret-cta", key);
    wrap.innerHTML =
      '<div class="message-content">' +
        '<div style="display:flex;flex-direction:column;gap:0.5rem;padding:0.5rem 0;">' +
          '<div style="display:flex;align-items:center;gap:0.5rem;">' +
            '<i class="fas fa-key" style="color:var(--primary-color);"></i>' +
            '<strong>' + key + '</strong>' +
            (service ? '<span style="font-size:0.75rem;color:var(--text-secondary);">(' + service + ')</span>' : '') +
          '</div>' +
          '<div style="font-size:0.8125rem;color:var(--text-secondary);">' + escapeHtml(description || "") + '</div>' +
          '<div style="display:flex;gap:0.5rem;align-items:center;">' +
            '<input type="password" id="secret-input-' + key + '" class="input" style="flex:1;font-family:monospace;font-size:0.8125rem;" placeholder="Paste value, then Save" />' +
            '<button class="btn btn-primary btn-sm" onclick="submitInlineSecret(\'' + key + '\', ' + JSON.stringify(service || "") + ')">' +
              '<i class="fas fa-save"></i> Save' +
            '</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    setTimeout(() => document.getElementById("secret-input-" + key)?.focus(), 50);
  }

  window.submitInlineSecret = async function (key, service) {
    const input = document.getElementById("secret-input-" + key);
    if (!input || !input.value.trim()) return;
    const value = input.value;
    try {
      const res = await fetch("/api/agents/" + agentId + "/secrets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value, service: service || undefined }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error || "Failed to save secret");
        return;
      }
      // Remove the bubble + auto-resubmit the prior user message
      document.querySelectorAll('[data-secret-cta="' + key + '"]').forEach((el) => el.remove());
      resubmitLastUserMessage(key);
    } catch (err) {
      alert("Error: " + err.message);
    }
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
    var btn = document.getElementById("agent-pause-btn");
    var paused = btn && btn.dataset.paused === "true";
    var endpoint = paused ? "/resume" : "/pause";
    try {
      var res = await fetch("/api/agents/" + id + endpoint, { method: "POST" });
      if (!res.ok) {
        var err = await res.json().catch(function () { return {}; });
        alert(err.error || "Failed to toggle pause");
        return;
      }
      // Flip button state + label
      if (btn) {
        var nowPaused = !paused;
        btn.dataset.paused = nowPaused ? "true" : "false";
        btn.innerHTML = nowPaused
          ? '<i class="fas fa-play"></i> Resume'
          : '<i class="fas fa-pause"></i> Pause';
        btn.title = nowPaused ? "All schedules paused — click to resume" : "Pause all scheduled runs";
      }
      showToast(paused ? "Schedules resumed" : "All schedules paused");
    } catch (err) {
      alert("Error: " + err.message);
    }
  };

  // ── Agent CRUD ──────────────────────────────────────────────────────

  // ── Example-prompt cards on empty agent chat ───────────────────────
  // Each card has data-prompt="..."; click fills the chat input.
  document.querySelectorAll(".example-prompt-card").forEach(function (card) {
    card.addEventListener("click", function () {
      var prompt = card.getAttribute("data-prompt") || "";
      var input = document.getElementById("chat-input");
      if (!input) return;
      input.value = prompt;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    });
  });

  // Create a fresh blank agent and redirect into its chat. The agent's
  // persona + instructions are filled in by the chat-side LLM through
  // proposeAgentConfig once the user describes what they want.
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
        var ext = (f.file_type || "").toLowerCase();
        var isPreviewable = ["csv", "tsv", "txt"].includes(ext);
        return '<div class="data-file-item" data-file-id="' + f.id + '">' +
          '<i class="fas fa-file data-file-icon"></i>' +
          '<div class="data-file-info">' +
            '<div class="data-file-name">' + escapeHtml(f.file_name) + '</div>' +
            '<div class="data-file-meta">' + size + ' · ' + (f.file_type || "unknown") + '</div>' +
          '</div>' +
          (isPreviewable
            ? '<button class="btn btn-sm btn-secondary" onclick="toggleDataFilePreview(\'' + f.id + '\')" title="Preview">' +
                '<i class="fas fa-eye"></i>' +
              '</button>'
            : '') +
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

  window.toggleDataFilePreview = async function (fileId) {
    if (!agentId) return;
    var row = document.querySelector('.data-file-item[data-file-id="' + fileId + '"]');
    if (!row) return;
    var existing = row.nextElementSibling;
    if (existing && existing.classList.contains("data-file-preview")) {
      existing.remove();
      return;
    }
    var preview = document.createElement("div");
    preview.className = "data-file-preview";
    preview.innerHTML = '<div class="data-file-preview-loading">Loading preview...</div>';
    row.insertAdjacentElement("afterend", preview);
    try {
      var res = await fetch("/api/agents/" + agentId + "/data/" + fileId + "/preview");
      if (!res.ok) {
        preview.innerHTML = '<div class="data-file-preview-err">Preview unavailable.</div>';
        return;
      }
      var data = await res.json();
      var headerRow = (data.headers || []).map(function (h) {
        return '<th>' + escapeHtml(h) + '</th>';
      }).join("");
      var bodyRows = (data.rows || []).map(function (r) {
        return '<tr>' + r.map(function (c) { return '<td>' + escapeHtml(c) + '</td>'; }).join("") + '</tr>';
      }).join("");
      preview.innerHTML =
        '<div class="data-file-preview-meta">First ' + data.rows_returned +
          ' of ~' + data.total_rows_approx + ' rows</div>' +
        '<div class="data-file-preview-scroll"><table class="data-file-preview-table">' +
          '<thead><tr>' + headerRow + '</tr></thead>' +
          '<tbody>' + bodyRows + '</tbody>' +
        '</table></div>';
    } catch (err) {
      preview.innerHTML = '<div class="data-file-preview-err">Preview error: ' + escapeHtml(err.message) + '</div>';
    }
  };

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

  // ── Right panel resize (drag the left edge) ────────────────────────
  var resizeHandle = document.getElementById("resize-handle");
  if (resizeHandle && panel) {
    var MIN_WIDTH = 320;
    var MAX_WIDTH_FRAC = 0.7; // 70% of viewport
    // CSS var that both .artifacts-container and .chat-container read.
    // Keeping these in sync prevents the chat header (Pause, gear) from
    // getting covered when the panel is wider than the default 350px.
    function syncPanelWidth(w) {
      document.documentElement.style.setProperty("--agent-panel-width", w + "px");
    }

    var storedWidth = parseInt(localStorage.getItem("agent_panel_width") || "0", 10);
    var initialWidth = storedWidth >= MIN_WIDTH ? storedWidth : 350;
    syncPanelWidth(initialWidth);

    var isResizing = false;
    var startX = 0;
    var startWidth = 0;

    function onMouseMove(e) {
      if (!isResizing) return;
      var dx = startX - e.clientX; // dragging left increases width
      var maxW = Math.floor(window.innerWidth * MAX_WIDTH_FRAC);
      var newWidth = Math.max(MIN_WIDTH, Math.min(maxW, startWidth + dx));
      syncPanelWidth(newWidth);
    }

    function onMouseUp() {
      if (!isResizing) return;
      isResizing = false;
      resizeHandle.classList.remove("active");
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      var w = parseInt(getComputedStyle(panel).width, 10);
      if (w >= MIN_WIDTH) localStorage.setItem("agent_panel_width", w);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    }

    resizeHandle.addEventListener("mousedown", function (e) {
      if (!panel.classList.contains("expanded")) return; // only when open
      isResizing = true;
      startX = e.clientX;
      startWidth = parseInt(getComputedStyle(panel).width, 10);
      resizeHandle.classList.add("active");
      document.body.style.userSelect = "none";
      document.body.style.cursor = "ew-resize";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      e.preventDefault();
    });

    // Re-clamp on viewport resize so the panel never exceeds 70% of new width.
    window.addEventListener("resize", function () {
      var maxW = Math.floor(window.innerWidth * MAX_WIDTH_FRAC);
      var current = parseInt(getComputedStyle(panel).width, 10);
      if (current > maxW) syncPanelWidth(maxW);
    });
  }

  // ── Pause button — show only when the agent has schedules ─────────
  // Show when at least one schedule exists. Derive the paused state from
  // "are all schedules disabled?" so the label/icon flips correctly on
  // page load too.
  (async function syncPauseButtonVisibility() {
    if (!agentId) return;
    var btn = document.getElementById("agent-pause-btn");
    if (!btn) return;
    try {
      var res = await fetch("/api/agents/" + agentId + "/schedules");
      if (!res.ok) return;
      var data = await res.json();
      var schedules = data.schedules || [];
      if (schedules.length === 0) return;
      btn.style.display = "inline-flex";
      var allDisabled = schedules.every(function (s) { return !s.enabled; });
      btn.dataset.paused = allDisabled ? "true" : "false";
      btn.innerHTML = allDisabled
        ? '<i class="fas fa-play"></i> Resume'
        : '<i class="fas fa-pause"></i> Pause';
      btn.title = allDisabled ? "All schedules paused — click to resume" : "Pause all scheduled runs";
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
