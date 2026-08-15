/**
 * Env tab — the project's environment variables inside the chat artifacts panel.
 *
 * Values are write-only: /api/projects/:id/env-vars never returns a stored value,
 * so the list can only show WHETHER a key is set (and whether the preview still
 * needs it). Add / set / delete / bulk-import all go through the same endpoints
 * the project page's Environment tab uses.
 *
 * Loads lazily — the first time the Env pane becomes active, whichever way the
 * user got there (tab button, the ⋯ overflow menu, or the preview toolbar's
 * "Env" button).
 */
(function () {
  let projectId = null;
  let loadedOnce = false;
  let vars = [];
  let editingId = null;   // row whose value is being edited
  let confirmingId = null; // row awaiting delete confirmation
  const revealed = new Map(); // id → the plaintext value, once fetched on demand

  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function api(path, opts) {
    return fetch("/api/projects/" + projectId + "/env-vars" + (path || ""), {
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      ...opts,
    }).then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((data && data.error) || "Request failed (HTTP " + r.status + ")");
      return data;
    });
  }

  function msg(text, ok) {
    const el = $("env-msg");
    if (!el) return;
    if (!text) { el.hidden = true; el.textContent = ""; return; }
    el.hidden = false;
    el.textContent = text;
    el.classList.toggle("ok", !!ok);
  }

  // ── Rendering ──────────────────────────────────────────────────────────────
  function valueCell(v) {
    if (editingId === v.id) {
      return '<input class="env-input" data-edit-input type="password" placeholder="new value" autocomplete="new-password" style="width:100%;" />';
    }
    if (!v.hasValue) {
      return '<span class="env-unset">not set</span>' + (v.isRequired ? '<span class="env-badge">needed</span>' : "");
    }
    if (revealed.has(v.id)) {
      return '<span class="env-value">' + esc(revealed.get(v.id)) + "</span>";
    }
    return '<span style="letter-spacing:2px;">••••••••</span>';
  }

  function actionsCell(v) {
    if (editingId === v.id) {
      return '<button class="env-mini env-mini-primary" data-act="save" data-id="' + esc(v.id) + '">Save</button> ' +
        '<button class="env-mini" data-act="cancel">Cancel</button>';
    }
    if (confirmingId === v.id) {
      return '<button class="env-mini env-mini-danger" data-act="delete" data-id="' + esc(v.id) + '">Confirm</button> ' +
        '<button class="env-mini" data-act="cancel">Cancel</button>';
    }
    const shown = revealed.has(v.id);
    // Reveal/copy only make sense once there's something stored to read back.
    const peek = v.hasValue
      ? '<button class="env-mini env-icon" data-act="' + (shown ? "hide" : "reveal") + '" data-id="' + esc(v.id) + '" title="' + (shown ? "Hide value" : "Show value") + '"><i class="fas fa-' + (shown ? "eye-slash" : "eye") + '"></i></button> ' +
        '<button class="env-mini env-icon" data-act="copy" data-id="' + esc(v.id) + '" title="Copy value"><i class="fas fa-copy"></i></button> '
      : "";
    return peek +
      '<button class="env-mini" data-act="edit" data-id="' + esc(v.id) + '">' + (v.hasValue ? "Change" : "Set value") + "</button> " +
      '<button class="env-mini env-mini-danger" data-act="confirm-delete" data-id="' + esc(v.id) + '">Delete</button>';
  }

  function render() {
    const list = $("env-list");
    const count = $("env-count");
    if (!list) return;

    const missing = vars.filter((v) => !v.hasValue).length;
    if (count) {
      count.textContent = vars.length
        ? vars.length + (vars.length === 1 ? " variable" : " variables") + (missing ? " · " + missing + " without a value" : "")
        : "No variables yet";
    }
    updatePreviewBadge();

    if (!vars.length) {
      list.innerHTML =
        '<div class="env-empty">No environment variables yet.<br />Add one above, upload a .env file, or run a preview — it registers the keys the app asks for.</div>';
      return;
    }

    let rows = "";
    for (const v of vars) {
      rows +=
        "<tr>" +
        '<td class="env-key">' + esc(v.key) + "</td>" +
        "<td>" + valueCell(v) + "</td>" +
        '<td class="env-col-desc">' + esc(v.description) + "</td>" +
        '<td class="env-actions">' + actionsCell(v) + "</td>" +
        "</tr>";
    }
    list.innerHTML =
      '<table class="env-table"><thead><tr>' +
      "<th>Key</th><th>Value</th><th class=\"env-col-desc\">Description</th><th></th>" +
      "</tr></thead><tbody>" + rows + "</tbody></table>";

    const input = list.querySelector("[data-edit-input]");
    if (input) input.focus();

    const toggle = $("env-reveal-all");
    if (toggle) {
      const withValue = vars.filter((v) => v.hasValue);
      const allShown = withValue.length > 0 && withValue.every((v) => revealed.has(v.id));
      toggle.disabled = !withValue.length;
      toggle.innerHTML = '<i class="fas fa-' + (allShown ? "eye-slash" : "eye") + '"></i> ' + (allShown ? "Hide values" : "Show values");
    }
  }

  // The preview toolbar's Env button carries the count so you can see at a
  // glance whether the app has anything configured.
  function updatePreviewBadge() {
    const badge = $("preview-env-count");
    if (!badge) return;
    if (!vars.length) { badge.style.display = "none"; return; }
    badge.style.display = "";
    badge.textContent = String(vars.length);
  }

  // ── Data ───────────────────────────────────────────────────────────────────
  async function load() {
    if (!projectId) return;
    try {
      const d = await api("");
      vars = (d && d.envVars) || [];
      render();
    } catch (e) {
      msg(e.message || "Could not load environment variables.");
    }
  }

  async function saveValue(id) {
    const input = $("env-list").querySelector("[data-edit-input]");
    const value = input ? input.value : "";
    if (!value) { msg("Enter a value, or hit Cancel."); return; }
    msg("");
    try {
      await api("/" + id, { method: "PATCH", body: JSON.stringify({ value }) });
      editingId = null;
      revealed.delete(id); // the cached plaintext is now stale
      await load();
    } catch (e) {
      msg(e.message || "Could not save that value.");
    }
  }

  // Values are fetched one at a time (the list response never carries them).
  async function fetchValue(id) {
    if (revealed.has(id)) return revealed.get(id);
    const d = await api("/" + id + "/value");
    revealed.set(id, (d && d.value) || "");
    return revealed.get(id);
  }

  async function reveal(id) {
    msg("");
    try { await fetchValue(id); render(); }
    catch (e) { msg(e.message || "Could not read that value."); }
  }

  async function copyValue(id) {
    msg("");
    try {
      const value = await fetchValue(id);
      await navigator.clipboard.writeText(value);
      msg("Value copied to the clipboard.", true);
    } catch (e) {
      msg(e.message || "Could not copy that value.");
    }
  }

  // Header toggle: reveal every stored value at once, or mask them all again.
  async function toggleRevealAll() {
    const withValue = vars.filter((v) => v.hasValue);
    if (withValue.length && withValue.every((v) => revealed.has(v.id))) {
      revealed.clear();
      render();
      return;
    }
    msg("");
    try {
      await Promise.all(withValue.map((v) => fetchValue(v.id)));
      render();
    } catch (e) {
      msg(e.message || "Could not read the stored values.");
      render();
    }
  }

  async function remove(id) {
    msg("");
    try {
      await api("/" + id, { method: "DELETE" });
      confirmingId = null;
      revealed.delete(id);
      await load();
    } catch (e) {
      msg(e.message || "Could not delete that variable.");
    }
  }

  async function add() {
    const keyEl = $("env-new-key");
    const valEl = $("env-new-value");
    const descEl = $("env-new-desc");
    const key = (keyEl.value || "").trim();
    if (!key) { msg("A key is required."); keyEl.focus(); return; }
    msg("");
    try {
      await api("", {
        method: "POST",
        body: JSON.stringify({ key, value: valEl.value || "", description: descEl.value || "" }),
      });
      keyEl.value = ""; valEl.value = ""; descEl.value = "";
      await load();
    } catch (e) {
      msg(e.message || "Could not add that variable.");
    }
  }

  function importEnvFile(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      msg("");
      try {
        const d = await api("/bulk", { method: "POST", body: JSON.stringify({ text: String(reader.result || "") }) });
        msg("Imported " + (d && d.count != null ? d.count : 0) + " variables.", true);
        await load();
      } catch (e) {
        msg(e.message || "Could not import that file.");
      }
    };
    reader.readAsText(file);
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────
  function open() {
    if (window.switchTab) window.switchTab("env");
    else document.querySelector('.tab-button[data-tab="env"]')?.click();
    ensureLoaded();
  }

  function ensureLoaded() {
    if (loadedOnce) return;
    loadedOnce = true;
    load();
  }

  function init() {
    const root = $("env-root");
    if (!root) return;
    projectId = root.getAttribute("data-project-id");

    $("env-add-btn")?.addEventListener("click", add);
    $("env-reveal-all")?.addEventListener("click", toggleRevealAll);
    $("env-refresh")?.addEventListener("click", () => { msg(""); load(); });
    $("env-file")?.addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) importEnvFile(f);
      e.target.value = "";
    });
    for (const id of ["env-new-key", "env-new-value", "env-new-desc"]) {
      $(id)?.addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
    }

    const list = $("env-list");
    list?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const act = btn.getAttribute("data-act");
      const id = btn.getAttribute("data-id");
      if (act === "edit") { editingId = id; confirmingId = null; msg(""); render(); }
      else if (act === "cancel") { editingId = null; confirmingId = null; msg(""); render(); }
      else if (act === "save") saveValue(id);
      else if (act === "confirm-delete") { confirmingId = id; editingId = null; msg(""); render(); }
      else if (act === "delete") remove(id);
      else if (act === "reveal") reveal(id);
      else if (act === "hide") { revealed.delete(id); render(); }
      else if (act === "copy") copyValue(id);
    });
    list?.addEventListener("keydown", (e) => {
      if (!e.target.hasAttribute?.("data-edit-input")) return;
      if (e.key === "Enter") saveValue(editingId);
      else if (e.key === "Escape") { editingId = null; render(); }
    });

    // Preview toolbar shortcut → jump straight to this tab.
    $("preview-env-btn")?.addEventListener("click", open);

    // Load the first time the pane becomes active, no matter how it got opened.
    const pane = $("env");
    if (pane) {
      if (pane.classList.contains("active")) ensureLoaded();
      new MutationObserver(() => { if (pane.classList.contains("active")) ensureLoaded(); })
        .observe(pane, { attributes: true, attributeFilter: ["class"] });
    }

    // Narrow panel → drop the description column (see .env-panel.is-narrow).
    if (window.ResizeObserver) {
      new ResizeObserver(() => root.classList.toggle("is-narrow", root.clientWidth < 560)).observe(root);
    }
  }

  window.EnvTab = { open, load };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
