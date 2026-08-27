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

  function row(conv) {
    var a = document.createElement("a");
    a.className = "conversation-item" + (conv.pinned ? " is-pinned" : "");
    a.href = "/chat/project/" + projectId + "/conversation/" + conv.id;
    a.title = conv.title || "Untitled";
    a.innerHTML =
      '<span class="conversation-title">' + esc(conv.title || "Untitled") + "</span>" +
      (conv.author ? '<span class="conversation-author">' + esc(conv.author) + "</span>" : "") +
      // Only your own chats can be pinned; the server enforces it too.
      (conv.is_mine
        ? '<button class="conversation-pin" title="' + (conv.pinned ? "Unpin" : "Pin to top") + '" data-pin="' + esc(conv.id) + '" data-pinned="' + (conv.pinned ? "1" : "") + '">'
          + '<i class="fas fa-thumbtack"></i></button>'
        : "");
    return a;
  }

  function heading(text) {
    var h = document.createElement("div");
    h.className = "conversation-group-label";
    h.textContent = text;
    return h;
  }

  function render(convs) {
    listEl.innerHTML = "";
    if (!convs.length) {
      var empty = document.createElement("div");
      empty.className = "empty-conversations-message";
      empty.textContent = "No chats yet.";
      listEl.appendChild(empty);
      return;
    }
    var pinned = convs.filter(function (c) { return c.pinned; });
    var rest = convs.filter(function (c) { return !c.pinned; });
    // Headings only when there's a pinned group to separate — one "Recent chats"
    // heading above the whole list is already in the markup.
    if (pinned.length) {
      listEl.appendChild(heading("Pinned"));
      pinned.forEach(function (c) { listEl.appendChild(row(c)); });
      if (rest.length) listEl.appendChild(heading("Recent"));
    }
    rest.forEach(function (c) { listEl.appendChild(row(c)); });

    var here = window.location.pathname;
    listEl.querySelectorAll(".conversation-item").forEach(function (el) {
      if (el.getAttribute("href") === here) el.classList.add("active");
    });
  }

  function note(text) {
    listEl.innerHTML = "";
    var d = document.createElement("div");
    d.className = "empty-conversations-message";
    d.textContent = text;
    listEl.appendChild(d);
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
