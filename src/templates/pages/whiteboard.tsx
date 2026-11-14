import { html } from "hono/html";

/**
 * WHITEBOARD: one board, full screen. An infinite canvas to draw, drop notes, sketch screens
 * and comment, with a chat window where the LFG agent reads the board and draws on it.
 *
 * The canvas engine is /public/js/whiteboard.js and the panels around it are
 * /public/js/whiteboard-ui.js. Nothing is inline: inline scripts in these templates break on
 * ordinary JS escapes.
 */
interface Props {
  /** Absent when the board was opened by its link: a guest is told nothing about the project. */
  project?: { projectId: string; name: string };
  board: { id: string; title: string };
  user: { name: string };
  canEdit: boolean;
  canChat: boolean;
  /** Set when the board was opened by its link, with no account. */
  shareToken?: string;
  /** Shown inside the chat's Boards panel: the chat beside it is the agent, so the board's own chat is left out. */
  embed?: boolean;
}

const tool = (id: string, icon: string, label: string, key: string) =>
  html`<button type="button" data-tool="${id}" title="${label} (${key})" aria-label="${label}"><i class="${icon}"></i></button>`;

export function WhiteboardPage({ project, board, user, canEdit, canChat, shareToken, embed }: Props) {
  const guest = !!shareToken;
  return html`<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <link rel="icon" type="image/x-icon" href="/public/images/favicon.ico" />
  ${guest ? html`<meta name="robots" content="noindex, nofollow" /><meta name="referrer" content="no-referrer" />` : ""}
  <title>${board.title} — LFG</title>
  <link rel="stylesheet" href="/public/css/theme-variables.css" />
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css" />
  <link rel="stylesheet" href="/public/css/whiteboard.css?v=20261114" />
  <script src="/public/js/theme-switcher.js"></script>
</head>
<body class="wb-body">
  <div class="wb" id="wb" data-board="${board.id}"${project ? html` data-project="${project.projectId}"` : ""} data-user="${user.name}" data-guest="${guest ? "true" : "false"}" data-embed="${embed ? "true" : "false"}"${guest ? html` data-api="/api/shared-boards/${shareToken!}"` : ""} data-can-edit="${canEdit ? "true" : "false"}" data-can-chat="${canChat ? "true" : "false"}">
    <canvas id="wb-canvas" tabindex="0" aria-label="Whiteboard canvas"></canvas>
    <div class="wb-editor" id="wb-editor" hidden><div contenteditable="true" spellcheck="false" role="textbox" aria-label="Element text"></div></div>

    <div class="wb-empty" id="wb-empty" hidden>
      <h2>A blank board</h2>
      <p>Pick a tool on the left and start drawing, or ask LFG to get you started.</p>
      ${canChat ? html`<div class="wb-ideas">
        <button type="button" data-idea="Sketch a preview of a feature I want to build: ">Sketch a feature preview</button>
        <button type="button" data-idea="Brainstorm ideas as sticky notes, grouped by theme, for: ">Brainstorm with sticky notes</button>
        <button type="button" data-idea="Draw the user flow for: ">Map a user flow</button>
      </div>` : ""}
    </div>

    <header class="wb-panel wb-top">
      ${embed ? "" : project ? html`<a class="wb-ib" href="/projects/${project.projectId}/whiteboards" title="Back to ${project.name} whiteboards" aria-label="Back to whiteboards"><i class="fas fa-arrow-left"></i></a>` : html`<span class="wb-brand" title="LFG whiteboard">🚀</span>`}
      <input id="wb-title" class="wb-title" value="${board.title}" maxlength="120" aria-label="Board name" autocomplete="off" />
      <span class="wb-status" id="wb-status" role="status">Saved</span>
      <span class="wb-live" title="Live: changes and cursors appear as they happen" aria-hidden="true"></span>
    </header>

    <div class="wb-panel wb-actions">
      <div class="wb-peers" id="wb-peers" aria-label="People on this board" hidden></div>
      <button type="button" class="wb-ib" id="wb-undo" title="Undo (Ctrl/Cmd+Z)" aria-label="Undo"><i class="fas fa-undo"></i></button>
      <button type="button" class="wb-ib" id="wb-redo" title="Redo (Ctrl/Cmd+Shift+Z)" aria-label="Redo"><i class="fas fa-redo"></i></button>
      <span class="wb-sep"></span>
      <button type="button" class="wb-ib" id="wb-export" title="Download as image" aria-label="Download as image"><i class="fas fa-download"></i></button>
      <button type="button" class="wb-ib" data-theme-toggle title="Light or dark" aria-label="Switch theme"><i class="fas fa-adjust"></i></button>
      <button type="button" class="wb-ib" id="wb-help-btn" title="Shortcuts (?)" aria-label="Shortcuts"><i class="far fa-keyboard"></i></button>
      ${guest ? "" : html`<button type="button" class="wb-ib" id="wb-share-btn" title="Share by link" aria-label="Share by link" hidden><i class="fas fa-link"></i></button>`}
      <button type="button" class="wb-ask" id="wb-ask" title="Chat with LFG (/)"${canChat ? "" : html` hidden`}><i class="fas fa-magic"></i> Ask LFG</button>
    </div>

    <nav class="wb-panel wb-tools" id="wb-tools" aria-label="Tools"${canEdit ? "" : html` data-readonly="true"`}>
      ${tool("select", "fas fa-mouse-pointer", "Select", "V")}
      ${tool("hand", "far fa-hand-paper", "Pan", "H")}
      <span class="wb-sep edit"></span>
      <span class="edit">${tool("pen", "fas fa-pen", "Pen", "P")}</span>
      <span class="edit">${tool("highlighter", "fas fa-highlighter", "Highlighter", "Y")}</span>
      <span class="edit">${tool("eraser", "fas fa-eraser", "Eraser", "E")}</span>
      <span class="wb-sep edit"></span>
      <span class="edit">${tool("sticky", "far fa-sticky-note", "Sticky note", "N")}</span>
      <span class="edit">${tool("text", "fas fa-font", "Text", "T")}</span>
      <span class="edit"><button type="button" id="wb-shape-btn" title="Shapes (R, O, D)" aria-label="Shapes"><i class="far fa-square"></i></button></span>
      <span class="edit">${tool("arrow", "fas fa-long-arrow-alt-right", "Arrow", "A")}</span>
      <span class="edit">${tool("line", "fas fa-minus", "Line", "L")}</span>
      <span class="edit">${tool("frame", "fas fa-crop-alt", "Frame", "F")}</span>
      <span class="wb-sep edit"></span>
      <span class="edit">${tool("comment", "far fa-comment", "Comment", "C")}</span>
      <span class="edit"><button type="button" id="wb-image-btn" title="Add an image" aria-label="Add an image"><i class="far fa-image"></i></button></span>
      <input type="file" id="wb-image-input" accept="image/*" multiple hidden />
    </nav>
    <div class="wb-panel wb-shapes" id="wb-shapes" hidden>
      ${tool("rect", "far fa-square", "Rectangle", "R")}
      ${tool("ellipse", "far fa-circle", "Ellipse", "O")}
      ${tool("diamond", "far fa-square wb-rot45", "Diamond", "D")}
      ${tool("triangle", "fas fa-play fa-rotate-270", "Triangle", "")}
    </div>

    <div class="wb-panel wb-zoom">
      <button type="button" class="wb-ib" id="wb-zoom-out" title="Zoom out" aria-label="Zoom out"><i class="fas fa-minus"></i></button>
      <button type="button" class="wb-zoom-level" id="wb-zoom-level" title="Reset to 100%">100%</button>
      <button type="button" class="wb-ib" id="wb-zoom-in" title="Zoom in" aria-label="Zoom in"><i class="fas fa-plus"></i></button>
      <button type="button" class="wb-ib" id="wb-zoom-fit" title="Fit everything (Shift+1)" aria-label="Fit everything"><i class="fas fa-expand"></i></button>
    </div>

    <div class="wb-panel wb-bar" id="wb-bar" hidden></div>
    <div class="wb-panel wb-palette" id="wb-palette" hidden></div>
    <div class="wb-panel wb-comment" id="wb-comment" hidden></div>

    <div class="wb-panel wb-help" id="wb-help" hidden>
      <h3>Shortcuts</h3>
      <dl>
        <dt>Space + drag</dt><dd>Pan</dd>
        <dt>Ctrl/Cmd + scroll</dt><dd>Zoom</dd>
        <dt>Shift + 1</dt><dd>Fit everything</dd>
        <dt>Double-click</dt><dd>Edit text, or add text</dd>
        <dt>Alt + drag</dt><dd>Duplicate</dd>
        <dt>Shift + drag</dt><dd>Straight move, square shapes</dd>
        <dt>Ctrl/Cmd + D</dt><dd>Duplicate</dd>
        <dt>] and [</dt><dd>Bring to front, send to back</dd>
        <dt>Arrow keys</dt><dd>Nudge (Shift for 10)</dd>
        <dt>/</dt><dd>Chat with LFG</dd>
      </dl>
      <p>Paste or drop images and text straight onto the board.</p>
    </div>

    <section class="wb-panel wb-chat" id="wb-chat" hidden aria-label="Chat with LFG">
      <div class="wb-chat-head" id="wb-chat-head">
        <span class="wb-chat-name"><i class="fas fa-magic"></i> LFG</span>
        <button type="button" class="wb-ib" id="wb-chat-clear" title="Clear conversation" aria-label="Clear conversation"><i class="far fa-trash-alt"></i></button>
        <button type="button" class="wb-ib" id="wb-chat-close" title="Close" aria-label="Close chat"><i class="fas fa-times"></i></button>
      </div>
      <div class="wb-chat-log" id="wb-chat-log">
        <div class="wb-chat-empty">
          <p>Tell me what you're thinking about and I'll put it on the board. Select anything first to ask about it.</p>
          <button type="button" data-idea="Sketch a preview of a feature I want to build: ">Sketch a feature preview</button>
          <button type="button" data-idea="Brainstorm ideas as sticky notes, grouped by theme, for: ">Brainstorm with sticky notes</button>
          <button type="button" data-idea="Draw the user flow for: ">Map a user flow</button>
          <button type="button" data-idea="Summarise what is on this board and suggest what is missing.">Summarise this board</button>
        </div>
      </div>
      <div class="wb-chat-context" id="wb-chat-context" hidden><span></span><button type="button" title="Clear selection" aria-label="Clear selection"><i class="fas fa-times"></i></button></div>
      <div class="wb-chat-model" hidden><label for="wb-chat-model">Model</label><select id="wb-chat-model" aria-label="Model LFG uses"></select></div>
      <form class="wb-chat-form" id="wb-chat-form">
        <textarea id="wb-chat-input" rows="1" placeholder="Ask LFG to sketch, brainstorm or explain…" aria-label="Message LFG"></textarea>
        <button type="submit" id="wb-chat-send" title="Send" aria-label="Send"><i class="fas fa-arrow-up"></i></button>
      </form>
    </section>

    ${guest ? html`<form class="wb-panel wb-guest" id="wb-guest" hidden>
      <label for="wb-guest-name">What should we call you?</label>
      <p>Your name is shown on the comments you leave.</p>
      <div><input id="wb-guest-name" maxlength="40" placeholder="Your name" autocomplete="name" /><button type="submit" class="wb-primary">Join board</button></div>
    </form>` : html`<div class="wb-panel wb-share" id="wb-share" hidden>
      <h3>Share by link</h3>
      <label for="wb-share-mode">Anyone with the link</label>
      <select id="wb-share-mode">
        <option value="off">has no access</option>
        <option value="view">can view</option>
        <option value="edit">can edit</option>
      </select>
      <div class="wb-share-row" id="wb-share-row" hidden>
        <input id="wb-share-link" readonly aria-label="Board link" />
        <button type="button" class="wb-primary" id="wb-share-copy">Copy link</button>
      </div>
      <p id="wb-share-note"></p>
    </div>`}

    <div class="wb-toast" id="wb-toast" role="status" hidden></div>
  </div>
<script src="/public/js/whiteboard.js?v=20261114"></script>
<script src="/public/js/whiteboard-ui.js?v=20261114"></script>
</body>
</html>`;
}
