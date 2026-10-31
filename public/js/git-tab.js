/**
 * Git tab — the project's branches on GitHub inside the chat artifacts panel.
 *
 * Shows every branch against the default branch (ahead / behind, merged or not,
 * latest commit, pull request) as a list or a branch map, and lets the user open a
 * pull request, merge (through the PR, or straight into a base) and delete branches,
 * including a one-click clean-up of everything already merged.
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
  let open = null;        // { name, kind: "pr" | "merge" | "delete" } — the row's inline form
  let cleanup = false;    // confirming "delete all merged"

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

  async function load(fresh) {
    if (loading) return;
    loading = true;
    if (!data) $("git-list").innerHTML = '<div class="env-empty">Reading branches from GitHub…</div>';
    try {
      data = await api("/branches" + (fresh ? "?fresh=1" : ""));
      if (data.error) throw new Error(data.error);
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

  function visible() {
    const q = query.trim().toLowerCase();
    return data.branches.filter((b) => {
      if (b.isDefault) return filter === "all" && !q;
      if (q && !b.name.toLowerCase().includes(q)) return false;
      if (filter === "unmerged") return !b.merged;
      if (filter === "merged") return b.merged;
      if (filter === "pulls") return b.pull && b.pull.state === "open";
      return true;
    });
  }

  function render() {
    if (!data) return;
    const c = data.counts;
    $("git-count").innerHTML =
      '<a href="' + esc(data.repoUrl) + '" target="_blank" rel="noopener">' + esc(data.repo) + "</a> · default <code>" + esc(data.defaultBranch) + "</code>";
    const tile = (key, n, label, cls) =>
      '<button class="git-stat ' + (cls || "") + (filter === key ? " on" : "") + '" data-filter="' + key + '"><b>' + n + "</b><span>" + label + "</span></button>";
    $("git-stats").innerHTML =
      tile("all", data.total, "Branches") +
      tile("unmerged", c.unmerged, "Not merged", "is-open") +
      tile("merged", c.merged, "Merged", "is-merged") +
      tile("pulls", c.openPulls, "Open PRs", "is-pr") +
      (c.unmerged + c.merged ? '<div class="git-ratio" title="' + c.merged + " of " + (c.unmerged + c.merged) + ' merged"><i style="width:' +
        Math.round((c.merged / (c.unmerged + c.merged)) * 100) + '%"></i></div>' : "");
    const cleanBtn = $("git-cleanup");
    cleanBtn.hidden = !data.canEdit || !mergedDeletable().length;
    cleanBtn.innerHTML = '<i class="fas fa-broom"></i> Clean up merged (' + mergedDeletable().length + ")";
    $("git-cleanup-confirm").hidden = !cleanup;
    if (cleanup) {
      $("git-cleanup-confirm").innerHTML =
        "<span>Delete " + mergedDeletable().length + " merged branch" + (mergedDeletable().length === 1 ? "" : "es") +
        " on GitHub? Their work is already in <code>" + esc(data.defaultBranch) + "</code> (or a merged PR).</span>" +
        '<button class="env-mini" data-act="cleanup-cancel">Cancel</button><button class="env-mini env-mini-danger-solid" data-act="cleanup-go"' + (busy ? " disabled" : "") + ">Delete all</button>";
    }
    document.querySelectorAll("#gitflow .git-view button").forEach((b) => b.classList.toggle("on", b.getAttribute("data-view") === view));
    const rows = visible();
    $("git-list").innerHTML = rows.length
      ? (view === "map" ? mapView(rows) : rows.map(row).join("")) + (data.truncated ? '<div class="env-empty">Showing the first ' + (data.branches.length - 1) + " of " + data.total + " branches.</div>" : "")
      : '<div class="env-empty">No branches match.</div>';
  }

  const mergedDeletable = () => (data ? data.branches.filter((b) => b.merged && !b.isDefault && !b.protected && !(b.pull && b.pull.state === "open")) : []);

  function badges(b) {
    let h = "";
    if (b.isDefault) h += '<span class="git-badge is-default">default</span>';
    if (b.protected) h += '<span class="git-badge"><i class="fas fa-lock"></i> protected</span>';
    if (!b.isDefault) h += b.merged ? '<span class="git-badge is-merged">merged</span>' : '<span class="git-badge is-open">not merged</span>';
    if (b.pull) {
      const cls = b.pull.state === "open" ? (b.pull.draft ? "is-draft" : "is-pr") : b.pull.state === "merged" ? "is-merged" : "";
      h += '<a class="git-badge ' + cls + '" href="' + esc(b.pull.url) + '" target="_blank" rel="noopener" title="' + esc(b.pull.title) + '"><i class="fas fa-code-pull-request"></i> #' +
        b.pull.number + " " + (b.pull.draft && b.pull.state === "open" ? "draft" : b.pull.state) + (b.pull.base && b.pull.base !== data.defaultBranch ? " → " + esc(b.pull.base) : "") + "</a>";
    }
    if (stale(b)) h += '<span class="git-badge is-stale">stale</span>';
    return h;
  }

  function aheadBehind(b) {
    if (b.isDefault || b.aheadBy == null) return "";
    return '<div class="git-ab" title="' + b.aheadBy + " ahead, " + b.behindBy + " behind " + esc(data.defaultBranch) + '">' +
      '<span class="git-ab-behind">' + b.behindBy + ' <i class="fas fa-arrow-down"></i></span>' +
      '<span class="git-ab-bar"><i class="l" style="width:' + barPct(b.behindBy) + '%"></i><i class="r" style="width:' + barPct(b.aheadBy) + '%"></i></span>' +
      '<span class="git-ab-ahead"><i class="fas fa-arrow-up"></i> ' + b.aheadBy + "</span></div>";
  }
  function barPct(n) { return n ? Math.min(50, 6 + Math.log2(n + 1) * 7) : 0; }

  function row(b) {
    const n = esc(b.name);
    const lc = b.lastCommit;
    const canPr = data.canEdit && !b.isDefault && !b.merged && b.aheadBy > 0 && !(b.pull && b.pull.state === "open");
    const canMerge = data.canEdit && !b.isDefault && ((b.pull && b.pull.state === "open") || (b.aheadBy > 0 && !b.merged));
    const canDelete = data.canEdit && !b.isDefault && !b.protected;
    let actions = "";
    if (canPr) actions += '<button class="env-mini" data-act="pr" data-name="' + n + '"><i class="fas fa-code-pull-request"></i> Open PR</button>';
    if (canMerge) actions += '<button class="env-mini git-merge" data-act="merge" data-name="' + n + '"><i class="fas fa-code-merge"></i> Merge</button>';
    if (canDelete) actions += '<button class="env-mini env-icon env-mini-danger" data-act="delete" data-name="' + n + '" title="Delete branch" aria-label="Delete branch ' + n + '"><i class="fas fa-trash"></i></button>';
    actions += '<a class="env-mini env-icon" href="' + esc(b.url) + '" target="_blank" rel="noopener" title="Open on GitHub" aria-label="Open ' + n + ' on GitHub"><i class="fab fa-github"></i></a>';
    return '<div class="git-row' + (b.isDefault ? " is-default" : "") + (b.merged ? " is-merged" : "") + '">' +
      '<div class="git-row-main">' +
        '<div class="git-row-top"><i class="fas fa-code-branch git-icon"></i><span class="git-name">' + n + "</span>" + badges(b) + "</div>" +
        (lc ? '<div class="git-commit"><code>' + esc(lc.sha) + "</code> " + esc(lc.message) + (lc.author ? ' · <span>' + esc(lc.author) + "</span>" : "") + (lc.date ? " · " + ago(lc.date) : "") + "</div>" : "") +
      "</div>" +
      aheadBehind(b) +
      '<div class="git-actions">' + actions + "</div>" +
      (open && open.name === b.name ? form(b) : "") +
      "</div>";
  }

  function baseOptions(b, selected) {
    return data.branches.filter((x) => x.name !== b.name && !x.merged)
      .map((x) => '<option value="' + esc(x.name) + '"' + (x.name === selected ? " selected" : "") + ">" + esc(x.name) + "</option>").join("");
  }

  function form(b) {
    const n = esc(b.name);
    const dis = busy ? " disabled" : "";
    if (open.kind === "pr") {
      const title = b.lastCommit && b.aheadBy === 1 ? b.lastCommit.message : b.name.replace(/^.*\//, "").replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());
      return '<div class="git-form">' +
        '<input class="env-input" id="git-pr-title" value="' + esc(title) + '" placeholder="Pull request title" />' +
        '<label class="git-inline">into <select class="env-input" id="git-pr-base">' + baseOptions(b, data.defaultBranch) + "</select></label>" +
        '<textarea class="env-input" id="git-pr-body" rows="2" placeholder="Description (optional)"></textarea>' +
        '<div class="git-form-actions"><label class="git-inline"><input type="checkbox" id="git-pr-draft" /> Draft</label>' +
        '<button class="env-mini" data-act="cancel">Cancel</button><button class="env-mini env-mini-primary" data-act="pr-go" data-name="' + n + '"' + dis + ">Create pull request</button></div></div>";
    }
    if (open.kind === "merge") {
      if (b.pull && b.pull.state === "open") {
        return '<div class="git-form"><div class="git-form-text">Merge pull request <a href="' + esc(b.pull.url) + '" target="_blank" rel="noopener">#' + b.pull.number + "</a> into <code>" + esc(b.pull.base) + "</code>.</div>" +
          '<div class="git-form-actions"><select class="env-input git-method" id="git-merge-method"><option value="merge">Merge commit</option><option value="squash">Squash and merge</option><option value="rebase">Rebase and merge</option></select>' +
          '<button class="env-mini" data-act="cancel">Cancel</button><button class="env-mini env-mini-primary" data-act="merge-go" data-name="' + n + '"' + dis + ">Merge PR</button></div></div>";
      }
      return '<div class="git-form"><div class="git-form-text">No pull request yet. Merge <code>' + n + "</code> straight into a branch (no review), or open a PR instead.</div>" +
        '<div class="git-form-actions"><label class="git-inline">into <select class="env-input" id="git-merge-base">' + baseOptions(b, data.defaultBranch) + "</select></label>" +
        '<button class="env-mini" data-act="cancel">Cancel</button><button class="env-mini" data-act="pr" data-name="' + n + '">Open PR instead</button>' +
        '<button class="env-mini env-mini-primary" data-act="merge-go" data-name="' + n + '"' + dis + ">Merge now</button></div></div>";
    }
    return '<div class="git-form git-form-danger"><div class="git-form-text">' +
      (b.merged ? "Delete <code>" + n + "</code> on GitHub? Its work is already merged." : "<b>" + n + " has " + b.aheadBy + " commit" + (b.aheadBy === 1 ? "" : "s") + " that aren't merged.</b> Deleting it on GitHub may lose that work.") +
      '</div><div class="git-form-actions"><button class="env-mini" data-act="cancel">Cancel</button><button class="env-mini env-mini-danger-solid" data-act="delete-go" data-name="' + n + '"' + dis + ">Delete branch</button></div></div>";
  }

  /* Branch map: the default branch is the trunk; each branch forks off it (further left
     = further behind) and runs its unmerged commits as dots. Lanes are ordered by fork
     point, so no branch's line crosses another's. */
  function mapView(rows) {
    const branches = rows.filter((b) => !b.isDefault).sort((a, b) => (a.behindBy || 0) - (b.behindBy || 0) || a.name.localeCompare(b.name));
    const W = 720, LABEL = 200, TRUNK_Y = 26, LANE = 34, PAD = 18;
    const right = W - 130, span = right - LABEL - 20; // room past the trunk tip for each lane's tag
    const maxBehind = Math.max(1, ...branches.map((b) => b.behindBy || 0));
    const forkX = (b) => right - 60 - (Math.log2((b.behindBy || 0) + 1) / Math.log2(maxBehind + 1)) * (span - 60);
    const H = TRUNK_Y + PAD + branches.length * LANE + 8;
    let s = '<svg class="git-map" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Branch map against ' + esc(data.defaultBranch) + '">';
    s += '<line x1="' + (LABEL - 10) + '" y1="' + TRUNK_Y + '" x2="' + right + '" y2="' + TRUNK_Y + '" class="git-map-trunk"/>';
    s += '<circle cx="' + right + '" cy="' + TRUNK_Y + '" r="5" class="git-map-trunk-tip"/>';
    s += '<text x="' + (LABEL - 18) + '" y="' + (TRUNK_Y + 4) + '" text-anchor="end" class="git-map-label is-trunk">' + esc(data.defaultBranch) + "</text>";
    branches.forEach((b, i) => {
      const y = TRUNK_Y + PAD + 10 + i * LANE;
      const fx = forkX(b);
      const ahead = b.aheadBy || 0;
      const step = Math.min(14, Math.max(6, (right - 30 - fx - 24) / Math.max(1, Math.min(ahead, 12))));
      const kind = b.merged ? "merged" : b.pull && b.pull.state === "open" ? "pr" : stale(b) ? "stale" : "open";
      const dots = Math.min(ahead, 12);
      const endX = fx + 24 + Math.max(0, dots - 1) * step;
      s += '<g class="git-map-lane is-' + kind + '"><title>' + esc(b.name) + " — " + ahead + " ahead, " + (b.behindBy || 0) + " behind" + (b.pull ? " · PR #" + b.pull.number + " " + b.pull.state : "") + "</title>";
      s += '<line x1="' + (LABEL - 10) + '" y1="' + y + '" x2="' + right + '" y2="' + y + '" class="git-map-guide"/>';
      s += '<path d="M' + fx + " " + TRUNK_Y + " C " + fx + " " + (y - 6) + ", " + (fx + 6) + " " + y + ", " + (fx + 20) + " " + y + " L " + endX + " " + y + '" class="git-map-edge"/>';
      s += '<circle cx="' + fx + '" cy="' + TRUNK_Y + '" r="3" class="git-map-fork"/>';
      for (let d = 0; d < dots; d++) s += '<circle cx="' + (fx + 24 + d * step) + '" cy="' + y + '" r="4" class="git-map-dot"/>';
      if (ahead > 12) s += '<text x="' + (endX + 10) + '" y="' + (y + 4) + '" class="git-map-more">+' + (ahead - 12) + "</text>";
      if (b.merged && ahead === 0) s += '<circle cx="' + (fx + 24) + '" cy="' + y + '" r="4" class="git-map-dot"/>';
      const tagX = (ahead > 12 ? endX + 34 : (b.merged && !ahead ? fx + 24 : endX) + 12);
      const tag = b.merged ? "✓ merged" + (b.pull && b.pull.state === "merged" ? " #" + b.pull.number : "") : b.pull && b.pull.state === "open" ? "PR #" + b.pull.number + (b.pull.base !== data.defaultBranch ? " → " + b.pull.base : "") : "";
      if (tag) s += '<text x="' + tagX + '" y="' + (y + 4) + '" class="git-map-tag">' + esc(tag) + "</text>";
      const label = b.name.length > 24 ? b.name.slice(0, 23) + "…" : b.name;
      s += '<text x="' + (LABEL - 18) + '" y="' + (y + 4) + '" text-anchor="end" class="git-map-label">' + esc(label) + "</text>";
      s += "</g>";
    });
    s += "</svg>";
    const legend = '<div class="git-map-legend"><span class="is-open">not merged</span><span class="is-pr">open PR</span><span class="is-merged">merged</span><span class="is-stale">stale 30d+</span><span class="git-map-hint">Fork point further left = further behind ' + esc(data.defaultBranch) + " · dots = unmerged commits</span></div>";
    return '<div class="git-map-wrap">' + legend + s + "</div>";
  }

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
    if (v) { view = v.getAttribute("data-view"); render(); return; }
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const a = btn.getAttribute("data-act");
    const name = btn.getAttribute("data-name");
    const b = data && data.branches.find((x) => x.name === name);
    if (a === "pr" || a === "merge" || a === "delete") { open = open && open.name === name && open.kind === a ? null : { name, kind: a }; msg(""); render(); }
    else if (a === "cancel") { open = null; render(); }
    else if (a === "pr-go") {
      const title = $("git-pr-title").value, base = $("git-pr-base").value;
      act(() => api("/pulls", { method: "POST", body: JSON.stringify({ head: name, base, title, body: $("git-pr-body").value, draft: $("git-pr-draft").checked }) }),
        (r) => "Opened pull request #" + r.pull.number + " for " + name + ".");
    } else if (a === "merge-go" && b) {
      const body = b.pull && b.pull.state === "open" ? { pull: b.pull.number, method: $("git-merge-method").value } : { head: name, base: $("git-merge-base").value };
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

  function ensureLoaded() { if (!loaded) load(); }

  function init() {
    const root = $("git-root");
    if (!root) return;
    projectId = root.getAttribute("data-project-id");
    root.addEventListener("click", onClick);
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
