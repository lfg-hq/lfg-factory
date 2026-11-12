/**
 * In-place document editing for the Docs viewer.
 *
 * The rendered document IS the editor: there's no edit mode. Typing autosaves the
 * document back as markdown (debounced), and selecting text shows one small toolbar
 * with inline formatting plus Comment and Add to chat.
 *
 *   DocEditor.mount(container, { fileId, projectId, title, type, markdown, updatedAt })
 *   DocEditor.flush()            save any pending change now
 *   DocEditor.destroy()          flush, then tear the editor down
 *   DocEditor.isActive(el)       is `el` (or its descendant) the live editor?
 *   DocEditor.setHighlights([{id, text}])   comment highlights as decorations
 *
 * Tiptap + @tiptap/markdown come from /public/js/vendor/doc-editor.js (built from
 * vendor-src/doc-editor), loaded the first time a document opens.
 */
(function () {
  "use strict";

  var VENDOR_SRC = "/public/js/vendor/doc-editor.js?v=3.31.4";
  var SAVE_DELAY_MS = 1200;

  var vendorPromise = null;
  function loadVendor() {
    if (window.LfgTiptap) return Promise.resolve(window.LfgTiptap);
    if (!vendorPromise) {
      vendorPromise = new Promise(function (resolve, reject) {
        var s = document.createElement("script");
        s.src = VENDOR_SRC;
        s.onload = function () { window.LfgTiptap ? resolve(window.LfgTiptap) : reject(new Error("editor bundle missing")); };
        s.onerror = function () { vendorPromise = null; reject(new Error("editor bundle failed to load")); };
        document.head.appendChild(s);
      });
    }
    return vendorPromise;
  }

  // One live editor at a time — the Docs viewer shows one document.
  var current = null;
  var mountSeq = 0;

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
  }

  function csrf() {
    var m = document.cookie.match(/csrftoken=([^;]+)/);
    return m ? m[1] : "";
  }

  // ── Markdown output tidy-up ──────────────────────────────────────────
  // @tiptap/markdown escapes defensively: & < > become entities and intraword _
  // gets a backslash. That's valid markdown but turns "R&D" into "R&amp;D" in the
  // stored file (and in what the agent reads), so undo it wherever it's unambiguous.
  // Code spans and fenced blocks are never touched; the serializer leaves them raw.
  function tidyText(seg) {
    return seg
      .replace(/&amp;(?!#?[a-zA-Z0-9]+;)/g, "&")
      .replace(/&lt;(?![a-zA-Z\/!?])/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/(\w)\\_(?=\w)/g, "$1_");
  }
  function tidyLine(line) {
    // A ">" opening the line (or a list item) would become a blockquote — keep that one escaped.
    var lead = line.match(/^\s*(?:(?:[-*+]|\d+[.)])\s+)*(?:&gt;)?/)[0];
    var out = lead, rest = line.slice(lead.length), m;
    while ((m = rest.match(/(`+)[\s\S]*?\1/))) {
      out += tidyText(rest.slice(0, m.index)) + m[0];
      rest = rest.slice(m.index + m[0].length);
    }
    return out + tidyText(rest);
  }
  function tidyMarkdown(md) {
    var lines = String(md).split("\n"), out = [], fence = null, blank = 0;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var f = line.match(/^\s*(`{3,}|~{3,})/);
      if (fence) {
        out.push(line);
        if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
        continue;
      }
      if (f) { fence = f[1]; blank = 0; out.push(line); continue; }
      if (!line.trim()) { if (++blank > 1) continue; out.push(""); continue; }
      blank = 0;
      out.push(tidyLine(line));
    }
    return out.join("\n").replace(/^\n+/, "").replace(/\n*$/, "\n");
  }

  // ── Comment highlights as decorations ────────────────────────────────
  // document-comments.js used to wrap highlighted text in <mark> by editing the DOM.
  // ProseMirror owns this DOM now and would treat that as an edit, so highlights are
  // decorations instead — drawn on top, never part of the saved markdown.
  function commentHighlightExtension(T) {
    var key = new T.PluginKey("lfgCommentHighlights");
    function build(doc, items) {
      var decos = [];
      (items || []).forEach(function (item) {
        var text = item.text;
        if (!text || text.length < 2) return;
        var found = false;
        doc.descendants(function (node, pos) {
          if (found) return false;
          if (!node.isTextblock) return true;
          // One char per leaf so offsets map 1:1 to positions inside the block.
          var hay = node.textBetween(0, node.content.size, undefined, "￼");
          var idx = hay.indexOf(text);
          if (idx === -1) return false;
          decos.push(T.Decoration.inline(pos + 1 + idx, pos + 1 + idx + text.length, {
            nodeName: "mark",
            class: "comment-highlight",
            "data-comment-id": String(item.id),
          }));
          found = true;
          return false;
        });
      });
      return T.DecorationSet.create(doc, decos);
    }
    return T.Extension.create({
      name: "lfgCommentHighlights",
      addProseMirrorPlugins: function () {
        return [new T.Plugin({
          key: key,
          state: {
            init: function () { return { items: [], set: T.DecorationSet.empty }; },
            apply: function (tr, value, _old, newState) {
              var items = tr.getMeta(key);
              if (items) return { items: items, set: build(newState.doc, items) };
              if (tr.docChanged) return { items: value.items, set: build(newState.doc, value.items) };
              return value;
            },
          },
          props: {
            decorations: function (state) { return key.getState(state).set; },
            handleClick: function (_view, _pos, event) {
              var mark = event.target && event.target.closest && event.target.closest("mark.comment-highlight");
              if (mark && window.showDocumentCommentThread) {
                window.showDocumentCommentThread(mark.getAttribute("data-comment-id"));
              }
              return false;
            },
          },
        })];
      },
      addStorage: function () { return { key: key }; },
    });
  }

  // ── Save status ──────────────────────────────────────────────────────
  function statusEl() {
    var el = document.getElementById("doc-save-status");
    if (el) return el;
    var actions = document.getElementById("viewer-actions");
    if (!actions) return null;
    el = document.createElement("span");
    el.id = "doc-save-status";
    el.className = "doc-save-status";
    el.setAttribute("aria-live", "polite");
    actions.insertBefore(el, actions.firstChild);
    return el;
  }
  var statusTimer = null;
  function setStatus(kind, html) {
    var el = statusEl();
    if (!el) return;
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
    el.className = "doc-save-status is-" + kind;
    el.innerHTML = html;
    if (kind === "saved") {
      statusTimer = setTimeout(function () { el.className = "doc-save-status is-saved is-faded"; }, 2500);
    }
  }

  // ── Saving ───────────────────────────────────────────────────────────
  function scheduleSave(ctl) {
    ctl.dirty = true;
    setStatus("pending", "Editing…");
    if (ctl.timer) clearTimeout(ctl.timer);
    ctl.timer = setTimeout(function () { save(ctl); }, SAVE_DELAY_MS);
  }

  function save(ctl, opts) {
    if (ctl.timer) { clearTimeout(ctl.timer); ctl.timer = null; }
    if (!ctl.dirty || ctl.conflict || !ctl.editor) return Promise.resolve();
    if (ctl.saving) { ctl.saveAgain = true; return ctl.saving; }
    var markdown = tidyMarkdown(ctl.editor.getMarkdown());
    ctl.dirty = false;
    setStatus("saving", "Saving…");
    var url = "/projects/" + encodeURIComponent(ctl.projectId) + "/api/files/" + encodeURIComponent(ctl.fileId) + "/content";
    ctl.saving = fetch(url, {
      method: "PUT",
      keepalive: !!(opts && opts.keepalive),
      headers: { "Content-Type": "application/json", "X-CSRFToken": csrf() },
      body: JSON.stringify({ content: markdown, baseUpdatedAt: ctl.updatedAt }),
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) { return { status: r.status, data: data }; });
      })
      .then(function (res) {
        if (res.status === 409) {
          ctl.conflict = true;
          setStatus("error", 'Changed elsewhere · <button type="button" class="doc-save-reload">Reload</button>');
          var btn = document.querySelector("#doc-save-status .doc-save-reload");
          if (btn) btn.addEventListener("click", function () {
            if (window.viewFileContent) window.viewFileContent(ctl.fileId, ctl.title);
          });
          return;
        }
        if (res.status === 403) {
          ctl.editor.setEditable(false);
          setStatus("error", "View only");
          return;
        }
        if (res.status < 200 || res.status >= 300 || !res.data.success) throw new Error(res.data.error || "Save failed");
        ctl.updatedAt = res.data.updatedAt || ctl.updatedAt;
        if (window.currentFileData && String(window.currentFileData.fileId) === String(ctl.fileId)) {
          window.currentFileData.content = markdown;
        }
        if (!ctl.dirty) setStatus("saved", '<i class="fas fa-check"></i> Saved');
      })
      .catch(function () {
        ctl.dirty = true; // keep the change; retry on the next edit or flush
        setStatus("error", 'Not saved · <button type="button" class="doc-save-retry">Retry</button>');
        var btn = document.querySelector("#doc-save-status .doc-save-retry");
        if (btn) btn.addEventListener("click", function () { save(ctl); });
      })
      .then(function () {
        ctl.saving = null;
        if (ctl.saveAgain) { ctl.saveAgain = false; return save(ctl); }
      });
    return ctl.saving;
  }

  // ── Selection toolbar ────────────────────────────────────────────────
  var ICONS = {
    bold: '<i class="fas fa-bold"></i>',
    italic: '<i class="fas fa-italic"></i>',
    strike: '<i class="fas fa-strikethrough"></i>',
    code: '<i class="fas fa-code"></i>',
    link: '<i class="fas fa-link"></i>',
    bullet: '<i class="fas fa-list-ul"></i>',
    ordered: '<i class="fas fa-list-ol"></i>',
  };

  function toolbarHtml(canChat) {
    return (
      '<div class="doc-tb-row" data-row="main">' +
        '<div class="doc-tb-style">' +
          '<button type="button" class="doc-tb-btn doc-tb-style-btn" data-cmd="style" title="Text style"><span class="doc-tb-style-label">Text</span> <i class="fas fa-chevron-down"></i></button>' +
          '<div class="doc-tb-menu" hidden>' +
            '<button type="button" data-cmd="paragraph">Text</button>' +
            '<button type="button" data-cmd="h1" class="is-h1">Heading 1</button>' +
            '<button type="button" data-cmd="h2" class="is-h2">Heading 2</button>' +
            '<button type="button" data-cmd="h3" class="is-h3">Heading 3</button>' +
          '</div>' +
        '</div>' +
        '<span class="doc-tb-sep"></span>' +
        '<button type="button" class="doc-tb-btn" data-cmd="bold" title="Bold (⌘B)">' + ICONS.bold + '</button>' +
        '<button type="button" class="doc-tb-btn" data-cmd="italic" title="Italic (⌘I)">' + ICONS.italic + '</button>' +
        '<button type="button" class="doc-tb-btn" data-cmd="strike" title="Strikethrough">' + ICONS.strike + '</button>' +
        '<button type="button" class="doc-tb-btn" data-cmd="code" title="Inline code">' + ICONS.code + '</button>' +
        '<button type="button" class="doc-tb-btn" data-cmd="link" title="Link">' + ICONS.link + '</button>' +
        '<span class="doc-tb-sep"></span>' +
        '<button type="button" class="doc-tb-btn" data-cmd="bullet" title="Bulleted list">' + ICONS.bullet + '</button>' +
        '<button type="button" class="doc-tb-btn" data-cmd="ordered" title="Numbered list">' + ICONS.ordered + '</button>' +
        '<span class="doc-tb-sep"></span>' +
        '<button type="button" class="doc-tb-btn doc-tb-text" data-cmd="comment" title="Comment on this"><i class="fas fa-comment"></i> Comment</button>' +
        (canChat ? '<button type="button" class="doc-tb-btn doc-tb-text" data-cmd="chat" title="Quote this in the chat"><i class="fas fa-reply"></i> Add to chat</button>' : '') +
      '</div>' +
      '<div class="doc-tb-row doc-tb-linkrow" data-row="link" hidden>' +
        '<input type="url" class="doc-tb-link-input" placeholder="Paste or type a link…" />' +
        '<button type="button" class="doc-tb-btn doc-tb-text" data-cmd="link-apply">Apply</button>' +
        '<button type="button" class="doc-tb-btn" data-cmd="link-remove" title="Remove link"><i class="fas fa-link-slash"></i></button>' +
      '</div>'
    );
  }

  function createToolbar(ctl) {
    var tb = document.createElement("div");
    tb.className = "doc-sel-toolbar";
    tb.setAttribute("role", "toolbar");
    tb.setAttribute("aria-label", "Formatting");
    tb.innerHTML = toolbarHtml(!!document.getElementById("chat-input"));
    tb.hidden = true;
    document.body.appendChild(tb);

    var menu = tb.querySelector(".doc-tb-menu");
    var linkRow = tb.querySelector('[data-row="link"]');
    var mainRow = tb.querySelector('[data-row="main"]');
    var linkInput = tb.querySelector(".doc-tb-link-input");

    // Keep the editor's selection while clicking toolbar buttons.
    tb.addEventListener("mousedown", function (e) {
      if (e.target !== linkInput) e.preventDefault();
    });

    function showLinkRow() {
      var prev = ctl.editor.getAttributes("link").href || "";
      mainRow.hidden = true;
      linkRow.hidden = false;
      linkInput.value = prev;
      ctl.linkEditing = true;
      setTimeout(function () { linkInput.focus(); linkInput.select(); }, 0);
    }
    function hideLinkRow() {
      ctl.linkEditing = false;
      linkRow.hidden = true;
      mainRow.hidden = false;
    }
    function applyLink() {
      var href = linkInput.value.trim();
      var chain = ctl.editor.chain().focus().extendMarkRange("link");
      if (!href) chain.unsetLink().run();
      else {
        if (!/^[a-z][a-z0-9+.-]*:|^\/|^#/i.test(href)) href = "https://" + href;
        chain.setLink({ href: href }).run();
      }
      hideLinkRow();
    }
    linkInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); applyLink(); }
      else if (e.key === "Escape") { e.preventDefault(); hideLinkRow(); ctl.editor.commands.focus(); }
    });
    linkInput.addEventListener("blur", function () {
      setTimeout(function () {
        if (ctl.linkEditing && !tb.contains(document.activeElement)) { hideLinkRow(); hide(); }
      }, 150);
    });

    tb.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-cmd]");
      if (!btn || !ctl.editor) return;
      var cmd = btn.getAttribute("data-cmd");
      var ed = ctl.editor;
      var c = ed.chain().focus();
      if (cmd !== "style") menu.hidden = true;
      switch (cmd) {
        case "style": menu.hidden = !menu.hidden; return;
        case "paragraph": c.setParagraph().run(); break;
        case "h1": c.toggleHeading({ level: 1 }).run(); break;
        case "h2": c.toggleHeading({ level: 2 }).run(); break;
        case "h3": c.toggleHeading({ level: 3 }).run(); break;
        case "bold": c.toggleBold().run(); break;
        case "italic": c.toggleItalic().run(); break;
        case "strike": c.toggleStrike().run(); break;
        case "code": c.toggleCode().run(); break;
        case "bullet": c.toggleBulletList().run(); break;
        case "ordered": c.toggleOrderedList().run(); break;
        case "link": showLinkRow(); return;
        case "link-apply": applyLink(); return;
        case "link-remove": linkInput.value = ""; applyLink(); return;
        case "comment": comment(ctl); hide(); return;
        case "chat": addToChat(ctl); hide(); return;
      }
      refresh();
    });

    function refresh() {
      var ed = ctl.editor;
      if (!ed) return;
      var active = {
        bold: ed.isActive("bold"), italic: ed.isActive("italic"), strike: ed.isActive("strike"),
        code: ed.isActive("code"), link: ed.isActive("link"),
        bullet: ed.isActive("bulletList"), ordered: ed.isActive("orderedList"),
      };
      tb.querySelectorAll(".doc-tb-btn[data-cmd]").forEach(function (b) {
        var on = !!active[b.getAttribute("data-cmd")];
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
      var label = "Text";
      [1, 2, 3].forEach(function (l) { if (ed.isActive("heading", { level: l })) label = "Heading " + l; });
      tb.querySelector(".doc-tb-style-label").textContent = label;
      tb.querySelectorAll(".doc-tb-menu [data-cmd]").forEach(function (b) {
        var cmd = b.getAttribute("data-cmd");
        var on = cmd === "paragraph" ? label === "Text" : label === "Heading " + cmd.slice(1);
        b.classList.toggle("is-active", on);
      });
      var editable = ed.isEditable;
      tb.querySelectorAll('[data-cmd]:not([data-cmd="comment"]):not([data-cmd="chat"])').forEach(function (b) {
        b.disabled = !editable;
      });
    }

    function position() {
      var ed = ctl.editor;
      var sel = ed.state.selection;
      var view = ed.view;
      var start = view.coordsAtPos(sel.from);
      var end = view.coordsAtPos(sel.to);
      var w = tb.offsetWidth, h = tb.offsetHeight, margin = 8;
      var left = (Math.min(start.left, end.left) + Math.max(start.right, end.right)) / 2 - w / 2;
      left = Math.max(margin, Math.min(left, window.innerWidth - w - margin));
      var top = Math.min(start.top, end.top) - h - 8;
      if (top < margin) top = Math.max(start.bottom, end.bottom) + 8;
      tb.style.left = left + "px";
      tb.style.top = top + "px";
    }

    function show() {
      menu.hidden = true;
      if (!ctl.linkEditing) hideLinkRow();
      tb.hidden = false;
      refresh();
      position();
    }
    function hide() {
      tb.hidden = true;
      menu.hidden = true;
      hideLinkRow();
    }

    return { el: tb, show: show, hide: hide, refresh: refresh, position: position };
  }

  function selectionText(ctl) {
    var sel = ctl.editor.state.selection;
    return ctl.editor.state.doc.textBetween(sel.from, sel.to, "\n").trim();
  }

  function comment(ctl) {
    var text = selectionText(ctl);
    if (text.length < 2 || !window.openDocumentCommentInput) return;
    var sel = ctl.editor.state.selection;
    var a = ctl.editor.view.coordsAtPos(sel.from), b = ctl.editor.view.coordsAtPos(sel.to);
    var rect = { left: Math.min(a.left, b.left), right: Math.max(a.right, b.right), top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom) };
    rect.width = rect.right - rect.left; rect.height = rect.bottom - rect.top;
    window.openDocumentCommentInput(text, { getBoundingClientRect: function () { return rect; } });
  }

  // The quoted excerpt plus a [@Title](file:<id>) reference — the same reference the
  // @-mention picker inserts, so the agent resolves it to the document the same way.
  function excerptMessage(title, fileId, text) {
    var clean = String(text).replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
    if (clean.length > 1200) clean = clean.slice(0, 1200).replace(/\s+\S*$/, "") + " …";
    var quote = clean.split("\n").map(function (line) { return "> " + line; }).join("\n");
    var safeTitle = String(title || "Document").replace(/[\[\]]/g, "");
    return quote + "\n\n— from [@" + safeTitle + "](file:" + fileId + ")\n\n";
  }

  function addToChat(ctl) {
    var text = selectionText(ctl);
    if (!text) return;
    document.dispatchEvent(new CustomEvent("lfg-chat-insert", {
      detail: {
        text: excerptMessage(ctl.title, ctl.fileId, text),
        file: { id: ctl.fileId, name: ctl.title, type: ctl.type },
      },
    }));
  }

  // ── Mount / teardown ─────────────────────────────────────────────────
  function teardown(ctl) {
    if (!ctl) return;
    if (ctl.onScroll) window.removeEventListener("scroll", ctl.onScroll, true);
    if (ctl.onResize) window.removeEventListener("resize", ctl.onResize);
    if (ctl.onPageHide) {
      window.removeEventListener("pagehide", ctl.onPageHide);
      document.removeEventListener("visibilitychange", ctl.onPageHide);
    }
    if (ctl.toolbar) ctl.toolbar.el.remove();
    if (ctl.editor) ctl.editor.destroy();
    ctl.editor = null;
  }

  function destroy() {
    mountSeq++;
    var ctl = current;
    current = null;
    if (!ctl) return Promise.resolve();
    var pending = ctl.dirty ? save(ctl, { keepalive: true }) : (ctl.saving || Promise.resolve());
    // Capture the markdown before the editor goes away; save() already read it.
    return pending.then(function () { teardown(ctl); }, function () { teardown(ctl); });
  }

  function mount(container, opts) {
    var seq = ++mountSeq;
    var prev = current;
    current = null;
    var before = prev ? (prev.dirty ? save(prev, { keepalive: true }) : Promise.resolve()).then(function () { teardown(prev); }) : Promise.resolve();

    return before.then(loadVendor).then(function (T) {
      if (seq !== mountSeq || !container.isConnected) return null;

      var ctl = {
        fileId: opts.fileId, projectId: opts.projectId, title: opts.title, type: opts.type,
        updatedAt: opts.updatedAt || null, dirty: false, saving: null, timer: null,
        container: container,
      };

      var host = document.createElement("div");
      host.className = "doc-editor-host";

      var editor;
      try {
        editor = new T.Editor({
          element: host,
          extensions: [
            T.StarterKit.configure({
              link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" } },
            }),
            T.TableKit.configure({ table: { resizable: false } }),
            T.TaskList,
            T.TaskItem.configure({ nested: true }),
            T.Markdown,
            commentHighlightExtension(T),
          ],
          content: opts.markdown || "",
          contentType: "markdown",
          editorProps: { attributes: { class: "doc-editor", spellcheck: "false", "aria-label": "Document" } },
        });
      } catch (err) {
        console.error("[DocEditor] could not start the editor", err);
        return null;
      }

      ctl.editor = editor;
      container.innerHTML = "";
      container.appendChild(host);
      container.classList.add("doc-editable");
      current = ctl;

      var toolbar = createToolbar(ctl);
      ctl.toolbar = toolbar;

      editor.on("update", function (ev) {
        // Only user edits, not decoration/meta transactions.
        if (ev.transaction && ev.transaction.docChanged) scheduleSave(ctl);
      });
      editor.on("selectionUpdate", function () {
        var sel = editor.state.selection;
        if (sel.empty || !editor.isFocused || !selectionText(ctl)) { if (!ctl.linkEditing) toolbar.hide(); return; }
        // Wait for the mouse to come up so the bar doesn't chase a drag.
        if (ctl.pointerDown) return;
        toolbar.show();
      });
      editor.on("blur", function () {
        setTimeout(function () {
          if (!editor.isFocused && !toolbar.el.contains(document.activeElement)) toolbar.hide();
        }, 120);
        if (ctl.dirty) save(ctl);
      });
      host.addEventListener("mousedown", function () { ctl.pointerDown = true; });
      document.addEventListener("mouseup", function onUp() {
        if (!ctl.editor) { document.removeEventListener("mouseup", onUp); return; }
        if (!ctl.pointerDown) return;
        ctl.pointerDown = false;
        setTimeout(function () {
          if (!ctl.editor) return;
          var sel = ctl.editor.state.selection;
          if (!sel.empty && ctl.editor.isFocused && selectionText(ctl)) toolbar.show();
        }, 0);
      });

      ctl.onScroll = function () { if (!toolbar.el.hidden) toolbar.position(); };
      ctl.onResize = ctl.onScroll;
      window.addEventListener("scroll", ctl.onScroll, true);
      window.addEventListener("resize", ctl.onResize);
      ctl.onPageHide = function (e) {
        if (e.type === "visibilitychange" && document.visibilityState !== "hidden") return;
        if (ctl.dirty) save(ctl, { keepalive: true });
      };
      window.addEventListener("pagehide", ctl.onPageHide);
      document.addEventListener("visibilitychange", ctl.onPageHide);

      if (pendingHighlights && String(pendingHighlights.fileId) === String(ctl.fileId)) setHighlights(pendingHighlights.items, ctl.fileId);
      pendingHighlights = null;
      return ctl;
    }).catch(function (err) {
      console.error("[DocEditor]", err);
      return null; // the rendered (read-only) markdown stays in place
    });
  }

  var pendingHighlights = null;
  // `fileId` ties the list to its document: comments can load before or after the
  // editor finishes mounting, and must never land on a different document.
  function setHighlights(items, fileId) {
    if (!current || !current.editor || (fileId != null && String(fileId) !== String(current.fileId))) {
      pendingHighlights = { items: items || [], fileId: fileId };
      return;
    }
    var ed = current.editor;
    var key = ed.storage.lfgCommentHighlights.key;
    ed.view.dispatch(ed.state.tr.setMeta(key, items || []).setMeta("addToHistory", false));
  }

  function isActive(el) {
    return !!(current && current.editor && el && (el === current.container || el.contains(current.container) || current.container.contains(el)));
  }

  window.DocEditor = {
    mount: mount,
    destroy: destroy,
    flush: function () { return current ? save(current) : Promise.resolve(); },
    isActive: isActive,
    setHighlights: setHighlights,
    getMarkdown: function () { return current && current.editor ? tidyMarkdown(current.editor.getMarkdown()) : null; },
    _tidyMarkdown: tidyMarkdown,
    _excerptMessage: excerptMessage,
  };
})();
