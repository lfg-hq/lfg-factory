// Boards tab in the chat's right panel: pick one of the project's whiteboards and work on it
// live beside the conversation. The board itself is the normal whiteboard page in a frame, so
// everything it can do (drawing, cursors, sharing) works here too. The chat agent draws on
// boards with its whiteboard tools; a board it touches opens here by itself.
(function () {
  var root = document.getElementById("boards-root");
  if (!root) return;
  var projectId = root.getAttribute("data-project-id");
  var list = document.getElementById("boards-tab-list"), frame = document.getElementById("boards-tab-frame");
  var title = document.getElementById("boards-tab-title"), back = document.getElementById("boards-tab-back");
  var full = document.getElementById("boards-tab-full"), fresh = document.getElementById("boards-tab-new"), note = document.getElementById("boards-tab-note");
  var openId = null, boards = [], canEdit = false;
  var KEY = "lfg-board-open:" + projectId;

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    for (var key in attrs || {}) node.setAttribute(key, attrs[key]);
    if (text != null) node.textContent = text;
    return node;
  }
  function api(path, options) {
    return fetch("/api/whiteboards" + path, Object.assign({ headers: { "Content-Type": "application/json" } }, options || {})).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        if (!response.ok) throw new Error(body.error || "That did not go through.");
        return body;
      });
    });
  }
  function boardUrl(id) { return "/projects/" + encodeURIComponent(projectId) + "/whiteboards/" + encodeURIComponent(id); }
  function showList() {
    openId = null; sessionStorage.removeItem(KEY);
    frame.hidden = true; frame.removeAttribute("src"); list.hidden = false;
    back.hidden = true; full.hidden = true; fresh.hidden = !canEdit; title.textContent = "Whiteboards";
    load();
  }
  function render() {
    list.textContent = "";
    if (!boards.length) {
      list.appendChild(el("div", { "class": "boards-tab-empty" }, canEdit
        ? "No whiteboards yet. Create one, or just ask in the chat: \"sketch how the checkout should look\" and LFG draws it here."
        : "No whiteboards in this project yet."));
      return;
    }
    boards.forEach(function (board) {
      var card = el("button", { type: "button", "class": "boards-tab-card", "data-board": board.id });
      var thumb = el("div", { "class": "boards-tab-thumb" }); thumb.appendChild(el("i", { "class": "fas fa-chalkboard", "aria-hidden": "true" }));
      var meta = el("div", { "class": "boards-tab-meta" });
      meta.appendChild(el("b", null, board.title));
      meta.appendChild(el("small", null, board.elementCount === 1 ? "1 element" : board.elementCount + " elements"));
      card.appendChild(thumb); card.appendChild(meta); list.appendChild(card);
    });
  }
  function load() {
    return api("?projectId=" + encodeURIComponent(projectId)).then(function (body) {
      boards = body.boards || []; canEdit = !!body.canEdit; note.textContent = "";
      if (!openId) { fresh.hidden = !canEdit; render(); }
      else { var current = boards.find(function (b) { return b.id === openId; }); if (current) title.textContent = current.title; }
    }).catch(function (error) { note.textContent = error.message; });
  }
  /** Show a board in the panel. Opens the panel and this tab if they are not showing. */
  function open(id) {
    if (window.ArtifactsPanel && window.ArtifactsPanel.open) window.ArtifactsPanel.open();
    if (window.switchTab && !document.getElementById("boards").classList.contains("active")) window.switchTab("boards");
    if (openId === id && !frame.hidden) return;
    openId = id; sessionStorage.setItem(KEY, id);
    var known = boards.find(function (b) { return b.id === id; });
    title.textContent = known ? known.title : "Whiteboard";
    list.hidden = true; frame.hidden = false; back.hidden = false; fresh.hidden = true;
    full.hidden = false; full.setAttribute("href", boardUrl(id));
    frame.setAttribute("src", boardUrl(id) + "?embed=1");
    if (!known) load();
  }

  list.addEventListener("click", function (event) {
    var card = event.target.closest ? event.target.closest("[data-board]") : null;
    if (card) open(card.getAttribute("data-board"));
  });
  back.addEventListener("click", showList);
  fresh.addEventListener("click", function () {
    fresh.disabled = true;
    api("", { method: "POST", body: JSON.stringify({ projectId: projectId }) }).then(function (body) {
      boards.unshift({ id: body.board.id, title: body.board.title, elementCount: 0 }); open(body.board.id);
    }).catch(function (error) { note.textContent = error.message; }).then(function () { fresh.disabled = false; });
  });
  // The board in the frame reports its name, and asks for the chat when "Ask LFG" is used on a selection.
  window.addEventListener("message", function (event) {
    if (event.origin !== window.location.origin || event.source !== frame.contentWindow || !event.data) return;
    if (event.data.type === "lfg-board-title" && typeof event.data.title === "string") title.textContent = event.data.title;
    if (event.data.type === "lfg-board-ask") { var input = document.getElementById("chat-input"); if (input) input.focus(); }
  });

  var started = false;
  function start() {
    if (started) return; started = true;
    var remembered = sessionStorage.getItem(KEY);
    load().then(function () { if (remembered && boards.some(function (b) { return b.id === remembered; })) open(remembered); });
  }
  // Nothing is fetched until the tab is first shown.
  var tab = document.querySelector('.tab-button[data-tab="boards"]');
  if (tab) tab.addEventListener("click", function () { if (!started) start(); else if (!openId) load(); });
  var pane = document.getElementById("boards");
  if (pane) new MutationObserver(function () { if (pane.classList.contains("active")) start(); }).observe(pane, { attributes: true, attributeFilter: ["class"] });
  if (pane && pane.classList.contains("active")) start();

  window.BoardsTab = { open: function (id) { started = true; open(id); }, list: showList };
})();
