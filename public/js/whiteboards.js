// Whiteboards page: the boards of a project, with create, open and delete.
(function () {
  var page = document.getElementById("boards-page");
  if (!page) return;
  var projectId = page.getAttribute("data-project");
  var canEdit = page.getAttribute("data-can-edit") === "true";
  var grid = document.getElementById("boards-grid");
  var note = document.getElementById("boards-note");
  var base = "/projects/" + encodeURIComponent(projectId) + "/whiteboards/";

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
  function ago(value) {
    var date = new Date(value), minutes = Math.round((Date.now() - date.getTime()) / 60000);
    if (isNaN(minutes)) return "";
    if (minutes < 1) return "just now";
    if (minutes < 60) return minutes + " min ago";
    if (minutes < 60 * 24) return Math.round(minutes / 60) + " h ago";
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  function create() {
    note.textContent = "";
    api("", { method: "POST", body: JSON.stringify({ projectId: projectId }) })
      .then(function (body) { window.location.href = base + body.board.id; })
      .catch(function (error) { note.textContent = error.message; });
  }
  function render(boards) {
    grid.textContent = "";
    if (canEdit) {
      var fresh = el("button", { "class": "board-card board-new", type: "button", id: "board-new-card" });
      var thumb = el("div", { "class": "board-thumb" }); thumb.appendChild(el("i", { "class": "fas fa-plus", "aria-hidden": "true" }));
      var meta = el("div", { "class": "board-meta" });
      meta.appendChild(el("div", { "class": "board-title" }, "New board"));
      meta.appendChild(el("div", { "class": "board-sub" }, "Start with a blank canvas"));
      fresh.appendChild(thumb); fresh.appendChild(meta);
      fresh.addEventListener("click", create);
      grid.appendChild(fresh);
    }
    if (!boards.length && !canEdit) grid.appendChild(el("div", { "class": "boards-empty" }, "No boards in this project yet."));
    boards.forEach(function (board) {
      var card = el("a", { "class": "board-card", href: base + board.id, "data-id": board.id });
      var thumb = el("div", { "class": "board-thumb" }); thumb.appendChild(el("i", { "class": "fas fa-chalkboard", "aria-hidden": "true" }));
      var meta = el("div", { "class": "board-meta" });
      meta.appendChild(el("div", { "class": "board-title" }, board.title));
      meta.appendChild(el("div", { "class": "board-sub" }, (board.elementCount === 1 ? "1 element" : board.elementCount + " elements") + " · edited " + ago(board.updatedAt)));
      card.appendChild(thumb); card.appendChild(meta);
      if (canEdit) {
        var remove = el("button", { "class": "board-delete", type: "button", title: "Delete board", "aria-label": "Delete " + board.title });
        remove.appendChild(el("i", { "class": "fas fa-trash-alt", "aria-hidden": "true" }));
        remove.addEventListener("click", function (event) {
          event.preventDefault(); event.stopPropagation();
          if (!window.confirm('Delete "' + board.title + '"? This cannot be undone.')) return;
          api("/" + board.id, { method: "DELETE" }).then(load).catch(function (error) { note.textContent = error.message; });
        });
        card.appendChild(remove);
      }
      grid.appendChild(card);
    });
  }
  function load() {
    return api("?projectId=" + encodeURIComponent(projectId)).then(function (body) { render(body.boards); })
      .catch(function (error) { grid.textContent = ""; note.textContent = error.message; });
  }
  var button = document.getElementById("board-new-btn");
  if (button) button.addEventListener("click", create);
  load();
})();
