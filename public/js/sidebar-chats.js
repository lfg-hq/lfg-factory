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
    var short = title.length > 25 ? title.slice(0, 25) + "..." : title;

    item.innerHTML =
      '<div class="conversation-title" title="' + esc(title) + '">' + esc(short) + "</div>" +
      (conv.is_mine
        // Styled as a sibling of .delete-conversation so it inherits the same
        // hidden-until-hover behaviour that button already has.
        ? '<button class="conversation-pin" title="' + (conv.pinned ? "Unpin" : "Pin to top") +
          '" data-pin="' + esc(conv.id) + '" data-pinned="' + (conv.pinned ? "1" : "") + '">' +
          '<i class="fas fa-thumbtack"></i></button>'
        : '<span class="conversation-author" title="' + esc(conv.author || "") + '">' + esc(conv.author || "") + "</span>");

    item.addEventListener("click", function () {
      window.location.href = "/chat/project/" + projectId + "/conversation/" + conv.id;
    });
    return item;
  }

  function heading(text) {
    var h = document.createElement("div");
    h.className = "conversation-group-label";
    h.textContent = text;
    return h;
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
    var btn = e.target.closest ? e.target.closest("[data-pin]") : null;
    if (!btn) return;
    // Pinning must not follow the link the button sits inside.
    e.preventDefault();
    e.stopPropagation();
    var id = btn.getAttribute("data-pin");
    var next = !btn.getAttribute("data-pinned");
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
