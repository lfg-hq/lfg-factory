/**
 * Issue-tracker card on the project dashboard (Jira / Linear).
 *
 * Renders one of four states — not set up, connected but unlinked, linked, or an error —
 * and drives link / sync / status-mapping / unlink against /api/projects/:id/boards.
 *
 * Lives in a static file rather than inline in project-detail.tsx on purpose: that
 * template is a backtick literal, and a stray backtick or ${ in an inline script takes
 * the whole page down.
 */
(function () {
  "use strict";

  var card = document.getElementById("board-card");
  if (!card) return;
  var body = document.getElementById("board-body");
  var projectId = card.getAttribute("data-project");
  var canManage = !!card.getAttribute("data-canmanage");
  var state = null;      // last /boards response
  var openMapping = null; // provider whose mapping editor is open

  function api(path, init) {
    return fetch("/api/projects/" + projectId + "/boards" + path, Object.assign({
      headers: { "Content-Type": "application/json" },
    }, init || {}));
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function ago(iso) {
    if (!iso) return "never";
    var secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (secs < 60) return "just now";
    if (secs < 3600) return Math.floor(secs / 60) + "m ago";
    if (secs < 86400) return Math.floor(secs / 3600) + "h ago";
    return Math.floor(secs / 86400) + "d ago";
  }

  var ICON = { linear: "fas fa-diagram-project", jira: "fab fa-jira" };
  var COLOR = { linear: "#5e6ad2", jira: "#2684ff" };

  function load() {
    api("").then(function (r) { return r.json(); }).then(function (j) {
      if (j.error) { body.innerHTML = '<div style="color:var(--text-secondary);">' + esc(j.error) + "</div>"; return; }
      state = j;
      render();
    }).catch(function (e) {
      body.innerHTML = '<div style="color:var(--text-secondary);">Could not load board status (' + esc(e.message) + ")</div>";
    });
  }

  function render() {
    if (!state) return;
    var linked = state.providers.filter(function (p) { return p.link; });
    var connectable = state.providers.filter(function (p) { return !p.link; });
    var html = "";

    linked.forEach(function (p) { html += linkedRow(p); });

    // Offer whatever isn't linked yet, but only one "connect" nudge — two big buttons
    // for two trackers nobody has connected is noise on a dashboard.
    var connected = connectable.filter(function (p) { return p.connected; });
    var available = connectable.filter(function (p) { return !p.connected && p.configured; });

    connected.forEach(function (p) { html += pickerRow(p); });

    if (!linked.length && !connected.length) {
      if (available.length) {
        html += '<div style="line-height:1.5;">Sync this project&#39;s tickets with a board.</div>'
          + '<div style="display:flex;gap:0.5rem;margin-top:0.6rem;flex-wrap:wrap;">'
          + available.map(function (p) {
              return '<a class="home-team-action" style="border:1px solid var(--border-color);border-radius:7px;padding:0.35rem 0.6rem;" href="/accounts/'
                + p.provider + "-connect?returnTo=" + encodeURIComponent("/projects/" + projectId)
                + '"><i class="' + ICON[p.provider] + '"></i> Connect ' + esc(p.label) + "</a>";
            }).join("")
          + "</div>";
      } else {
        html += '<div style="line-height:1.5;">No issue tracker is set up on this server. '
          + '<a href="/settings/integrations" style="color:var(--primary-color);text-decoration:none;">See what&#39;s needed</a>.</div>';
      }
    }

    body.innerHTML = html;
  }

  function linkedRow(p) {
    var l = p.link;
    var mine = state.tickets.filter(function (t) { return t.provider === p.provider; });
    var errs = mine.filter(function (t) { return t.error; }).length;
    var h = '<div data-prov="' + p.provider + '" style="border:1px solid var(--border-color);border-radius:8px;padding:0.7rem 0.8rem;margin-bottom:0.6rem;">'
      + '<div style="display:flex;align-items:center;gap:0.5rem;min-width:0;">'
      + '<i class="' + ICON[p.provider] + '" style="color:' + COLOR[p.provider] + ';"></i>'
      + (l.remoteUrl
          ? '<a href="' + esc(l.remoteUrl) + '" target="_blank" style="color:var(--text-color);font-weight:600;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(l.remoteName || l.remoteKey || p.label) + "</a>"
          : '<span style="color:var(--text-color);font-weight:600;">' + esc(l.remoteName || p.label) + "</span>")
      + (l.syncEnabled ? "" : '<span style="font-size:0.7rem;color:#f59e0b;">paused</span>')
      + "</div>";

    h += '<div style="margin-top:0.35rem;font-size:0.78rem;color:var(--text-secondary);">'
      + mine.length + " ticket" + (mine.length === 1 ? "" : "s") + " linked &middot; synced " + esc(ago(l.lastSyncedAt))
      + (errs ? ' &middot; <span style="color:#f87171;">' + errs + " need attention</span>" : "")
      + "</div>";

    if (l.lastSyncSummary) {
      h += '<div style="margin-top:0.2rem;font-size:0.75rem;color:var(--text-secondary);opacity:0.85;">' + esc(l.lastSyncSummary) + "</div>";
    }

    if (canManage) {
      h += '<div style="display:flex;gap:0.6rem;margin-top:0.55rem;flex-wrap:wrap;">'
        + '<button class="home-team-action" data-act="sync" data-prov="' + p.provider + '"><i class="fas fa-rotate"></i> Sync now</button>'
        + '<button class="home-team-action" data-act="mapping" data-prov="' + p.provider + '"><i class="fas fa-right-left"></i> Columns</button>'
        + '<button class="home-team-action" data-act="pause" data-prov="' + p.provider + '">' + (l.syncEnabled ? '<i class="fas fa-pause"></i> Pause' : '<i class="fas fa-play"></i> Resume') + "</button>"
        + '<button class="home-team-action" data-act="unlink" data-prov="' + p.provider + '" style="color:#f87171;"><i class="fas fa-link-slash"></i> Unlink</button>'
        + "</div>";
    }
    h += '<div data-mapping="' + p.provider + '"></div>';
    return h + "</div>";
  }

  function pickerRow(p) {
    if (!canManage) return "";
    return '<div style="border:1px dashed var(--border-color);border-radius:8px;padding:0.7rem 0.8rem;margin-bottom:0.6rem;">'
      + '<div style="display:flex;align-items:center;gap:0.5rem;">'
      + '<i class="' + ICON[p.provider] + '" style="color:' + COLOR[p.provider] + ';"></i>'
      + '<span style="color:var(--text-color);font-weight:600;">' + esc(p.label) + "</span>"
      + '<span style="font-size:0.75rem;color:var(--text-secondary);">' + esc(p.account && p.account.name ? p.account.name : "connected") + "</span>"
      + "</div>"
      + '<div data-picker="' + p.provider + '" style="margin-top:0.5rem;">'
      + '<button class="home-team-action" data-act="choose" data-prov="' + p.provider + '"><i class="fas fa-link"></i> Link a board</button>'
      + "</div></div>";
  }

  // ── Actions ────────────────────────────────────────────────────────────────
  function chooseBoard(prov, host) {
    host.innerHTML = '<span style="font-size:0.78rem;color:var(--text-secondary);">Loading boards…</span>';
    api("/" + prov + "/remote").then(function (r) { return r.json(); }).then(function (j) {
      if (j.error) { host.innerHTML = '<span style="color:#f87171;font-size:0.78rem;">' + esc(j.error) + "</span>"; return; }
      if (!j.boards || !j.boards.length) {
        host.innerHTML = '<span style="font-size:0.78rem;color:var(--text-secondary);">No boards on that account.</span>';
        return;
      }
      var opts = j.boards.map(function (b) {
        return '<option value="' + esc(b.id) + '">' + esc((b.key ? b.key + " — " : "") + b.name) + "</option>";
      }).join("");
      host.innerHTML = '<select data-board="' + prov + '" class="input" style="width:100%;font-size:0.8rem;padding:0.35rem;">' + opts + "</select>"
        + '<div style="display:flex;gap:0.6rem;margin-top:0.5rem;">'
        + '<button class="home-team-action" data-act="link" data-prov="' + prov + '"><i class="fas fa-check"></i> Link</button>'
        + '<button class="home-team-action" data-act="cancel" data-prov="' + prov + '">Cancel</button></div>';
      host.__boards = j.boards;
    }).catch(function (e) {
      host.innerHTML = '<span style="color:#f87171;font-size:0.78rem;">' + esc(e.message) + "</span>";
    });
  }

  function doLink(prov) {
    var host = document.querySelector('[data-picker="' + prov + '"]');
    var sel = host && host.querySelector('[data-board="' + prov + '"]');
    if (!sel) return;
    var board = (host.__boards || []).filter(function (b) { return b.id === sel.value; })[0] || { id: sel.value };
    host.innerHTML = '<span style="font-size:0.78rem;color:var(--text-secondary);">Linking…</span>';
    api("/" + prov + "/link", {
      method: "POST",
      body: JSON.stringify({
        remoteId: board.id, remoteKey: board.key || null, remoteName: board.name || null,
        remoteUrl: board.url || null,
        issueTypeId: (board.issueTypes && board.issueTypes[0]) ? board.issueTypes[0].id : null,
        issueTypeName: (board.issueTypes && board.issueTypes[0]) ? board.issueTypes[0].name : null,
      }),
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.error) { host.innerHTML = '<span style="color:#f87171;font-size:0.78rem;">' + esc(j.error) + "</span>"; return; }
      load();
    });
  }

  function doSync(prov, btn) {
    var original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-rotate fa-spin"></i> Syncing…';
    api("/" + prov + "/sync", { method: "POST" }).then(function (r) { return r.json(); }).then(function (j) {
      btn.disabled = false;
      btn.innerHTML = original;
      if (j.error) { alert("Sync failed: " + j.error); return; }
      // Errors inside a partly-successful sync must not vanish behind a green summary.
      if (j.summary && j.summary.errors && j.summary.errors.length) {
        alert(j.message + "\n\n" + j.summary.errors.join("\n"));
      }
      load();
    }).catch(function (e) {
      btn.disabled = false; btn.innerHTML = original;
      alert("Sync failed: " + e.message);
    });
  }

  function toggleMapping(prov) {
    var host = document.querySelector('[data-mapping="' + prov + '"]');
    if (!host) return;
    if (openMapping === prov) { host.innerHTML = ""; openMapping = null; return; }
    openMapping = prov;
    host.innerHTML = '<div style="font-size:0.78rem;color:var(--text-secondary);margin-top:0.5rem;">Loading columns…</div>';
    api("/" + prov + "/mapping").then(function (r) { return r.json(); }).then(function (j) {
      if (j.error) { host.innerHTML = '<div style="color:#f87171;font-size:0.78rem;margin-top:0.5rem;">' + esc(j.error) + "</div>"; return; }
      var rows = j.stages.map(function (st) {
        var picked = (j.map && j.map.toRemote) ? j.map.toRemote[st.id] : "";
        var opts = ['<option value="">— not synced —</option>'].concat(j.statuses.map(function (s) {
          return '<option value="' + esc(s.id) + '"' + (s.id === picked ? " selected" : "") + ">" + esc(s.name) + "</option>";
        })).join("");
        return '<div style="display:flex;align-items:center;gap:0.4rem;margin-top:0.35rem;">'
          + '<span style="flex:0 0 40%;font-size:0.78rem;color:var(--text-color);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(st.name) + "</span>"
          + '<i class="fas fa-arrow-right" style="font-size:0.65rem;color:var(--text-secondary);"></i>'
          + '<select data-stage="' + esc(st.id) + '" class="input" style="flex:1;font-size:0.75rem;padding:0.2rem;">' + opts + "</select>"
          + "</div>";
      }).join("");
      host.innerHTML = '<div style="margin-top:0.6rem;border-top:1px solid var(--border-color);padding-top:0.5rem;">'
        + '<div style="font-size:0.72rem;color:var(--text-secondary);">Which board column each LFG stage maps to. Guessed by name — correct anything wrong.</div>'
        + rows
        + '<div style="margin-top:0.5rem;"><button class="home-team-action" data-act="savemap" data-prov="' + prov + '"><i class="fas fa-check"></i> Save columns</button></div>'
        + "</div>";
    });
  }

  function saveMapping(prov, btn) {
    var host = document.querySelector('[data-mapping="' + prov + '"]');
    if (!host) return;
    var toRemote = {};
    host.querySelectorAll("[data-stage]").forEach(function (sel) {
      if (sel.value) toRemote[sel.getAttribute("data-stage")] = sel.value;
    });
    btn.disabled = true;
    api("/" + prov + "/mapping", { method: "PUT", body: JSON.stringify({ toRemote: toRemote }) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        btn.disabled = false;
        if (j.error) { alert(j.error); return; }
        host.innerHTML = "";
        openMapping = null;
      });
  }

  document.addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest("[data-act]") : null;
    if (!b || !body.contains(b)) return;
    var act = b.getAttribute("data-act");
    var prov = b.getAttribute("data-prov");
    e.preventDefault();

    if (act === "choose") chooseBoard(prov, document.querySelector('[data-picker="' + prov + '"]'));
    else if (act === "cancel") render();
    else if (act === "link") doLink(prov);
    else if (act === "sync") doSync(prov, b);
    else if (act === "mapping") toggleMapping(prov);
    else if (act === "savemap") saveMapping(prov, b);
    else if (act === "pause") {
      var p = state.providers.filter(function (x) { return x.provider === prov; })[0];
      var next = !(p && p.link && p.link.syncEnabled);
      api("/" + prov + "/pause", { method: "POST", body: JSON.stringify({ enabled: next }) }).then(load);
    } else if (act === "unlink") {
      if (!confirm("Unlink this board?\n\nTickets and issues both stay exactly as they are — only the pairing between them is forgotten. Re-linking later will match nothing and create duplicates, so unlink only if you mean it.")) return;
      api("/" + prov + "/unlink", { method: "POST" }).then(load);
    }
  });

  load();
})();
