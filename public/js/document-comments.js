/**
 * Inline document comments — text selection, highlights, comment threads.
 *
 * Usage:
 *   initDocumentComments(fileId, projectId, { canComment: true })
 */

(function () {
  "use strict";

  var state = {
    fileId: null,
    projectId: null,
    canComment: false,
    comments: [],
    rawContent: "",
    panelOpen: false, // panel is a manual sidebar — only shows when the user opens it
  };

  window.initDocumentComments = function (fileId, projectId, opts) {
    // Re-init for a different doc resets the panel state so it doesn't "pop up".
    if (state.fileId !== fileId) state.panelOpen = false;
    state.fileId = fileId;
    state.projectId = projectId;
    state.canComment = opts && opts.canComment;
    state.members = [];

    // Load members for @mention autocomplete.
    fetch("/api/projects/" + projectId + "/members")
      .then(function (r) { return r.json(); })
      .then(function (m) {
        var list = [];
        if (m.owner) list.push({ name: m.owner.name, email: m.owner.email });
        (m.members || []).forEach(function (x) { list.push({ name: x.userName, email: x.userEmail }); });
        state.members = list;
      })
      .catch(function () {});

    loadComments();
    if (state.canComment) setupSelectionListener();
  };

  // @mention autocomplete inside a comment textarea.
  function attachMentionAutocomplete(textarea) {
    var dd = null;
    function close() { if (dd) { dd.remove(); dd = null; } }
    textarea.addEventListener("input", function () {
      var val = textarea.value, pos = textarea.selectionStart;
      var upto = val.slice(0, pos);
      var m = upto.match(/@([a-zA-Z0-9._-]*)$/);
      if (!m) { close(); return; }
      var q = m[1].toLowerCase();
      var matches = (state.members || []).filter(function (p) {
        var n = (p.name || "").toLowerCase(), e = (p.email || "").toLowerCase();
        return !q || n.indexOf(q) >= 0 || e.indexOf(q) >= 0;
      }).slice(0, 6);
      if (!matches.length) { close(); return; }
      if (!dd) { dd = document.createElement("div"); dd.className = "mention-dropdown"; document.body.appendChild(dd); }
      var rect = textarea.getBoundingClientRect();
      dd.style.left = rect.left + "px";
      dd.style.top = rect.bottom + 4 + "px";
      dd.style.width = rect.width + "px";
      dd.innerHTML = matches.map(function (p) {
        var handle = (p.name || p.email || "").split(/\s+/)[0];
        return '<div class="mention-item" data-handle="' + escapeHtml(handle) + '">@' + escapeHtml(handle) +
          ' <span style="color:var(--text-secondary);font-size:0.7rem;">' + escapeHtml(p.name || "") + "</span></div>";
      }).join("");
      dd.querySelectorAll(".mention-item").forEach(function (it) {
        it.addEventListener("mousedown", function (e) {
          e.preventDefault();
          var handle = it.dataset.handle;
          textarea.value = upto.replace(/@[a-zA-Z0-9._-]*$/, "@" + handle + " ") + val.slice(pos);
          textarea.focus();
          close();
        });
      });
    });
    textarea.addEventListener("blur", function () { setTimeout(close, 150); });
  }

  function apiBase() {
    return "/api/projects/" + state.projectId + "/files/" + state.fileId + "/comments";
  }

  function loadComments() {
    fetch(apiBase())
      .then(function (r) { return r.json(); })
      .then(function (data) {
        state.comments = data.comments || [];
        renderHighlights();
        renderCommentPanel();
      });
  }

  // ── Text selection → floating "Comment" button ─────────────────────

  function editorOwns(el) {
    return !!(window.DocEditor && window.DocEditor.isActive(el));
  }

  function setupSelectionListener() {
    var contentArea = document.querySelector(".shared-content, .file-content, .artifact-content, #content, #viewer-markdown");
    if (contentArea) bindSelection(contentArea);
  }

  function bindSelection(contentArea) {
    // The viewer element is reused for every document; listen once.
    if (contentArea.dataset.commentSelectionBound) return;
    contentArea.dataset.commentSelectionBound = "1";

    contentArea.addEventListener("mouseup", function (e) {
      removeFloatingButton();
      // An editable document has its own selection toolbar (doc-editor.js) with Comment in it.
      if (editorOwns(contentArea)) return;
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) return;

      var range = sel.getRangeAt(0);
      var selectedText = sel.toString().trim();
      if (selectedText.length < 2) return;

      // Create floating button
      var rect = range.getBoundingClientRect();
      var btn = document.createElement("button");
      btn.id = "comment-float-btn";
      btn.className = "comment-float-btn";
      btn.innerHTML = '<i class="fas fa-comment"></i> Comment';
      btn.style.position = "fixed";
      btn.style.left = Math.max(10, Math.min(rect.left + rect.width / 2 - 50, window.innerWidth - 110)) + "px";
      // Prefer above the selection; if that's off the top of the viewport, drop below it.
      btn.style.top = (rect.top - 40 >= 10 ? rect.top - 40 : rect.bottom + 8) + "px";
      btn.style.zIndex = "9999";

      btn.addEventListener("click", function () {
        openCommentInput(selectedText, range);
        removeFloatingButton();
      });

      document.body.appendChild(btn);
    });

    if (floatCloserBound) return;
    floatCloserBound = true;
    document.addEventListener("mousedown", function (e) {
      if (e.target.id !== "comment-float-btn" && !e.target.closest("#comment-float-btn")) {
        removeFloatingButton();
      }
    });
  }
  var floatCloserBound = false;

  function removeFloatingButton() {
    var existing = document.getElementById("comment-float-btn");
    if (existing) existing.remove();
  }

  // doc-editor.js's selection toolbar opens the same popover. `range` only needs
  // getBoundingClientRect().
  window.openDocumentCommentInput = function (selectedText, range) {
    if (!state.canComment || !state.fileId) return;
    openCommentInput(selectedText, range);
  };

  function openCommentInput(selectedText, range) {
    // Remove any existing input
    var existing = document.getElementById("comment-input-popover");
    if (existing) existing.remove();

    var rect = range.getBoundingClientRect();

    var popover = document.createElement("div");
    popover.id = "comment-input-popover";
    popover.className = "comment-input-popover";
    popover.style.position = "fixed";
    popover.style.left = Math.max(10, rect.left) + "px";
    popover.style.top = rect.bottom + 8 + "px";
    popover.style.zIndex = "9999";

    popover.innerHTML =
      '<div style="padding:0.75rem;">' +
        '<div style="font-size:0.75rem;color:var(--text-secondary);margin-bottom:0.5rem;max-height:2.5em;overflow:hidden;font-style:italic;">"' + escapeHtml(selectedText.slice(0, 80)) + (selectedText.length > 80 ? '...' : '') + '"</div>' +
        '<textarea id="comment-input-text" rows="3" class="input" style="width:260px;box-sizing:border-box;resize:vertical;font-size:0.8125rem;" placeholder="Add a comment..."></textarea>' +
        '<div style="display:flex;gap:0.5rem;margin-top:0.5rem;justify-content:flex-end;">' +
          '<button class="btn" style="font-size:0.75rem;padding:0.3rem 0.6rem;" onclick="this.closest(\'#comment-input-popover\').remove()">Cancel</button>' +
          '<button class="btn btn-primary" style="font-size:0.75rem;padding:0.3rem 0.6rem;" id="comment-submit-btn">Comment</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(popover);

    // Keep the popover fully within the viewport. It's position:fixed at the selection's
    // bottom edge — a selection near the bottom of the page put it BELOW the fold, and
    // since it's fixed you can't scroll to it. Measure after append, then flip it ABOVE
    // the selection (or clamp) so it's always reachable. Also clamp horizontally.
    (function clampIntoViewport() {
      var margin = 10;
      var pr = popover.getBoundingClientRect();
      var vw = window.innerWidth, vh = window.innerHeight;
      var top = rect.bottom + 8;
      if (top + pr.height + margin > vh) {
        var above = rect.top - pr.height - 8;
        top = above >= margin ? above : Math.max(margin, vh - pr.height - margin);
      }
      var left = Math.max(margin, rect.left);
      if (left + pr.width + margin > vw) left = Math.max(margin, vw - pr.width - margin);
      popover.style.top = top + "px";
      popover.style.left = left + "px";
    })();

    var textarea = document.getElementById("comment-input-text");
    textarea.focus();
    attachMentionAutocomplete(textarea);

    document.getElementById("comment-submit-btn").addEventListener("click", function () {
      var content = textarea.value.trim();
      if (!content) return;

      // Compute approximate character offsets
      var rangeStart = 0;
      var rangeEnd = selectedText.length;

      fetch(apiBase(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedText: selectedText,
          rangeStart: rangeStart,
          rangeEnd: rangeEnd,
          content: content,
        }),
      })
        .then(function (r) { return r.json(); })
        .then(function () {
          popover.remove();
          state.panelOpen = true; // reveal the panel so the new comment is visible
          loadComments();
        });
    });

    // Close on outside click — but NOT when clicking the @mention dropdown
    // (it lives on document.body, outside the popover, so ignore it here).
    setTimeout(function () {
      document.addEventListener("mousedown", function handler(e) {
        if (!popover.contains(e.target) && !(e.target.closest && e.target.closest(".mention-dropdown"))) {
          popover.remove();
          document.removeEventListener("mousedown", handler);
        }
      });
    }, 100);
  }

  // ── Highlights ─────────────────────────────────────────────────────

  function renderHighlights() {
    var open = state.comments.filter(function (c) { return !c.isResolved && c.selectedText; });
    // In the live editor, highlights are decorations — editing its DOM would count as a change.
    if (window.DocEditor) {
      window.DocEditor.setHighlights(open.map(function (c) { return { id: c.id, text: c.selectedText }; }), state.fileId);
    }
    extraAreas.forEach(function (a) { highlightArea(a, open); });
    var area = document.querySelector("#viewer-markdown");
    if (area && editorOwns(area)) return;

    var contentArea = document.querySelector(".shared-content, .file-content, .artifact-content, #content, #viewer-markdown");
    if (!contentArea) return;
    highlightArea(contentArea, open);
  }

  function highlightArea(area, open) {
    area.querySelectorAll("mark.comment-highlight").forEach(function (el) {
      el.outerHTML = el.innerHTML;
    });
    open.forEach(function (comment) { highlightText(area, comment.selectedText, comment.id); });
  }

  // Other views of the same document (the full-screen reader) get selection-to-comment
  // and highlights too. Returns false when no document's comments are loaded.
  var extraAreas = [];
  window.DocumentComments = {
    attach: function (area) {
      if (!state.fileId || !area) return false;
      if (extraAreas.indexOf(area) < 0) extraAreas.push(area);
      if (state.canComment) bindSelection(area);
      highlightArea(area, state.comments.filter(function (c) { return !c.isResolved && c.selectedText; }));
      return true;
    },
    detach: function (area) {
      extraAreas = extraAreas.filter(function (a) { return a !== area; });
      removeFloatingButton();
      var pop = document.getElementById("comment-input-popover");
      if (pop) pop.remove();
    },
    toggle: function () { window.toggleCommentsPanel(); },
    unresolvedCount: function () { return state.comments.filter(function (c) { return !c.isResolved; }).length; },
    onChange: null,
  };

  // Find the commented text even when it runs across formatting (a bold label followed by
  // plain text, several list items) and mark each piece. Whitespace differences between
  // the saved selection and the page (line breaks between blocks) are ignored.
  function highlightText(container, text, commentId) {
    var needle = String(text || "").replace(/\s+/g, " ").trim();
    if (needle.length < 2) return;

    var nodes = [];
    var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        var p = n.parentElement;
        return p && p.closest("svg, script, style, .lfg-diagram, details") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    }, false);
    var node;
    while ((node = walker.nextNode())) nodes.push(node);

    // One normalised string over all text nodes, with each character's source position.
    var flat = "", map = [], lastSpace = true;
    nodes.forEach(function (n, ni) {
      var t = n.textContent;
      for (var i = 0; i < t.length; i++) {
        var ch = t[i];
        if (/\s/.test(ch)) {
          if (lastSpace) continue;
          ch = " "; lastSpace = true;
        } else lastSpace = false;
        flat += ch; map.push([ni, i]);
      }
      // Separate blocks that sit side by side with no whitespace between them.
      if (!lastSpace && n.parentElement && nodes[ni + 1] && blockOf(n) !== blockOf(nodes[ni + 1])) {
        flat += " "; map.push([ni, t.length]); lastSpace = true;
      }
    });

    var idx = flat.indexOf(needle);
    if (idx === -1) idx = flat.toLowerCase().indexOf(needle.toLowerCase());
    if (idx === -1) return;
    var startPos = map[idx], endPos = map[idx + needle.length - 1];

    // Wrap each touched text node's part, last first so earlier offsets stay valid.
    for (var ni = endPos[0]; ni >= startPos[0]; ni--) {
      var n = nodes[ni];
      var from = ni === startPos[0] ? startPos[1] : 0;
      var to = ni === endPos[0] ? Math.min(endPos[1] + 1, n.textContent.length) : n.textContent.length;
      if (to <= from || !n.textContent.slice(from, to).trim()) continue;
      var range = document.createRange();
      range.setStart(n, from);
      range.setEnd(n, to);
      var mark = document.createElement("mark");
      mark.className = "comment-highlight";
      mark.dataset.commentId = commentId;
      mark.addEventListener("click", function () { showCommentThread(commentId); });
      range.surroundContents(mark);
    }
  }

  function blockOf(n) {
    var el = n.parentElement;
    return el && el.closest("p, li, h1, h2, h3, h4, h5, h6, td, th, pre, blockquote, div");
  }

  // ── Comment Panel ──────────────────────────────────────────────────

  // Persistent floating button to open the comments panel — always present in the
  // viewer (even with 0 comments) so there's a clear, discoverable entry point.
  /**
   * Is the document actually on screen? The FAB is position:fixed on document.body, so
   * nothing about closing the viewer, switching artifact tabs or going back to the chat
   * removed it — it just sat there over the chat composer, on a page with no document in
   * sight. Tying it to the viewer's visibility covers every dismissal path at once,
   * including ones added later.
   */
  function viewerVisible() {
    var el = document.getElementById("viewer-markdown");
    return !!(el && el.offsetParent !== null);
  }

  /** Remove the FAB and panel, and stop watching. Safe to call repeatedly. */
  function teardownComments() {
    var fab = document.getElementById("comments-toggle-fab");
    if (fab) fab.remove();
    var panel = document.getElementById("comments-panel");
    if (panel) panel.remove();
    state.panelOpen = false;
    if (fabWatchdog) { clearInterval(fabWatchdog); fabWatchdog = null; }
  }
  window.teardownDocumentComments = teardownComments;

  var fabWatchdog = null;
  var fabRetried = false;
  function watchViewer() {
    if (fabWatchdog) return;
    fabWatchdog = setInterval(function () {
      if (!viewerVisible()) teardownComments();
    }, 700);
  }

  function ensureCommentsFab() {
    var unresolvedCount = state.comments.filter(function (c) { return !c.isResolved; }).length;
    var fab = document.getElementById("comments-toggle-fab");
    // No document in view → no comment affordance, whatever the state says. One retry
    // first: on the very first render this can run a tick before the viewer has laid
    // out, and treating that as "no document" would hide the button for good.
    if (!viewerVisible()) {
      teardownComments();
      if (!fabRetried) { fabRetried = true; setTimeout(ensureCommentsFab, 300); }
      return;
    }
    fabRetried = false;
    // Show the FAB whenever commenting is allowed or comments already exist.
    if (!state.canComment && state.comments.length === 0) { if (fab) fab.remove(); return; }
    if (!fab) {
      fab = document.createElement("button");
      fab.id = "comments-toggle-fab";
      fab.className = "comments-toggle-fab";
      fab.onclick = openCommentsPanel;
      document.body.appendChild(fab);
    }
    fab.style.display = state.panelOpen ? "none" : "";
    watchViewer();
    fab.innerHTML = '<i class="fas fa-comments"></i> Comments' + (unresolvedCount ? ' <span class="badge">' + unresolvedCount + "</span>" : "");
  }

  function openCommentsPanel() {
    state.panelOpen = true;
    renderCommentPanel();
  }

  function renderCommentPanel() {
    var panel = document.getElementById("comments-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "comments-panel";
      panel.className = "comments-panel";
      document.body.appendChild(panel);
    }

    // Panel visibility is user-controlled — never force it open on data refresh.
    document.body.classList.toggle("lfg-comments-open", !!state.panelOpen);
    if (window.DocumentComments.onChange) window.DocumentComments.onChange();
    if (!state.panelOpen) {
      panel.style.display = "none";
      ensureCommentsFab();
      return;
    }

    var unresolved = state.comments.filter(function (c) { return !c.isResolved; });
    var resolved = state.comments.filter(function (c) { return c.isResolved; });

    var html = '<div class="comments-panel-header">' +
      '<span style="font-weight:600;font-size:0.875rem;">Comments (' + state.comments.length + ')</span>' +
      '<button onclick="toggleCommentsPanel()" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;"><i class="fas fa-times"></i></button>' +
    '</div>';

    html += '<div class="comments-panel-body">';

    // Composer to add a document-level comment (no text selection needed).
    if (state.canComment) {
      html += '<div class="comment-composer" style="margin-bottom:0.75rem;">' +
        '<textarea id="new-comment-text" rows="2" class="input" style="width:100%;box-sizing:border-box;resize:vertical;font-size:0.8125rem;" placeholder="Add a comment…"></textarea>' +
        '<div style="display:flex;justify-content:flex-end;margin-top:0.4rem;">' +
          '<button class="btn btn-primary" style="font-size:0.75rem;padding:0.3rem 0.6rem;" onclick="submitNewComment()">Comment</button>' +
        '</div>' +
        '<div style="font-size:0.7rem;color:var(--text-secondary);margin-top:0.25rem;">Tip: select text in the doc to comment on a specific part.</div>' +
      '</div>';
    }

    if (state.comments.length === 0) {
      html += '<div style="padding:1rem;text-align:center;color:var(--text-secondary);font-size:0.8125rem;line-height:1.5;">' +
        'No comments yet.' +
      '</div>';
    }

    unresolved.forEach(function (c) {
      html += renderCommentCard(c, false);
    });

    if (resolved.length > 0) {
      html += '<div style="font-size:0.75rem;color:var(--text-secondary);margin:1rem 0 0.5rem;font-weight:500;">Resolved (' + resolved.length + ')</div>';
      resolved.forEach(function (c) {
        html += renderCommentCard(c, true);
      });
    }

    html += '</div>';
    panel.innerHTML = html;
    panel.style.display = "flex"; // flex, so the list scrolls inside the panel
    var composer = document.getElementById("new-comment-text");
    if (composer) attachMentionAutocomplete(composer);
    ensureCommentsFab();
  }

  // Post a document-level comment (not tied to a text selection).
  window.submitNewComment = function () {
    var ta = document.getElementById("new-comment-text");
    if (!ta) return;
    var content = ta.value.trim();
    if (!content) return;
    fetch(apiBase(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: content }),
    })
      .then(function (r) { return r.json(); })
      .then(function () { ta.value = ""; state.panelOpen = true; loadComments(); });
  };

  // A reply the agent wrote, labelled as the agent (it acts for the person who asked it).
  function authorAgent(forName) {
    return '<span title="' + escapeHtml("Written by the AI agent" + (forName ? " for " + forName : "")) + '"><i class="fas fa-robot" aria-hidden="true" style="margin-right:4px;opacity:.75;"></i>AI agent</span>';
  }

  function renderCommentCard(comment, isResolved) {
    var card = '<div class="comment-card' + (isResolved ? ' resolved' : '') + '" data-comment-id="' + comment.id + '">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;">' +
        '<div style="font-size:0.8125rem;font-weight:500;color:var(--text-color);">' + (comment.byAgent ? authorAgent(comment.userName) : escapeHtml(comment.userName || "User")) + '</div>' +
        '<div style="display:flex;gap:0.25rem;">' +
          '<button onclick="resolveComment(\'' + comment.id + '\')" title="' + (isResolved ? 'Unresolve' : 'Resolve') + '" style="background:none;border:none;color:' + (isResolved ? '#22c55e' : 'var(--text-secondary)') + ';cursor:pointer;font-size:0.75rem;"><i class="fas fa-check-circle"></i></button>' +
          '<button onclick="deleteComment(\'' + comment.id + '\')" title="Delete" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:0.75rem;"><i class="fas fa-trash"></i></button>' +
        '</div>' +
      '</div>' +
      ((comment.selectedText && comment.selectedText.length >= 2)
        ? '<div style="font-size:0.75rem;color:var(--text-secondary);font-style:italic;margin:0.25rem 0;max-height:1.5em;overflow:hidden;">"' + escapeHtml(comment.selectedText.slice(0, 60)) + '"</div>'
        : '') +
      '<div style="font-size:0.8125rem;color:var(--text-color);margin-top:0.25rem;">' + escapeHtml(comment.content) + '</div>';

    // Replies
    if (comment.replies && comment.replies.length > 0) {
      card += '<div style="margin-top:0.5rem;padding-left:0.75rem;border-left:2px solid var(--border-color);">';
      comment.replies.forEach(function (r) {
        card += '<div style="margin-bottom:0.4rem;">' +
          '<span style="font-size:0.75rem;font-weight:500;color:var(--text-color);">' + (r.byAgent ? authorAgent(r.userName) : escapeHtml(r.userName || "User")) + '</span>' +
          '<div style="font-size:0.8125rem;color:var(--text-color);">' + escapeHtml(r.content) + '</div>' +
        '</div>';
      });
      card += '</div>';
    }

    // Reply input
    if (!isResolved && state.canComment) {
      card += '<div style="margin-top:0.5rem;display:flex;gap:0.25rem;">' +
        '<input type="text" class="input comment-reply-input" data-parent-id="' + comment.id + '" placeholder="Reply..." style="flex:1;font-size:0.75rem;padding:0.3rem 0.5rem;" />' +
        '<button class="btn btn-primary" style="font-size:0.7rem;padding:0.3rem 0.5rem;" onclick="submitReply(\'' + comment.id + '\', this)">Reply</button>' +
      '</div>';
    }

    card += '</div>';
    return card;
  }

  window.showDocumentCommentThread = function (commentId) { showCommentThread(commentId); };

  function showCommentThread(commentId) {
    state.panelOpen = true;
    renderCommentPanel();
    var card = document.querySelector('.comment-card[data-comment-id="' + commentId + '"]');
    if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // A click anywhere outside the panel closes it. Clicks that open or feed it (a
  // highlight, the Comments buttons, the comment box, @mentions) keep it open.
  var KEEP_PANEL_OPEN = "#comments-panel, #comments-toggle-fab, #lfg-read-comments, #comment-input-popover, " +
    "#comment-float-btn, .mention-dropdown, mark.comment-highlight, dialog[open]";
  document.addEventListener("mousedown", function (e) {
    if (!state.panelOpen) return;
    var t = e.target;
    if (t && t.closest && t.closest(KEEP_PANEL_OPEN)) return;
    state.panelOpen = false;
    renderCommentPanel();
  });

  window.toggleCommentsPanel = function () {
    state.panelOpen = !state.panelOpen;
    renderCommentPanel();
  };

  window.resolveComment = function (commentId) {
    fetch(apiBase() + "/" + commentId + "/resolve", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
    }).then(function () { loadComments(); });
  };

  window.deleteComment = function (commentId) {
    if (!confirm("Delete this comment?")) return;
    fetch(apiBase() + "/" + commentId, { method: "DELETE" })
      .then(function () { loadComments(); });
  };

  window.submitReply = function (parentId, btn) {
    var input = btn.previousElementSibling;
    var content = input.value.trim();
    if (!content) return;

    fetch(apiBase() + "/" + parentId + "/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: content }),
    }).then(function () {
      input.value = "";
      loadComments();
    });
  };

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
})();
