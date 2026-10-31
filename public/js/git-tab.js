/**
 * Git tab — the project's branches on GitHub inside the chat artifacts panel.
 *
 * Branches are grouped the way the work is: each epic with its integration branch and
 * its tickets' branches (measured against the epic branch they merge into), then
 * General for everything else (measured against the default branch). Shown as a list
 * or as a branch map (main → epic → tickets).
 *
 * Actions: open a pull request (an AI review of the diff runs first, and the PR is
 * only opened after the user has read it), merge (through the PR, or straight into a
 * base), delete, and clean up every merged branch at once.
 *
 * Loads lazily the first time the pane becomes active.
 */
(function () {
  let projectId = null;
  let data = null;
  let loaded = false;
  let loading = false;
  let busy = false;
  let view = "list";      // list | map
  let filter = "all";     // all | unmerged | merged | pulls
  let query = "";
  let open = null;        // the row's inline form: { name, kind: "pr" | "merge" | "delete", ...pr review state }
  let cleanup = false;    // confirming "delete all merged"
  let poll = null;        // pre-PR review poller
  const collapsed = new Set();

  try { view = localStorage.getItem("gitTabView") === "map" ? "map" : "list"; } catch (e) { /* storage blocked */ }

  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function api(path, opts) {
    return fetch("/api/projects/" + projectId + "/git" + path, {
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      ...opts,
    }).then(async (r) => {
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((body && body.error) || "Request failed (HTTP " + r.status + ")");
      return body;
    });
  }

  function msg(text, ok) {
    const el = $("git-msg");
    if (!el) return;
    if (!text) { el.hidden = true; el.textContent = ""; return; }
    el.hidden = false;
    el.textContent = text;
    el.classList.toggle("ok", !!ok);
  }

  function ago(iso) {
    const t = Date.parse(iso || "");
    if (!t) return "";
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    if (s < 86400 * 60) return Math.round(s / 86400) + "d ago";
    return Math.round(s / (86400 * 30)) + "mo ago";
  }
  const stale = (b) => !b.merged && b.lastCommit && Date.parse(b.lastCommit.date) < Date.now() - 30 * 86400000;
  const openPull = (b) => b.pull && b.pull.state === "open";

  async function load(fresh) {
    if (loading) return;
    loading = true;
    if (!data) $("git-list").innerHTML = '<div class="env-empty">Reading branches from GitHub…</div>';
    try {
      data = await api("/branches" + (fresh ? "?fresh=1" : ""));
      if (data.error) throw new Error(data.error);
      data.epics = data.epics || [];
      render();
    } catch (e) {
      data = null;
      $("git-count").textContent = "Not available";
      $("git-stats").innerHTML = "";
      $("git-list").innerHTML = '<div class="env-empty">' + esc(e.message) + "</div>";
    } finally {
      loading = false;
      loaded = true;
    }
  }

  function matches(b) {
    const q = query.trim().toLowerCase();
    if (q && !(b.name.toLowerCase().includes(q) || (b.ticket && ((b.ticket.key || "") + " " + b.ticket.name).toLowerCase().includes(q)))) return false;
    if (filter === "unmerged") return !b.merged;
    if (filter === "merged") return b.merged;
    if (filter === "pulls") return openPull(b);
    return true;
  }

  /* Groups: one per epic (its branch first, then its tickets), then General. */
  function groups() {
    const rows = data.branches.filter((b) => !b.isDefault);
    const out = [];
    const order = { building: 0, in_review: 1, approved: 2, draft: 3, merged: 4, rejected: 5 };
    const epics = data.epics.slice().sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3) || String(a.key).localeCompare(String(b.key)));
    for (const e of epics) {
      const epicRow = rows.find((b) => b.kind === "epic" && b.epicId === e.id) || null;
      const tickets = rows.filter((b) => b.kind === "ticket" && b.epicId === e.id).sort(byName);
      out.push({ id: "epic:" + e.id, epic: e, epicRow, tickets });
    }
    const known = (b) => data.epics.some((e) => e.id === b.epicId);
    const general = rows.filter((b) => b.kind === "general" || ((b.kind === "ticket" || b.kind === "epic") && !known(b)));
    if (general.length) out.push({ id: "general", general: general.sort(byName) });
    return out;
  }
  const byName = (a, b) => ((a.ticket && a.ticket.key) || a.name).localeCompare((b.ticket && b.ticket.key) || b.name, undefined, { numeric: true });

  function render() {
    if (!data) return;
    const c = data.counts;
    $("git-count").innerHTML =
      '<a href="' + esc(data.repoUrl) + '" target="_blank" rel="noopener">' + esc(data.repo) + "</a> · default <code>" + esc(data.defaultBranch) + "</code>" +
      (data.epics.length ? " · " + data.epics.length + " epic" + (data.epics.length === 1 ? "" : "s") : "");
    const tile = (key, n, label, cls) =>
      '<button class="git-stat ' + (cls || "") + (filter === key ? " on" : "") + '" data-filter="' + key + '"><b>' + n + "</b><span>" + label + "</span></button>";
    $("git-stats").innerHTML =
      tile("all", data.total, "Branches") +
      tile("unmerged", c.unmerged, "Not merged", "is-open") +
      tile("merged", c.merged, "Merged", "is-merged") +
      tile("pulls", c.openPulls, "Open PRs", "is-pr") +
      (c.unmerged + c.merged ? '<div class="git-ratio" title="' + c.merged + " of " + (c.unmerged + c.merged) + ' merged"><i style="width:' +
        Math.round((c.merged / (c.unmerged + c.merged)) * 100) + '%"></i></div>' : "");
    const deletable = mergedDeletable();
    const cleanBtn = $("git-cleanup");
    cleanBtn.hidden = !data.canEdit || !deletable.length;
    cleanBtn.innerHTML = '<i class="fas fa-broom"></i> Clean up merged (' + deletable.length + ")";
    $("git-cleanup-confirm").hidden = !cleanup;
    if (cleanup) {
      $("git-cleanup-confirm").innerHTML =
        "<span>Delete " + deletable.length + " merged branch" + (deletable.length === 1 ? "" : "es") +
        " on GitHub? Each one's work is already in the branch it merges into (or in a merged PR). Epic branches are kept.</span>" +
        '<button class="env-mini" data-act="cleanup-cancel">Cancel</button><button class="env-mini env-mini-danger-solid" data-act="cleanup-go"' + (busy ? " disabled" : "") + ">Delete all</button>";
    }
    document.querySelectorAll("#gitflow .git-view button").forEach((b) => b.classList.toggle("on", b.getAttribute("data-view") === view));
    const list = $("git-list");
    const keep = list.scrollTop;
    list.innerHTML = view === "map" ? mapView() : listView();
    list.scrollTop = keep;
  }

  const mergedDeletable = () => (data ? data.branches.filter((b) => b.merged && !b.isDefault && !b.protected && !openPull(b) && b.kind !== "epic") : []);

  /* ── List ─────────────────────────────────────────────────────────────── */
  function groupHead(id, shut, inner) {
    return '<button class="git-group-head" data-act="toggle" data-group="' + esc(id) + '" aria-expanded="' + !shut + '">' +
      '<i class="fas fa-chevron-' + (shut ? "right" : "down") + ' git-caret"></i>' + inner + "</button>";
  }

  function listView() {
    const trunk = data.branches.find((b) => b.isDefault);
    let h = filter === "all" && !query.trim() && trunk ? '<div class="git-trunk">' + row(trunk) + "</div>" : "";
    let any = false;
    for (const g of groups()) {
      const shut = collapsed.has(g.id);
      if (g.epic) {
        if (![g.epicRow, ...g.tickets].some((b) => b && matches(b))) continue;
        any = true;
        const merged = g.tickets.filter((t) => t.merged).length;
        h += '<section class="git-group is-epic">' + groupHead(g.id, shut,
          '<span class="git-kind">Epic</span>' + (g.epic.key ? '<span class="git-group-key">' + esc(g.epic.key) + "</span>" : "") +
          '<span class="git-group-name">' + esc(g.epic.name) + "</span>" +
          '<span class="git-epic-status is-' + esc(g.epic.status) + '">' + esc(String(g.epic.status).replace(/_/g, " ")) + "</span>" +
          '<span class="git-group-meta">' + (g.tickets.length ? merged + " of " + g.tickets.length + " ticket" + (g.tickets.length === 1 ? "" : "s") + " merged into the epic" : "no ticket branches") +
            (g.epicRow ? " · epic " + (g.epicRow.merged ? "merged into " : "not yet in ") + esc(g.epicRow.base) : "") + "</span>");
        if (!shut) {
          if (g.epicRow && matches(g.epicRow)) h += '<div class="git-sub">Epic branch <span>· merges into ' + esc(g.epicRow.base) + "</span></div>" + row(g.epicRow);
          const tickets = g.tickets.filter(matches);
          if (tickets.length) h += '<div class="git-sub">Ticket branches <span>· merge into ' + esc(g.epic.branch || data.defaultBranch) + "</span></div>" + tickets.map(row).join("");
        }
        h += "</section>";
      } else {
        const rows = g.general.filter(matches);
        if (!rows.length) continue;
        any = true;
        h += '<section class="git-group is-general">' + groupHead("general", shut,
          '<span class="git-kind is-general">General</span><span class="git-group-name">Not tied to an epic</span>' +
          '<span class="git-group-meta">' + rows.length + " branch" + (rows.length === 1 ? "" : "es") + " · compared with " + esc(data.defaultBranch) + "</span>") +
          (shut ? "" : rows.map(row).join("")) + "</section>";
      }
    }
    if (!any && !h) return '<div class="env-empty">No branches match.</div>';
    return h + (data.truncated ? '<div class="env-empty">Showing the first ' + (data.branches.length - 1) + " of " + data.total + " branches.</div>" : "");
  }

  function badges(b) {
    let h = "";
    if (b.isDefault) h += '<span class="git-badge is-default">default</span>';
    if (b.protected) h += '<span class="git-badge"><i class="fas fa-lock"></i> protected</span>';
    if (!b.isDefault) h += b.merged ? '<span class="git-badge is-merged">merged' + (b.kind === "ticket" && b.base !== data.defaultBranch ? " into epic" : "") + "</span>" : '<span class="git-badge is-open">not merged</span>';
    if (b.pull) {
      const cls = b.pull.state === "open" ? (b.pull.draft ? "is-draft" : "is-pr") : b.pull.state === "merged" ? "is-merged" : "";
      h += '<a class="git-badge ' + cls + '" href="' + esc(b.pull.url) + '" target="_blank" rel="noopener" title="' + esc(b.pull.title) + '"><i class="fas fa-code-pull-request"></i> #' +
        b.pull.number + " " + (b.pull.draft && b.pull.state === "open" ? "draft" : b.pull.state) + (b.pull.base && b.pull.base !== b.base ? " → " + esc(b.pull.base) : "") + "</a>";
    }
    if (stale(b)) h += '<span class="git-badge is-stale">stale</span>';
    return h;
  }

  function aheadBehind(b) {
    if (b.isDefault || b.aheadBy == null) return "";
    return '<div class="git-ab" title="' + b.aheadBy + " commit" + (b.aheadBy === 1 ? "" : "s") + " not in " + esc(b.base) + ", " + b.behindBy + " behind it" + '">' +
      '<span class="git-ab-behind">' + b.behindBy + ' <i class="fas fa-arrow-down"></i></span>' +
      '<span class="git-ab-bar"><i class="l" style="width:' + barPct(b.behindBy) + '%"></i><i class="r" style="width:' + barPct(b.aheadBy) + '%"></i></span>' +
      '<span class="git-ab-ahead"><i class="fas fa-arrow-up"></i> ' + b.aheadBy + "</span></div>";
  }
  function barPct(n) { return n ? Math.min(50, 6 + Math.log2(n + 1) * 7) : 0; }

  function row(b) {
    const n = esc(b.name);
    const lc = b.lastCommit;
    const canPr = data.canEdit && !b.isDefault && !b.merged && b.aheadBy > 0 && !openPull(b);
    const canMerge = data.canEdit && !b.isDefault && (openPull(b) || (b.aheadBy > 0 && !b.merged));
    const canDelete = data.canEdit && !b.isDefault && !b.protected;
    let actions = "";
    if (canPr) actions += '<button class="env-mini" data-act="pr" data-name="' + n + '"><i class="fas fa-code-pull-request"></i> Create PR</button>';
    if (canMerge) actions += '<button class="env-mini git-merge" data-act="merge" data-name="' + n + '"><i class="fas fa-code-merge"></i> Merge</button>';
    if (canDelete) actions += '<button class="env-mini env-icon env-mini-danger" data-act="delete" data-name="' + n + '" title="Delete branch" aria-label="Delete branch ' + n + '"><i class="fas fa-trash"></i></button>';
    actions += '<a class="env-mini env-icon" href="' + esc(b.url) + '" target="_blank" rel="noopener" title="Open on GitHub" aria-label="Open ' + n + ' on GitHub"><i class="fab fa-github"></i></a>';
    const title = b.ticket
      ? '<span class="git-ticket">' + (b.ticket.key ? "<b>" + esc(b.ticket.key) + "</b> " : "") + esc(b.ticket.name) + '</span><span class="git-name is-sub">' + n + "</span>"
      : '<span class="git-name">' + n + "</span>";
    return '<div class="git-row' + (b.isDefault ? " is-default" : "") + (b.merged ? " is-merged" : "") + (b.kind === "ticket" ? " is-ticket" : "") + '">' +
      '<div class="git-row-main">' +
        '<div class="git-row-top"><i class="fas fa-code-branch git-icon"></i>' + title + badges(b) + "</div>" +
        (lc ? '<div class="git-commit"><code>' + esc(lc.sha) + "</code> " + esc(lc.message) + (lc.author ? " · <span>" + esc(lc.author) + "</span>" : "") + (lc.date ? " · " + ago(lc.date) : "") + "</div>" : "") +
      "</div>" +
      aheadBehind(b) +
      '<div class="git-actions">' + actions + "</div>" +
      (open && open.name === b.name ? form(b) : "") +
      "</div>";
  }

  function baseOptions(b, selected) {
    return data.branches.filter((x) => x.name !== b.name && (x.isDefault || x.kind === "epic" || !x.merged))
      .map((x) => '<option value="' + esc(x.name) + '"' + (x.name === selected ? " selected" : "") + ">" + esc(x.name) + (x.kind === "epic" ? " (epic)" : "") + "</option>").join("");
  }

  function form(b) {
    const n = esc(b.name);
    const dis = busy ? " disabled" : "";
    if (open.kind === "pr") return prForm(b);
    if (open.kind === "merge") {
      if (openPull(b)) {
        return '<div class="git-form"><div class="git-form-text">Merge pull request <a href="' + esc(b.pull.url) + '" target="_blank" rel="noopener">#' + b.pull.number + "</a> into <code>" + esc(b.pull.base) + "</code>.</div>" +
          '<div class="git-form-actions"><select class="env-input git-method" id="git-merge-method"><option value="merge">Merge commit</option><option value="squash">Squash and merge</option><option value="rebase">Rebase and merge</option></select>' +
          '<button class="env-mini" data-act="cancel">Cancel</button><button class="env-mini env-mini-primary" data-act="merge-go" data-name="' + n + '"' + dis + ">Merge PR</button></div></div>";
      }
      return '<div class="git-form"><div class="git-form-text">No pull request yet. Merge <code>' + n + "</code> straight into a branch (no review), or create a reviewed PR instead.</div>" +
        '<div class="git-form-actions"><label class="git-inline">into <select class="env-input" id="git-merge-base">' + baseOptions(b, b.base) + "</select></label>" +
        '<button class="env-mini" data-act="cancel">Cancel</button><button class="env-mini" data-act="pr" data-name="' + n + '">Create PR instead</button>' +
        '<button class="env-mini env-mini-primary" data-act="merge-go" data-name="' + n + '"' + dis + ">Merge now</button></div></div>";
    }
    return '<div class="git-form git-form-danger"><div class="git-form-text">' +
      (b.merged ? "Delete <code>" + n + "</code> on GitHub? Its work is already merged." : "<b>" + n + " has " + b.aheadBy + " commit" + (b.aheadBy === 1 ? "" : "s") + " that aren't merged.</b> Deleting it on GitHub may lose that work.") +
      '</div><div class="git-form-actions"><button class="env-mini" data-act="cancel">Cancel</button><button class="env-mini env-mini-danger-solid" data-act="delete-go" data-name="' + n + '"' + dis + ">Delete branch</button></div></div>";
  }

  /* Create PR: pick a base → AI review of the diff → read it, edit title/description → create. */
  function prForm(b) {
    const n = esc(b.name);
    const dis = busy ? " disabled" : "";
    if (open.stage === "setup") {
      return '<div class="git-form"><div class="git-form-text"><i class="fas fa-magnifying-glass git-review-icon"></i> A detailed AI review of this branch runs first: bugs, security, error handling, tests' +
        (b.ticket ? ", and whether " + esc(b.ticket.key || "the ticket") + "'s acceptance criteria are met" : "") + ". Nothing is opened on GitHub until you've read it and confirm.</div>" +
        '<div class="git-form-actions"><label class="git-inline">into <select class="env-input" id="git-pr-base">' + baseOptions(b, open.base) + "</select></label>" +
        '<button class="env-mini" data-act="cancel">Cancel</button><button class="env-mini env-mini-primary" data-act="review-go" data-name="' + n + '"><i class="fas fa-wand-magic-sparkles"></i> Review changes</button></div></div>';
    }
    if (open.stage === "reviewing") {
      const secs = Math.round((Date.now() - open.startedAt) / 1000);
      return '<div class="git-form"><div class="git-reviewing"><span class="git-spinner"></span><div><b>Reviewing ' + n + " → " + esc(open.base) + '</b><span id="git-review-progress">' + esc(open.message || "Starting…") + " · " + secs + "s</span></div></div>" +
        '<div class="git-form-actions"><span class="git-form-hint">Detailed reviews usually take one to three minutes.</span><button class="env-mini" data-act="cancel">Cancel</button></div></div>';
    }
    if (open.stage === "error") {
      return '<div class="git-form git-form-danger"><div class="git-form-text"><b>The review didn’t finish.</b> ' + esc(open.error) + "</div>" +
        '<div class="git-form-actions"><button class="env-mini" data-act="cancel">Cancel</button><button class="env-mini" data-act="review-skip" data-name="' + n + '">Create without review</button>' +
        '<button class="env-mini env-mini-primary" data-act="review-go" data-name="' + n + '">Try again</button></div></div>';
    }
    const r = open.review;
    let h = '<div class="git-form git-review">';
    if (r) {
      const verdict = { ready: ["is-ready", "fa-circle-check", "Ready for a pull request"], needs_changes: ["is-changes", "fa-triangle-exclamation", "Needs changes"], blocked: ["is-blocked", "fa-circle-xmark", "Blocking problems found"] }[r.verdict];
      const sev = { blocker: 0, major: 0, minor: 0, nit: 0 };
      r.findings.forEach((f) => { sev[f.severity] = (sev[f.severity] || 0) + 1; });
      h += '<div class="git-verdict ' + verdict[0] + '"><i class="fas ' + verdict[1] + '"></i><div><b>' + verdict[2] + "</b><span>" +
        r.stats.commits + " commit" + (r.stats.commits === 1 ? "" : "s") + " · " + r.stats.files + " file" + (r.stats.files === 1 ? "" : "s") + " · +" + r.stats.added + " −" + r.stats.removed +
        ' · <a href="' + esc(r.compareUrl) + '" target="_blank" rel="noopener">diff on GitHub</a></span></div>' +
        '<div class="git-sev">' + ["blocker", "major", "minor", "nit"].filter((k) => sev[k]).map((k) => '<span class="git-sev-' + k + '">' + sev[k] + " " + k + (sev[k] === 1 || k === "major" || k === "minor" ? "" : "s") + "</span>").join("") + "</div></div>" +
        '<p class="git-review-summary">' + esc(r.summary) + "</p>";
      if (r.findings.length) {
        h += '<ol class="git-findings">' + r.findings.map((f) =>
          '<li class="git-finding is-' + esc(f.severity) + '"><div class="git-finding-head"><span class="git-sev-chip">' + esc(f.severity) + "</span><b>" + esc(f.title) + "</b>" +
            (f.file ? '<code class="git-finding-loc">' + esc(f.file) + (f.line ? ":" + f.line : "") + "</code>" : "") + "</div>" +
            '<div class="git-finding-detail">' + esc(f.detail) + "</div></li>").join("") + "</ol>";
      } else {
        h += '<div class="git-form-text git-nofindings"><i class="fas fa-check"></i> No problems found.</div>';
      }
      if (r.checked && r.checked.length) h += '<details class="git-checked"><summary>What the review verified (' + r.checked.length + ")</summary><ul>" + r.checked.map((c) => "<li>" + esc(c) + "</li>").join("") + "</ul></details>";
    } else {
      h += '<div class="git-form-text">Creating without a review.</div>';
    }
    const blocked = r && r.verdict === "blocked";
    h += '<div class="git-pr-fields"><label>Title<input class="env-input" id="git-pr-title" value="' + esc(open.title) + '" /></label>' +
      "<label>Description <span>" + (r ? "(drafted from the review; edit freely)" : "") + '</span><textarea class="env-input" id="git-pr-body" rows="7">' + esc(open.body) + "</textarea></label></div>" +
      '<div class="git-form-actions"><label class="git-inline"><input type="checkbox" id="git-pr-draft"' + (open.draft ? " checked" : "") + " /> Open as draft</label>" +
      '<span class="git-form-hint">into <code>' + esc(open.base) + "</code></span>" +
      '<button class="env-mini" data-act="cancel">Cancel</button>' +
      (r ? '<button class="env-mini" data-act="review-go" data-name="' + n + '"><i class="fas fa-rotate-right"></i> Re-run review</button>' : "") +
      '<button class="env-mini ' + (blocked ? "env-mini-danger-solid" : "env-mini-primary") + '" data-act="pr-go" data-name="' + n + '"' + dis + ">" + (blocked ? "Create anyway" : "Create pull request") + "</button></div></div>";
    return h;
  }

  function startReview(b) {
    const base = $("git-pr-base") ? $("git-pr-base").value : open.base;
    stopPoll();
    const mine = { name: b.name, kind: "pr", stage: "reviewing", base, startedAt: Date.now(), message: "Starting…" };
    open = mine;
    msg(""); render();
    api("/review", { method: "POST", body: JSON.stringify({ head: b.name, base }) }).then((r) => {
      if (open !== mine) return;
      poll = setInterval(async () => {
        if (open !== mine) return stopPoll();
        try {
          const s = await api("/review/" + r.id);
          if (open !== mine) return;
          if (s.done) {
            stopPoll();
            open = { ...mine, stage: "reviewed", review: s.review, title: s.review.title, body: s.review.body, draft: s.review.verdict !== "ready" };
            render();
          } else {
            mine.message = s.message;
            const el = $("git-review-progress");
            if (el) el.textContent = s.message + " · " + Math.round((Date.now() - mine.startedAt) / 1000) + "s";
          }
        } catch (e) { stopPoll(); if (open === mine) { open = { ...mine, stage: "error", error: e.message }; render(); } }
      }, 2000);
    }).catch((e) => { if (open === mine) { open = { ...mine, stage: "error", error: e.message }; render(); } });
  }
  function stopPoll() { if (poll) { clearInterval(poll); poll = null; } }

  /* ── Map: one small map per group. Each starts from the default branch; an epic's
     branch splits off it and the epic's tickets split off the epic branch. ───── */
  function mapView() {
    const sections = [];
    for (const g of groups()) {
      if (g.epic) {
        const kids = g.tickets.filter(matches).sort((a, b) => (a.behindBy || 0) - (b.behindBy || 0));
        if (!kids.length && !(g.epicRow && matches(g.epicRow))) continue;
        const lanes = [];
        if (g.epicRow) lanes.push({ b: g.epicRow, parent: g.epicRow.base });
        kids.forEach((b) => lanes.push({ b, parent: g.epicRow ? g.epicRow.name : data.defaultBranch, ticket: true }));
        sections.push({ g, lanes });
      } else {
        const rows = g.general.filter(matches).sort((a, b) => (a.behindBy || 0) - (b.behindBy || 0));
        if (rows.length) sections.push({ g, lanes: rows.map((b) => ({ b, parent: b.base })) });
      }
    }
    if (!sections.length) return '<div class="env-empty">No branches match.</div>';
    // One horizontal scale for every section, so "further left = further behind" compares across them.
    const maxBehind = Math.max(1, ...sections.flatMap((x) => x.lanes.map((l) => l.b.behindBy || 0)));
    const legend = '<div class="git-map-legend"><span class="is-epic">epic branch</span><span class="is-open">not merged</span><span class="is-pr">open PR</span><span class="is-merged">merged</span><span class="is-stale">stale 30d+</span>' +
      '<span class="git-map-hint">Each branch splits off the branch it merges into: epics off ' + esc(data.defaultBranch) + ", tickets off their epic. Further left = further behind. Dots = commits not merged yet.</span></div>";
    return '<div class="git-map-wrap">' + legend + sections.map((x) => {
      const g = x.g;
      const head = g.epic
        ? '<span class="git-kind">Epic</span>' + (g.epic.key ? '<span class="git-group-key">' + esc(g.epic.key) + "</span>" : "") + '<span class="git-group-name">' + esc(g.epic.name) + '</span><span class="git-epic-status is-' + esc(g.epic.status) + '">' + esc(String(g.epic.status).replace(/_/g, " ")) + "</span>"
        : '<span class="git-kind is-general">General</span><span class="git-group-name">Not tied to an epic</span>';
      return '<section class="git-map-section ' + (g.epic ? "is-epic" : "is-general") + '"><div class="git-map-head">' + head + "</div>" + mapSvg(x.lanes, maxBehind) + "</section>";
    }).join("") + "</div>";
  }

  function mapSvg(lanes, maxBehind) {
    const W = 760, LABEL = 230, TRUNK_Y = 18, LANE = 30;
    const right = W - 150, left = LABEL - 6;
    const pos = (behind) => right - 50 - (Math.log2((behind || 0) + 1) / Math.log2(maxBehind + 1)) * (right - 50 - left - 20);
    const laneY = { [data.defaultBranch]: TRUNK_Y };
    const laneFork = { [data.defaultBranch]: left };
    let y = TRUNK_Y, body = "";
    for (const l of lanes) {
      const b = l.b;
      y += LANE;
      const py = laneY[l.parent] != null ? laneY[l.parent] : TRUNK_Y;
      const minX = (laneFork[l.parent] != null ? laneFork[l.parent] : left) + 22;
      const fx = Math.min(right - 60, Math.max(minX, pos(b.behindBy)));
      const ahead = b.aheadBy || 0, dots = Math.min(ahead, 12);
      const step = Math.min(13, Math.max(6, (right - 24 - fx - 24) / Math.max(1, dots)));
      const endX = fx + 24 + Math.max(0, dots - 1) * step;
      const kind = b.merged ? "merged" : openPull(b) ? "pr" : stale(b) ? "stale" : b.kind === "epic" ? "epic" : "open";
      laneY[b.name] = y; laneFork[b.name] = fx;
      let s = '<g class="git-map-lane is-' + kind + (l.ticket ? " is-ticket" : "") + '"><title>' + esc(b.name) + " — " + ahead + " not in " + esc(b.base) + ", " + (b.behindBy || 0) + " behind" + (b.pull ? " · PR #" + b.pull.number + " " + b.pull.state : "") + "</title>";
      s += '<line x1="' + left + '" y1="' + y + '" x2="' + right + '" y2="' + y + '" class="git-map-guide"/>';
      // An epic branch is the line its tickets split off, so it runs the full width.
      if (b.kind === "epic") s += '<line x1="' + (fx + 20) + '" y1="' + y + '" x2="' + right + '" y2="' + y + '" class="git-map-subtrunk"/>';
      s += '<path d="M' + fx + " " + py + " C " + fx + " " + (y - 6) + ", " + (fx + 6) + " " + y + ", " + (fx + 20) + " " + y + " L " + Math.max(endX, fx + 20) + " " + y + '" class="git-map-edge"/>';
      s += '<circle cx="' + fx + '" cy="' + py + '" r="3" class="git-map-fork"/>';
      for (let d = 0; d < dots; d++) s += '<circle cx="' + (fx + 24 + d * step) + '" cy="' + y + '" r="4" class="git-map-dot"/>';
      if (!dots) s += '<circle cx="' + (fx + 24) + '" cy="' + y + '" r="4" class="git-map-dot"/>';
      if (ahead > 12) s += '<text x="' + (endX + 10) + '" y="' + (y + 4) + '" class="git-map-more">+' + (ahead - 12) + "</text>";
      const tag = b.merged ? "✓ merged" + (b.kind === "ticket" && b.base !== data.defaultBranch ? " into epic" : "") : openPull(b) ? "PR #" + b.pull.number : stale(b) ? "stale" : b.kind === "epic" ? "not in " + b.base + " yet" : "";
      if (tag) s += '<text x="' + (b.kind === "epic" ? right + 12 : (ahead > 12 ? endX + 34 : Math.max(endX, fx + 24) + 12)) + '" y="' + (y + 4) + '" class="git-map-tag">' + esc(tag) + "</text>";
      const name = b.ticket ? (b.ticket.key ? b.ticket.key + " " : "") + b.ticket.name : b.name;
      const label = name.length > 30 ? name.slice(0, 29) + "…" : name;
      s += '<text x="' + (LABEL - 16) + '" y="' + (y + 4) + '" text-anchor="end" class="git-map-label' + (l.ticket ? " is-ticket" : "") + '">' + esc(label) + "</text></g>";
      body += s;
    }
    const H = y + 18;
    return '<svg class="git-map" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Branch map">' +
      '<line x1="' + left + '" y1="' + TRUNK_Y + '" x2="' + right + '" y2="' + TRUNK_Y + '" class="git-map-trunk"/>' +
      '<circle cx="' + right + '" cy="' + TRUNK_Y + '" r="4.5" class="git-map-trunk-tip"/>' +
      '<text x="' + (LABEL - 16) + '" y="' + (TRUNK_Y + 4) + '" text-anchor="end" class="git-map-label is-trunk">' + esc(data.defaultBranch) + "</text>" +
      body + "</svg>";
  }

  /* ── Actions ──────────────────────────────────────────────────────────── */
  async function act(fn, okText) {
    if (busy) return;
    busy = true; render();
    try {
      const r = await fn();
      open = null; cleanup = false;
      msg(typeof okText === "function" ? okText(r) : okText, true);
      busy = false;
      await load(true);
    } catch (e) {
      msg(e.message);
    } finally {
      busy = false; render();
    }
  }

  function onClick(e) {
    const f = e.target.closest("[data-filter]");
    if (f) { filter = f.getAttribute("data-filter"); render(); return; }
    const v = e.target.closest("[data-view]");
    if (v) { view = v.getAttribute("data-view"); try { localStorage.setItem("gitTabView", view); } catch (err) { /* storage blocked */ } render(); return; }
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const a = btn.getAttribute("data-act");
    const name = btn.getAttribute("data-name");
    const b = data && data.branches.find((x) => x.name === name);
    if (a === "toggle") { const g = btn.getAttribute("data-group"); collapsed.has(g) ? collapsed.delete(g) : collapsed.add(g); render(); }
    else if (a === "pr" && b) { stopPoll(); open = open && open.name === name && open.kind === "pr" ? null : { name, kind: "pr", stage: "setup", base: b.base }; msg(""); render(); }
    else if (a === "merge" || a === "delete") { stopPoll(); open = open && open.name === name && open.kind === a ? null : { name, kind: a }; msg(""); render(); }
    else if (a === "cancel") { stopPoll(); open = null; render(); }
    else if (a === "review-go" && b) startReview(b);
    else if (a === "review-skip" && b) { open = { ...open, stage: "reviewed", review: null, title: b.name.replace(/^.*\//, "").replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase()), body: "", draft: true }; render(); }
    else if (a === "pr-go") {
      const body = { head: name, base: open.base, title: $("git-pr-title").value, body: $("git-pr-body").value, draft: $("git-pr-draft").checked };
      act(() => api("/pulls", { method: "POST", body: JSON.stringify(body) }), (r) => "Opened pull request #" + r.pull.number + " for " + name + ".");
    } else if (a === "merge-go" && b) {
      const body = openPull(b) ? { pull: b.pull.number, method: $("git-merge-method").value } : { head: name, base: $("git-merge-base").value };
      act(() => api("/merge", { method: "POST", body: JSON.stringify(body) }), "Merged " + name + ".");
    } else if (a === "delete-go") {
      act(() => api("/branches", { method: "DELETE", body: JSON.stringify({ names: [name] }) }).then(checkDeleted), "Deleted " + name + ".");
    } else if (a === "cleanup-go") {
      const names = mergedDeletable().map((x) => x.name);
      act(() => api("/branches", { method: "DELETE", body: JSON.stringify({ names }) }).then(checkDeleted), "Deleted " + names.length + " merged branch" + (names.length === 1 ? "" : "es") + ".");
    } else if (a === "cleanup-cancel") { cleanup = false; render(); }
  }
  function checkDeleted(r) {
    const failed = (r.results || []).filter((x) => !x.ok);
    if (failed.length) throw new Error(failed.map((x) => x.error).join(" "));
    return r;
  }

  // Keep the PR form's edits across re-renders.
  function onInput(e) {
    if (!open || open.kind !== "pr") return;
    if (e.target.id === "git-pr-title") open.title = e.target.value;
    else if (e.target.id === "git-pr-body") open.body = e.target.value;
    else if (e.target.id === "git-pr-draft") open.draft = e.target.checked;
    else if (e.target.id === "git-pr-base") open.base = e.target.value;
  }

  function ensureLoaded() { if (!loaded) load(); }

  function init() {
    const root = $("git-root");
    if (!root) return;
    projectId = root.getAttribute("data-project-id");
    root.addEventListener("click", onClick);
    root.addEventListener("input", onInput);
    root.addEventListener("change", onInput);
    $("git-refresh")?.addEventListener("click", () => { msg(""); load(true); });
    $("git-cleanup")?.addEventListener("click", () => { cleanup = !cleanup; render(); });
    $("git-search")?.addEventListener("input", (e) => { query = e.target.value; render(); });
    const pane = $("gitflow");
    if (pane) {
      if (pane.classList.contains("active")) ensureLoaded();
      new MutationObserver(() => { if (pane.classList.contains("active")) ensureLoaded(); })
        .observe(pane, { attributes: true, attributeFilter: ["class"] });
    }
    if (window.ResizeObserver) new ResizeObserver(() => root.classList.toggle("is-narrow", root.clientWidth < 620)).observe(root);
  }

  window.GitTab = { load };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
