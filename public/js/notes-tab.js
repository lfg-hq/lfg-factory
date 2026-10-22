/**
 * Notes tab — the project's notebook in the chat artifacts panel: test logins, URLs,
 * decisions and setup steps the agent (or the user) saved for later.
 *
 * Secrets are never in the list response; each is fetched on demand to reveal or copy.
 * Loads when the pane becomes active and refreshes while it stays open, so a note the
 * agent saves mid-chat appears without a reload.
 */
(function () {
  let projectId = null;
  let notes = [];
  let canEdit = false;
  let editingId = null;     // note id being edited, or "new"
  let confirmingId = null;  // note awaiting delete confirmation
  let signature = "";
  const revealed = new Map(); // id → plaintext secret, once fetched

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const KINDS = { note: ["Note", "fa-note-sticky"], login: ["Login", "fa-key"], decision: ["Decision", "fa-scale-balanced"], link: ["Link", "fa-link"] };

  function api(path, opts) {
    return fetch("/api/projects/" + projectId + "/notes" + (path || ""), {
      headers: { "Content-Type": "application/json" }, credentials: "same-origin", cache: "no-store", ...opts,
    }).then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((data && data.error) || "Request failed (HTTP " + r.status + ")");
      return data;
    });
  }

  function msg(text, ok) {
    const el = $("notes-msg");
    if (!el) return;
    el.hidden = !text; el.textContent = text || ""; el.classList.toggle("ok", !!ok);
  }

  // Small, safe Markdown: escaped text with code, bold, links, bullets and line breaks.
  function md(text) {
    const lines = esc(text).split("\n");
    let html = "", list = false;
    for (const raw of lines) {
      const bullet = raw.match(/^\s*[-*]\s+(.*)$/);
      const line = (bullet ? bullet[1] : raw)
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
        .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
      if (bullet) { if (!list) { html += "<ul>"; list = true; } html += "<li>" + line + "</li>"; continue; }
      if (list) { html += "</ul>"; list = false; }
      html += line.trim() ? "<p>" + line + "</p>" : "";
    }
    return html + (list ? "</ul>" : "");
  }

  function ago(when) {
    const s = Math.max(0, (Date.now() - new Date(when).getTime()) / 1000);
    return s < 60 ? "just now" : s < 3600 ? Math.round(s / 60) + "m ago" : s < 86400 ? Math.round(s / 3600) + "h ago" : Math.round(s / 86400) + "d ago";
  }

  function form(n) {
    const kind = (n && n.kind) || "note";
    return '<form class="note-form" data-form="' + esc(n ? n.id : "new") + '">' +
      '<div class="note-form-row"><input name="title" class="env-input" placeholder="Title, e.g. Preview login: recruiter" value="' + esc(n ? n.title : "") + '" required maxlength="200" />' +
      '<select name="kind" class="env-input">' + Object.keys(KINDS).map((k) => '<option value="' + k + '"' + (k === kind ? " selected" : "") + ">" + KINDS[k][0] + "</option>").join("") + "</select></div>" +
      '<textarea name="body" class="env-input" rows="5" placeholder="Details (Markdown). Keep passwords in the secret field.">' + esc(n ? n.body : "") + "</textarea>" +
      '<input name="secret" class="env-input" type="password" autocomplete="new-password" placeholder="' + (n && n.hasSecret ? "Secret saved · type to replace" : "Secret (optional): password, key or token") + '" />' +
      '<div class="note-form-actions">' + (n && n.hasSecret ? '<label class="note-clear"><input type="checkbox" name="clearSecret" /> Remove saved secret</label>' : "<span></span>") +
      '<span><button type="button" class="env-mini" data-act="cancel">Cancel</button> <button type="submit" class="env-mini env-mini-primary">Save</button></span></div></form>';
  }

  function card(n) {
    if (editingId === n.id) return '<article class="note-card is-editing">' + form(n) + "</article>";
    const [label, icon] = KINDS[n.kind] || KINDS.note;
    const shown = revealed.has(n.id);
    const secret = n.hasSecret
      ? '<div class="note-secret"><i class="fas fa-lock" aria-hidden="true"></i><span class="note-secret-value">' + (shown ? esc(revealed.get(n.id)) : "••••••••••") + "</span>" +
        '<button class="env-mini env-icon" data-act="' + (shown ? "hide" : "reveal") + '" data-id="' + esc(n.id) + '" title="' + (shown ? "Hide" : "Show") + '"><i class="fas fa-' + (shown ? "eye-slash" : "eye") + '"></i></button>' +
        '<button class="env-mini env-icon" data-act="copy" data-id="' + esc(n.id) + '" title="Copy secret"><i class="fas fa-copy"></i></button></div>'
      : "";
    const actions = !canEdit ? "" : confirmingId === n.id
      ? '<button class="env-mini env-mini-danger" data-act="delete" data-id="' + esc(n.id) + '">Delete</button><button class="env-mini" data-act="cancel">Keep</button>'
      : '<button class="env-mini env-icon" data-act="edit" data-id="' + esc(n.id) + '" title="Edit"><i class="fas fa-pen"></i></button>' +
        '<button class="env-mini env-icon" data-act="confirm-delete" data-id="' + esc(n.id) + '" title="Delete"><i class="fas fa-trash"></i></button>';
    return '<article class="note-card" data-kind="' + esc(n.kind) + '">' +
      '<header><span class="note-kind"><i class="fas ' + icon + '" aria-hidden="true"></i>' + label + "</span>" +
      '<h4>' + esc(n.title) + "</h4>" + '<span class="note-actions">' + actions + "</span></header>" +
      (n.body ? '<div class="note-body">' + md(n.body) + "</div>" : "") + secret +
      '<footer>' + (n.source === "agent" ? "Saved by the agent · " : "") + ago(n.updatedAt) + "</footer></article>";
  }

  function render() {
    const list = $("notes-list");
    if (!list) return;
    const count = $("notes-count");
    if (count) count.textContent = notes.length ? notes.length + (notes.length === 1 ? " note" : " notes") : "Nothing saved yet";
    const add = $("notes-add");
    if (add) add.hidden = !canEdit;
    let html = editingId === "new" ? '<article class="note-card is-editing">' + form(null) + "</article>" : "";
    if (!notes.length && editingId !== "new") {
      html = '<div class="env-empty">No notes yet.<br />The agent saves test logins, links and decisions here as it works, or add your own.</div>';
    }
    list.innerHTML = html + notes.map(card).join("");
    list.querySelector(".is-editing input[name=title]")?.focus();
  }

  async function load() {
    if (!projectId) return;
    try {
      const d = await api("");
      const next = JSON.stringify(d.notes || []);
      canEdit = !!d.canEdit;
      // A blip in an earlier poll ("Failed to fetch") is stale once one succeeds.
      if ($("notes-msg")?.dataset.loadError) { msg(""); delete $("notes-msg").dataset.loadError; }
      // Polling must not wipe a form the user is typing in.
      if (next === signature && notes.length) return;
      signature = next; notes = d.notes || [];
      if (!editingId) render();
      else if (!notes.some((n) => n.id === editingId) && editingId !== "new") { editingId = null; render(); }
    } catch (e) {
      // Background refreshes stay quiet; only a load with nothing shown reports the failure.
      if (notes.length) return;
      msg("Couldn't load notes. Check your connection; it retries automatically.");
      const el = $("notes-msg"); if (el) el.dataset.loadError = "1";
    }
  }

  async function secretOf(id) {
    if (!revealed.has(id)) revealed.set(id, (await api("/" + encodeURIComponent(id) + "/secret")).secret || "");
    return revealed.get(id);
  }

  async function submit(formEl) {
    const id = formEl.getAttribute("data-form");
    const data = Object.fromEntries(new FormData(formEl).entries());
    const body = { title: String(data.title || "").trim(), kind: data.kind, body: String(data.body || "") };
    if (!body.title) { msg("A title is required."); return; }
    if (data.secret) body.secret = String(data.secret);
    else if (data.clearSecret) body.secret = null;
    msg("");
    try {
      if (id === "new") await api("", { method: "POST", body: JSON.stringify(body) });
      else await api("/" + encodeURIComponent(id), { method: "PATCH", body: JSON.stringify(body) });
      revealed.delete(id); editingId = null; signature = ""; await load(); render();
    } catch (e) { msg(e.message || "Could not save the note."); }
  }

  function init() {
    const root = $("notes-root");
    if (!root) return;
    projectId = root.getAttribute("data-project-id");
    $("notes-add")?.addEventListener("click", () => { editingId = "new"; confirmingId = null; msg(""); render(); });
    $("notes-refresh")?.addEventListener("click", () => { msg(""); signature = ""; load(); });
    const list = $("notes-list");
    list?.addEventListener("submit", (e) => { e.preventDefault(); submit(e.target); });
    list?.addEventListener("keydown", (e) => { if (e.key === "Escape" && editingId) { editingId = null; render(); } });
    list?.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const act = btn.getAttribute("data-act"), id = btn.getAttribute("data-id");
      msg("");
      try {
        if (act === "edit") { editingId = id; confirmingId = null; render(); }
        else if (act === "cancel") { editingId = null; confirmingId = null; render(); }
        else if (act === "confirm-delete") { confirmingId = id; render(); }
        else if (act === "delete") { await api("/" + encodeURIComponent(id), { method: "DELETE" }); confirmingId = null; revealed.delete(id); signature = ""; await load(); render(); }
        else if (act === "reveal") { await secretOf(id); render(); }
        else if (act === "hide") { revealed.delete(id); render(); }
        else if (act === "copy") { await navigator.clipboard.writeText(await secretOf(id)); msg("Secret copied to the clipboard.", true); }
      } catch (err) { msg(err.message || "That didn't work."); }
    });
    const pane = $("notes");
    if (pane) {
      if (pane.classList.contains("active")) load();
      new MutationObserver(() => { if (pane.classList.contains("active")) load(); }).observe(pane, { attributes: true, attributeFilter: ["class"] });
    }
    setInterval(() => { if (!document.hidden && $("notes")?.classList.contains("active")) load(); }, 6000);
  }

  window.NotesTab = { load, open: () => (window.switchTab ? window.switchTab("notes") : document.querySelector('.tab-button[data-tab="notes"]')?.click()) };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
