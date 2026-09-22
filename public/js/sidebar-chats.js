/**
 * Chat history in the sidebar rail, on every project page — not just the chat page.
 *
 * The rail used to list Chat / Tickets / Epics / Instant and show conversations ONLY
 * inside the chat page, so moving to Tickets or the dashboard meant losing sight of every
 * conversation you had going. Those links now live in the project tab bar, and this
 * renders the history in the space they left, with pinned chats held at the top.
 *
 * The chat page itself keeps its own renderer (chat.js owns that list, including live
 * title updates); this script deliberately stands down there.
 */
(function () {
  "use strict";

  var host = document.querySelector("[data-sidebar-chats]");
  if (!host) return;
  // chat.js owns the list on the chat page — two renderers would fight over it.
  if (document.getElementById("chat-form")) return;

  var listEl = host.querySelector("#conversation-list");
  var projectId = host.getAttribute("data-project");
  if (!listEl || !projectId) return;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /**
   * Same DOM the chat page builds (div.conversation-item > div.conversation-title),
   * because sidebar.css styles those exact elements — with !important throughout. An
   * <a> wrapper with a <span> title rendered in the wrong weight and size.
   */
  function row(conv) {
    var item = document.createElement("div");
    item.className = "conversation-item" + (conv.pinned ? " is-pinned" : "");
    item.dataset.id = conv.id;

    var title = conv.title || "Untitled";
    var author = (conv.author || "Teammate").trim();
    var words = author.split(/\s+/).filter(Boolean);
    var initials = words.length ? (Array.from(words[0])[0] + (words.length > 1 ? Array.from(words[words.length - 1])[0] : '')).toUpperCase() : '?';
    item.setAttribute("tabindex", "0");
    item.setAttribute("role", "link");
    item.setAttribute("aria-label", title + (conv.is_mine ? "" : " — " + author));
    item.addEventListener("keydown", function (e) {
      if (e.target === item && e.key === "Enter") { e.preventDefault(); item.click(); }
    });

    item.innerHTML =
      '<div class="conversation-title" title="' + esc(title) + '">' + esc(title) + "</div>" +
      (conv.is_mine
        // Pin AND delete, the same pair the chat page shows — otherwise the rail is a
        // different component depending on which page you're standing on.
        ? '<button class="conversation-pin" title="' + (conv.pinned ? "Unpin" : "Pin to top") +
          '" data-pin="' + esc(conv.id) + '" data-pinned="' + (conv.pinned ? "1" : "") + '">' +
          '<i class="fas fa-thumbtack"></i></button>' +
          '<button class="delete-conversation" title="Delete" data-del="' + esc(conv.id) + '">' +
          '<i class="fas fa-trash"></i></button>'
        : '<span class="conversation-author" title="' + esc(author) + '" aria-label="' + esc(author) + '">' + esc(initials) + "</span>");

    item.addEventListener("click", function (e) {
      if (e.target.closest && e.target.closest("button")) return;
      window.location.href = "/chat/project/" + projectId + "/conversation/" + conv.id;
    });
    return item;
  }

  function note(text) {
    listEl.innerHTML = "";
    var d = document.createElement("div");
    d.className = "empty-conversations-message";
    d.textContent = text;
    listEl.appendChild(d);
  }

  function render(convs) {
    listEl.innerHTML = "";
    if (!convs.length) { note("No chats yet."); return; }

    var pinned = convs.filter(function (c) { return c.pinned; });
    var rest = convs.filter(function (c) { return !c.pinned; });
    // The persistent pin icon identifies pinned chats without extra section rows.
    pinned.forEach(function (c) { listEl.appendChild(row(c)); });
    rest.forEach(function (c) { listEl.appendChild(row(c)); });

    var here = window.location.pathname;
    listEl.querySelectorAll(".conversation-item").forEach(function (el) {
      if (here.indexOf("/conversation/" + el.dataset.id) !== -1) el.classList.add("active");
    });
  }

  function load() {
    fetch("/api/projects/" + projectId + "/conversations/")
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (j) { render(Array.isArray(j) ? j : []); })
      // Say something. An empty rail that swallowed its error is indistinguishable
      // from "you have no chats" — which is how a script that never even loaded went
      // unnoticed.
      .catch(function (e) {
        console.warn("[sidebar-chats] could not load conversations:", e);
        note("Couldn't load chats.");
      });
  }

  listEl.addEventListener("click", function (e) {
    var del = e.target.closest ? e.target.closest("[data-del]") : null;
    if (del) {
      e.preventDefault();
      e.stopPropagation();
      if (!window.confirm("Delete this chat? This cannot be undone.")) return;
      fetch("/api/conversations/" + del.getAttribute("data-del"), { method: "DELETE" })
        .then(load)
        .catch(function () { note("Couldn't delete that chat."); });
      return;
    }
    var btn = e.target.closest ? e.target.closest("[data-pin]") : null;
    if (!btn) return;
    // Pinning must not follow the link the button sits inside.
    e.preventDefault();
    e.stopPropagation();
    var id = btn.getAttribute("data-pin");
    var next = btn.getAttribute("data-pinned") !== "1";
    btn.disabled = true;
    fetch("/api/conversations/" + id + "/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: next }),
    })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j && j.ok) load(); else btn.disabled = false; })
      .catch(function () { btn.disabled = false; });
  });

  load();
})();
