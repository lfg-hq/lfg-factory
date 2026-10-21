import { NotificationNav } from "../components/notification-nav.tsx";
import { html } from "hono/html";
import { ChatInput } from "../components/chat-input.tsx";

interface ChatPageProps {
  user: { id: string; name: string; email: string };
  projectId: string;
  projectName: string;
  conversationId?: string;
  modelKey?: string;
  roleKey?: string;
  models?: Array<{ key: string; providerLabel: string; requiresPro: boolean; available?: boolean }>;
}

export function ChatPage({
  user,
  projectId,
  projectName,
  conversationId,
  modelKey = "claude_4.5_sonnet",
  roleKey = "product_analyst",
  models = [],
}: ChatPageProps) {
  return html`<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/x-icon" href="/public/images/favicon.ico" />
  <title>${projectName} — LFG</title>
  <script>(function(){if(localStorage.getItem('sidebarMinimized')==='true'){document.documentElement.classList.add('sidebar-minimized-preload');}})()</script>
  <link rel="stylesheet" href="/public/css/document-graph.css?v=20261015-map-groups" />
  <script src="/public/js/document-graph.js?v=20261015-map-groups" defer></script>
  <script src="/public/js/ticket-map.js?v=20261015-map-groups" defer></script>
  <link rel="stylesheet" href="/public/css/theme-variables.css" />
  <link rel="stylesheet" href="/public/css/common.css" />
  <link rel="stylesheet" href="/public/css/sidebar.css?v=20260908-startup" />
  <link rel="stylesheet" href="/public/css/artifacts.css?v=20261004-dark-folders" />
  <link rel="stylesheet" href="/public/css/document-comments.css" />
  <link rel="stylesheet" href="/public/css/chat-artifacts.css?v=20261020-one-card" />
  <link rel="stylesheet" href="/public/css/chat.css?v=20261021-inline-strip" />
  <link rel="stylesheet" href="/public/css/artifacts-fix.css" />
  <link rel="stylesheet" href="/public/css/polish.css" />
  <link rel="stylesheet" href="/public/css/light/light-mode.css" />
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css" />
  <style>
    /* "Chat with ticket" log entries */
    #ta-log .ta-user { align-self:flex-end; max-width:85%; background:#7c3aed; color:#fff; padding:8px 13px; border-radius:12px 12px 3px 12px; font-size:13.5px; line-height:1.5; white-space:pre-wrap; word-break:break-word; }
    #ta-log .ta-agent { align-self:flex-start; max-width:92%; background:var(--card-bg,#161616); border:1px solid var(--border-color,#2a2a2a); border-left:3px solid #34d399; padding:10px 13px; border-radius:10px; font-size:13.5px; line-height:1.55; }
    #ta-log .ta-agent-label { font-size:10.5px; text-transform:uppercase; letter-spacing:.5px; color:#34d399; font-weight:700; margin-bottom:4px; }
    #ta-log .ta-cmd { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; color:var(--text-secondary,#9ca3af); padding:2px 0; }
    #ta-log .ta-out { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11.5px; color:var(--text-color,#cbd5e1); background:var(--background-surface,#141414); border:1px solid var(--border-color,#2a2a2a); border-radius:6px; padding:8px 10px; white-space:pre-wrap; word-break:break-word; max-height:220px; overflow:auto; }
    #ta-log .ta-thinking { align-self:flex-start; color:var(--text-secondary,#9ca3af); font-size:12.5px; padding:4px 2px; }
    #ta-log .markdown-content p { margin:.3em 0; }
    #ta-log .ta-agent-fail { border-left-color:#f87171; }
    #ta-log .ta-error { align-self:flex-start; max-width:92%; background:rgba(248,113,113,.08); border:1px solid rgba(248,113,113,.28); color:#fca5a5; padding:8px 12px; border-radius:8px; font-size:13px; line-height:1.5; }
    #ta-log .ta-question { align-self:flex-start; max-width:92%; background:rgba(245,158,11,.08); border:1px solid rgba(245,158,11,.30); border-left:3px solid #f59e0b; padding:10px 13px; border-radius:10px; font-size:13.5px; line-height:1.55; }
    #ta-log .ta-question-label { font-size:10.5px; text-transform:uppercase; letter-spacing:.5px; color:#f59e0b; font-weight:700; margin-bottom:4px; display:flex; align-items:center; gap:6px; }
    #ta-log .ta-qopts { display:flex; flex-wrap:wrap; gap:6px; margin-top:9px; }
    #ta-log .ta-qopt { background:rgba(245,158,11,.12); border:1px solid rgba(245,158,11,.35); color:var(--text-color,#e2e8f0); font-size:12.5px; padding:5px 11px; border-radius:999px; cursor:pointer; }
    #ta-log .ta-qopt:hover { background:rgba(245,158,11,.22); }
    #ta-log .ta-qopt:disabled { opacity:.45; cursor:default; }
    #ta-log .ta-cmdrow { align-self:stretch; }
    /* One row per action: verb icon, what happened, a short result, optional details. */
    #ta-log .ta-cmd-header { display:flex; align-items:center; gap:10px; font-size:12.5px; color:var(--text-color,#cbd5e1); padding:5px 8px; border-radius:7px; min-height:28px; }
    #ta-log .ta-cmd-header[data-ta-toggle] { cursor:pointer; }
    #ta-log .ta-cmd-header[data-ta-toggle]:hover { background:var(--border-color,#1f1f1f); }
    #ta-log .ta-verb { width:14px; text-align:center; font-size:11px; color:var(--text-secondary,#94a3b8); flex:none; }
    #ta-log .ta-cmd-text { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; min-width:0; }
    #ta-log .ta-result { flex:none; font-size:11px; color:var(--text-secondary,#94a3b8); padding:1px 8px; border-radius:999px; background:rgba(128,128,128,.1); white-space:nowrap; }
    #ta-log .ta-act.is-failed .ta-verb, #ta-log .ta-act.is-failed .ta-result { color:#dc2626; }
    #ta-log .ta-act.is-failed .ta-result { background:rgba(220,38,38,.1); }
    #ta-log .ta-chev { font-size:9px; opacity:.5; transition:transform .12s; flex:none; }
    #ta-log .ta-outline { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11.5px; color:var(--text-secondary,#94a3b8); padding:2px 8px 2px 32px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    #ta-log .ta-cmd-body { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11.5px; color:var(--text-color,#cbd5e1); background:var(--background-surface,#141414); border:1px solid var(--border-color,#2a2a2a); border-radius:6px; padding:8px 10px; margin:4px 0 0 20px; white-space:pre-wrap; word-break:break-word; max-height:260px; overflow:auto; }
  </style>
  <script src="/public/js/theme-switcher.js"></script>
<link rel="stylesheet" href="/public/css/build-notifications.css?v=4" />
</head>
<body data-user-id="${user.id}"
  data-user-name="${user.name}"
  data-project-id="${projectId}"
  data-model-key="${modelKey}"
  data-role-key="${roleKey}"
>
  <div class="messages" id="toast-container"></div>

  <div class="app-container">
    <!-- Sidebar -->
    <div class="sidebar" id="sidebar" data-current-project-id="${projectId}">
      <div class="sidebar-top-content">
        <div class="sidebar-header">
          <div class="logo-section">
            <span class="logo-icon">🚀</span>
            <span class="logo-text">LFG</span>
          </div>
          <button id="minimize-btn" class="icon-btn" title="Collapse Sidebar">
            <i class="fas fa-chevron-left"></i>
          </button>
        </div>
        <div class="project-selector-section">
          <div class="project-back-container">
            <a class="project-dropdown-trigger" href="/projects" aria-label="Back to projects" style="text-decoration:none">
              <i class="fas fa-folder-open" aria-hidden="true"></i>
              <span class="project-name-text">Back to projects</span>
            </a>

          </div>
        </div>
        <div class="new-chat-section">
          <a href="/chat/project/${projectId}?new=1" id="new-chat-btn" class="new-chat-link">
            <i class="fas fa-pen-to-square"></i>
            <span class="button-text">New chat</span>
          </a>
        </div>
        <div class="sidebar-nav">
          ${NotificationNav()}
          <a href="/projects/${projectId}" class="nav-link">
            <i class="fas fa-tachometer-alt"></i>
            <span class="nav-text">Dashboard</span>
          </a>
          <a href="/chat/project/${projectId}" class="nav-link chat-link active">
            <i class="fas fa-comments"></i>
            <span class="nav-text">Chat</span>
          </a>
          <a href="/projects/${projectId}/tickets" class="nav-link">
            <i class="fas fa-tasks"></i>
            <span class="nav-text">Tickets</span>
          </a>
          <button type="button" class="nav-link sidebar-more-toggle" aria-expanded="false" aria-controls="sidebar-more-items">
            <i class="fas fa-ellipsis"></i>
            <span class="nav-text">More</span>
            <i class="fas fa-chevron-down sidebar-more-caret nav-text"></i>
          </button>
          <div class="sidebar-more-items" id="sidebar-more-items">
            <a href="/projects/${projectId}/epics" class="nav-link">
              <i class="fas fa-layer-group"></i><span class="nav-text">Epics</span>
            </a>
            <a href="/projects/${projectId}?tab=documents" class="nav-link">
              <i class="fas fa-file-lines"></i><span class="nav-text">Docs</span>
            </a>
            <a href="/projects/${projectId}?tab=inbox" class="nav-link">
              <i class="fas fa-inbox"></i><span class="nav-text">Inbox</span>
            </a>
            <a href="/projects/${projectId}?tab=environment" class="nav-link">
              <i class="fas fa-key"></i><span class="nav-text">Environment</span>
            </a>
          </div>
        </div>
        <div class="conversations-section">
          <h3 class="sidebar-section-title">Recent chats</h3>
          <div id="conversation-list" class="conversation-list">
            <!-- Populated by JS -->
          </div>
        </div>
      </div>
      <div class="sidebar-bottom-content">
        <div class="sidebar-nav bottom-nav">
          <button class="nav-link theme-toggle-sidebar" data-theme-toggle>
            <i class="fas fa-sun theme-icon-light"></i>
            <i class="fas fa-moon theme-icon-dark"></i>
            <span class="nav-text theme-text">Light Mode</span>
          </button>
        </div>
        <div class="user-info" id="user-info">
          <button class="user-info-button" id="user-info-button">
            <div class="user-avatar">
              <div class="avatar-text">${(user.name?.[0] ?? user.email?.[0] ?? "?").toUpperCase()}</div>
            </div>
            <div class="user-details">
              <span class="username">${user.name}</span>
            </div>
            <i class="fas fa-chevron-down dropdown-icon"></i>
          </button>
          <div class="user-dropdown" id="user-dropdown">
            <a href="/settings" class="dropdown-item">
              <i class="fas fa-cog"></i><span>Settings</span>
            </a>
            <div class="dropdown-divider"></div>
            <form method="POST" action="/auth/logout" style="margin:0;">
              <button type="submit" class="dropdown-item" style="width:100%;text-align:left;background:none;border:none;cursor:pointer;">
                <i class="fas fa-sign-out-alt"></i><span>Logout</span>
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>

    <!-- Main Chat Area -->
    <div class="chat-container" style="position:relative;">
      <!-- Workspace controls always remain above the ticket's own header. -->
      <div class="project-header">
        <div class="project-header-content">
          <div class="project-name-container" id="project-name-container">
            <h1 class="project-name" id="project-name-display">${projectName}</h1>
          </div>
          <div class="chat-header-actions">
            <button id="artifacts-button" class="artifacts-button" type="button" title="Toggle workspace panel" aria-label="Toggle workspace panel">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg>
            </button>
          </div>
        </div>
      </div>
      <div class="chat-body">
      <!-- "Chat with ticket" — a FLOATING layer that sticks to the left over the main
           chat (not a replacement). Distinct card (shadow + rounded) with a close button;
           the main chat stays visible at the edges. Right panel keeps the live preview. -->
      <div id="ticket-agent-panel" style="display:none;position:absolute;top:12px;left:12px;bottom:12px;right:12px;z-index:80;background:var(--card-bg,#141414);border:1px solid var(--border-color,#2a2a2a);border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.55);flex-direction:column;overflow:hidden;">
        <div style="display:flex;align-items:center;gap:10px;padding:14px 16px 6px;border-bottom:0;flex:none;background:var(--card-bg,#141414);">
          <i class="fas fa-comments" style="color:#a78bfa;"></i>
          <span id="ta-title" style="font-weight:600;color:var(--text-color,#e2e8f0);font-size:15px;letter-spacing:-.005em;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Ticket</span>
          <button id="ta-exit" type="button" title="Close ticket and return to chat" aria-label="Close ticket and return to chat" style="flex:none;height:32px;padding:0 10px;gap:6px;border-radius:8px;cursor:pointer;background:transparent;color:var(--text-color,#e2e8f0);border:1px solid var(--border-color,#333);display:inline-flex;align-items:center;justify-content:center;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg><span>Close</span></button>
        </div>
        <div id="ta-resize" title="Drag to resize the split" style="position:absolute;top:0;right:-4px;width:10px;height:100%;cursor:ew-resize;z-index:7;"></div>
        <div id="ta-actionbar" style="display:flex;align-items:center;gap:8px;padding:8px 16px 10px;flex:none;border-bottom:0;background:var(--card-bg,#141414);">
          <button id="ta-build" title="Queue this ticket for the coding agent to build" style="height:32px;padding:0 14px;border-radius:8px;cursor:pointer;background:#7c3aed;color:#fff;border:none;font-size:12.5px;font-weight:600;display:inline-flex;align-items:center;gap:7px;"><i class="fas fa-play" style="font-size:10px;"></i>Build</button>
          <button id="ta-stop" title="Stop the agent that is running right now" style="height:32px;padding:0 14px;border-radius:8px;cursor:pointer;background:transparent;color:#f87171;border:1px solid #5a2a30;font-size:12.5px;font-weight:600;display:none;align-items:center;gap:7px;"><i class="fas fa-stop" style="font-size:10px;"></i>Stop</button>
          <button id="ta-edit" title="Edit this ticket" style="height:32px;padding:0 12px;border-radius:8px;cursor:pointer;background:transparent;color:var(--text-color,#cbd5e1);border:1px solid var(--border-color,#333);font-size:12.5px;display:inline-flex;align-items:center;gap:7px;"><i class="fas fa-pen" style="font-size:11px;"></i>Edit</button>
          <button id="ta-preview" title="Open this ticket's branch in the Preview panel (starts it if it isn't running)" style="height:32px;padding:0 12px;border-radius:8px;cursor:pointer;background:transparent;color:var(--text-color,#cbd5e1);border:1px solid var(--border-color,#333);font-size:12.5px;display:inline-flex;align-items:center;gap:7px;"><i class="fas fa-display" style="font-size:11px;"></i>Preview</button>
          <button id="ta-checks" type="button" aria-pressed="false" title="Checks for this ticket" style="height:32px;padding:0 12px;border-radius:999px;cursor:pointer;background:transparent;color:var(--text-color,#cbd5e1);border:1px solid var(--border-color,#333);font-size:12px;display:none;align-items:center;gap:7px;"><span class="ta-checks-dot" style="width:7px;height:7px;border-radius:50%;background:#94a3b8;"></span><span class="ta-checks-label">Checks off</span></button>
          <span style="flex:1;"></span>
          <button id="ta-delete" title="Delete this ticket" style="height:32px;width:34px;border-radius:8px;cursor:pointer;background:transparent;color:#f87171;border:1px solid var(--border-color,#333);font-size:12px;display:inline-flex;align-items:center;justify-content:center;"><i class="fas fa-trash"></i></button>
        </div>
        <style>
          #ta-tabs { display:flex; gap:2px; padding:0 12px; flex:none; border-bottom:1px solid var(--border-color,#2a2a2a); background:var(--card-bg,#141414); }
          .ta-tab { padding:9px 13px; border:none; background:transparent; color:var(--text-secondary,#9ca3af); font-size:12.5px; font-weight:500; cursor:pointer; border-bottom:2px solid transparent; margin-bottom:-1px; display:inline-flex; align-items:center; gap:6px; }
          .ta-tab:hover { color:var(--text-color,#e2e8f0); }
          .ta-tab.active { color:#a78bfa; border-bottom-color:#a78bfa; }
          .ta-tab .ta-tab-count { font-size:10px; font-weight:600; padding:0 6px; border-radius:999px; background:var(--border-color,#2a2a2a); color:var(--text-secondary,#9ca3af); }
        </style>
        <div id="ta-tabs">
          <button class="ta-tab" data-ta-tab="details">Details</button>
          <button class="ta-tab" data-ta-tab="actions">Actions</button>
          <button class="ta-tab" data-ta-tab="tasks">Tasks</button>
          <button class="ta-tab" data-ta-tab="git">Git</button>
        </div>
        <div id="ta-pane-details" class="ta-pane" style="flex:1;min-height:0;overflow:auto;padding:16px;display:none;"></div>
        <div id="ta-log" class="ta-pane" style="flex:1;min-height:0;overflow:auto;padding:16px;display:none;flex-direction:column;gap:10px;"></div>
        <div id="ta-pane-tasks" class="ta-pane" style="flex:1;min-height:0;overflow:auto;padding:14px 16px;display:none;"></div>
        <div id="ta-pane-git" class="ta-pane" style="flex:1;min-height:0;overflow:auto;padding:0;display:none;"></div>
        <div id="ta-input-row" style="flex:none;padding:12px 16px;border-top:1px solid var(--border-color,#2a2a2a);display:flex;flex-direction:column;gap:6px;">
          <div id="ta-attach-chip" style="display:none;font-size:12px;color:var(--text-secondary,#9ca3af);align-items:center;gap:6px;"></div>
          <div style="display:flex;gap:8px;align-items:center;">
            <input id="ta-file" type="file" accept="image/*" multiple style="display:none;" />
            <button id="ta-attach" title="Attach image(s) for the agent — you can pick several" style="width:40px;height:40px;border-radius:10px;background:transparent;color:var(--text-secondary,#9ca3af);border:1px solid var(--border-color,#333);cursor:pointer;flex:none;"><i class="fas fa-paperclip"></i></button>
            <input id="ta-input" type="text" placeholder="Send a message to the agent…" style="flex:1;height:40px;padding:0 14px;border-radius:10px;background:var(--card-bg,#161616);color:var(--text-color,#e2e8f0);border:1px solid var(--border-color,#333);font-size:13.5px;" />
            <button id="ta-send" title="Send" style="width:40px;height:40px;border-radius:10px;background:#7c3aed;color:#fff;border:none;cursor:pointer;flex:none;"><i class="fas fa-arrow-up"></i></button>
          </div>
        </div>
      </div>
      <!-- Messages -->
      <div class="chat-messages" id="chat-messages">
        <div class="message-container">
          ${!conversationId ? html`<div class="welcome-message">
            <h2>LFG 🚀</h2>
            <p>Start a conversation with the AI assistant below.</p>
          </div>` : html`<div class="loading-messages" style="text-align:center;padding:2rem;opacity:0.5;">Loading conversation...</div>`}
        </div>
      </div>

      <!-- Input Area -->
      ${ChatInput({
        placeholder: "Type your message here...",
        models,
        selectedModelKey: modelKey,
        selectedRoleKey: roleKey,
        roleOptions: [{ key: "product_analyst", label: "Analyst" }],
        showTurboToggle: false,
        turboEnabled: false,
        showMic: true,
      })}
      </div>
    </div>
  </div>

  <!-- Artifacts / document panel -->
  <div class="artifacts-container" id="artifacts-panel">
    <div class="resize-handle" id="resize-handle"></div>
    <div class="artifacts-accent-bar"></div>

    <!-- Tabs Navigation — tabs that don't fit collapse into the ⋯ menu (tab-overflow.js) -->
    <div class="artifacts-tabs artifacts-tabs-managed" style="display:flex;justify-content:space-between;align-items:center;">
      <div class="artifacts-tabs-list" id="artifacts-tabs-list">
        <button class="tab-button active" data-tab="filebrowser">Docs</button>
        <button class="tab-button" data-tab="checklist">Tickets</button>
        <button class="tab-button" data-tab="preview">Preview</button>
        <button class="tab-button" data-tab="env">Env</button>
      </div>
      <div class="tab-overflow" id="tab-overflow">
        <button class="tab-overflow-btn" id="tab-overflow-btn" title="More tabs" aria-haspopup="true" aria-expanded="false">
          <i class="fas fa-ellipsis"></i>
        </button>
        <div class="tab-overflow-menu" id="tab-overflow-menu" hidden></div>
      </div>
      <button class="panel-arrow-right" id="artifacts-toggle" style="margin-left:auto;padding:8px;background:none;border:none;color:#ccc;cursor:pointer;">
        <i class="fas fa-chevron-right"></i>
      </button>
    </div>

    <div class="artifacts-content">
      <div class="tab-content">

        <!-- Checklist Tab -->
        <div class="tab-pane" id="checklist">
          <div class="empty-state">
            <div class="empty-state-icon"><i class="fas fa-check-square"></i></div>
            <div class="empty-state-text">No checklist items created yet.</div>
          </div>
        </div>

        <!-- Preview Tab — run the connected project live in its sandbox -->
        <div class="tab-pane" id="preview">
          <div id="preview-root" data-project-id="${projectId}" style="height:100%;display:flex;flex-direction:column;">
            <div class="preview-header" style="padding:14px 20px;border-bottom:1px solid var(--border-color,#2a2a2a);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:nowrap;">
              <!-- flex:none — the title block is short and fixed. Letting it SHRINK is what
                   chopped the status line mid-word ("Live · (defa…") whenever the toolbar
                   got busy; the toolbar absorbs the squeeze instead (its chips scroll). -->
              <div style="display:flex;flex-direction:column;gap:2px;flex:none;overflow:hidden;">
                <div style="display:flex;align-items:center;gap:12px;">
                  <h3 style="color:var(--text-color,#e2e8f0);margin:0;font-size:16px;font-weight:600;white-space:nowrap;">Preview</h3>
                  <!-- "Chat with ticket" sits on the SAME line as the title (rendered here by preview-tab.js). -->
                  <div id="preview-left-actions" style="display:flex;gap:6px;align-items:center;flex:none;"></div>
                </div>
                <span id="preview-substatus" style="color:var(--text-secondary,#9ca3af);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px;">Loading…</span>
              </div>
              <div style="display:flex;gap:6px;align-items:center;flex-wrap:nowrap;justify-content:flex-end;flex:1 1 auto;min-width:0;">
                <!-- Profile moved into the ⋮ overflow menu (rendered by preview-tab.js). -->
                <button id="preview-plan-btn" style="display:none;"></button>
                <!-- The running toolbar switches itself to nowrap + a scrolling chip strip
                     (see ensureToolbarStyles in preview-tab.js); other views still wrap. -->
                <div id="preview-actions" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end;min-width:0;flex:1 1 auto;"></div>
              </div>
            </div>
            <div id="preview-body" style="flex:1;min-height:0;position:relative;overflow:hidden;">
              <!-- states rendered by preview-tab.js -->
            </div>
          </div>
        </div>

        <!-- Env Tab — the project's environment variables. Values are write-only:
             the API never returns them, so the list only shows whether a key is set. -->
        <div class="tab-pane" id="env">
          <div class="env-panel" id="env-root" data-project-id="${projectId}">
            <div class="env-panel-head">
              <div class="env-head-row">
                <div style="min-width:0;">
                  <h3 class="env-title">Environment Variables</h3>
                  <div class="env-sub" id="env-count">Loading…</div>
                </div>
                <div class="env-head-actions">
                  <button id="env-reveal-all" class="env-mini" title="Show every stored value"><i class="fas fa-eye"></i> Show values</button>
                  <label class="env-mini" title="Bulk-import KEY=VALUE lines from a .env file">
                    <i class="fas fa-arrow-up-from-bracket"></i> Upload .env
                    <input id="env-file" type="file" accept=".env,.txt,text/plain" hidden />
                  </label>
                  <button id="env-refresh" class="env-mini" title="Refresh"><i class="fas fa-rotate-right"></i></button>
                </div>
              </div>
              <div class="env-add-row">
                <input id="env-new-key" class="env-input env-input-key" placeholder="KEY" spellcheck="false" />
                <input id="env-new-value" class="env-input" placeholder="value" spellcheck="false" />
                <input id="env-new-desc" class="env-input" placeholder="description (optional)" />
                <button id="env-add-btn" class="env-mini env-mini-primary">Add</button>
              </div>
              <div class="env-msg" id="env-msg" hidden></div>
            </div>
            <div class="env-list" id="env-list"></div>
          </div>
        </div>

        <!-- File Browser Tab (active) -->
        <div class="tab-pane active" id="filebrowser">
          <div class="filebrowser-container" style="height:92%;display:flex;flex-direction:column;">
            <!-- Browser View -->
            <div id="filebrowser-main" style="height:100%;display:flex;flex-direction:column;">
              <div class="filebrowser-header">
                <div class="filebrowser-title-row">
                  <div><h3>Documents</h3><span class="filebrowser-subtitle">Grouped by epic · Newest first</span></div>
                  <button id="refresh-filebrowser" type="button" aria-label="Refresh documents" title="Refresh documents"><i class="fas fa-sync-alt" aria-hidden="true"></i></button>
                </div>
                <div class="filebrowser-toolbar">
                  <label class="filebrowser-search"><i class="fas fa-search" aria-hidden="true"></i><input type="search" id="file-search" placeholder="Search documents…" aria-label="Search documents" /></label>
                  <select id="file-type-filter" aria-label="Filter document type"><option value="">All types</option></select>
                  <select id="file-epic-filter" aria-label="Filter epic"><option value="">All epics</option></select>
                </div>
              </div>
              <div class="filebrowser-content" style="flex:1;overflow-y:auto;">
                <div id="file-table-header" style="display:none;"></div>
                <div class="loading-state" id="filebrowser-loading" style="text-align:center;padding:60px;display:none;">
                  <div class="spinner"></div>
                  <div style="margin-top:10px;color:#9ca3af;">Loading documents...</div>
                </div>
                <div class="empty-state" id="filebrowser-empty">
                  <div class="empty-state-icon"><i class="fas fa-folder-open"></i></div>
                  <div class="empty-state-text">No documents found in this project.</div>
                </div>
                <div id="filebrowser-list"></div>
                <div id="filebrowser-pagination" style="display:none;"></div>
              </div>
            </div>
            <!-- File Viewer (hidden by default) -->
            <div id="filebrowser-viewer" style="height:100%;display:none;flex-direction:column;">
              <div class="viewer-header">
                <div class="viewer-title-container">
                  <button id="viewer-back" class="viewer-back"><i class="fas fa-arrow-left"></i></button>
                  <h3 id="viewer-title"></h3>
                </div>
                <div id="viewer-actions" class="viewer-actions"></div>
              </div>
              <div class="viewer-content" style="flex:1;overflow-y:auto;">
                <div id="viewer-markdown" class="prd-content markdown-content" style="padding:20px;color:#e2e8f0;"></div>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  </div>

  <!-- Connectors Modal -->
  <div class="connectors-overlay" id="connectors-overlay">
    <div class="connectors-modal">
      <div class="connectors-header">
        <h3>Connectors</h3>
        <div class="connectors-search-wrap">
          <i class="fas fa-search"></i>
          <input type="text" id="connectors-search" placeholder="Search connectors..." />
        </div>
        <button class="connectors-close" id="connectors-close">&#215;</button>
      </div>
      <p class="connectors-subtitle">Connect your apps and services so the AI can access and act on your data.</p>
      <div class="connectors-tabs">
        <button class="connectors-tab active" data-filter="all">All</button>
        <button class="connectors-tab" data-filter="connected">Connected</button>
        <button class="connectors-tab" data-filter="available">Available</button>
      </div>
      <div id="connectors-grid" class="connectors-grid">
        <div class="connectors-loading">Loading connectors...</div>
      </div>
      <div id="connectors-load-more" style="display:none;text-align:center;padding:1rem;">
        <button class="connectors-load-more-btn">Load more</button>
      </div>
    </div>
  </div>

  <!-- Connector Detail Modal -->
  <div class="connector-detail-overlay" id="connector-detail-overlay">
    <div class="connector-detail-modal">
      <button class="connectors-close" id="connector-detail-close">&#215;</button>
      <div class="connector-detail-header">
        <img id="connector-detail-logo" src="" alt="" class="connector-detail-logo" />
        <div>
          <h3 id="connector-detail-name"></h3>
          <p id="connector-detail-desc"></p>
        </div>
        <button id="connector-detail-action" class="connector-detail-action-btn">Add connector</button>
      </div>
    </div>
  </div>

  <!-- JS (same files as Django, just /public/ paths) -->
  <div id="server-data"
       data-user-id="${user.id}"
       data-conversation-id="${conversationId ?? ""}"
       style="display:none;"></div>
  <script>
    // Override WS path — Bun uses /ws/chat (no trailing slash needed)
    window.__WS_PATH__ = '/ws/chat';
  </script>
  <script src="/public/js/marked.min.js"></script>
  <script src="/public/js/markdown-config.js?v=20261019-readable-layout"></script>
  <!-- PDF libraries load on demand when exporting a document. -->
  <script src="/public/js/design-preview.js"></script>
  <script src="/public/js/artifacts-loader.js?v=20261015-map-groups"></script>
  <script src="/public/js/document-comments.js"></script>
  <script src="/public/js/artifacts.js"></script>
  <link rel="stylesheet" href="/public/css/ticket-action-phases.css?v=20261021-skip-checks" />
<script src="/public/js/ticket-action-phases.js?v=20261021-log-pages"></script>
<script src="/public/js/preview-tab.js?v=20261005-start-state"></script>
    <script src="/public/js/ticket-agent.js?v=20261021-action-rows"></script>
  <script src="/public/js/env-tab.js?v=20261004-env-apply"></script>
  <script src="/public/js/tab-overflow.js"></script>
  <script src="/public/js/sidebar.js?v=20261016-project-notifications"></script>
  <script src="/public/js/custom-dropdown.js"></script>
  <script src="/public/js/dictation.js?v=20261021-inline-strip"></script>
  <script src="/public/js/chat-artifacts.js?v=20261020-one-card"></script>
  <script src="/public/js/chatgpt-connection.js?v=20261018"></script>
  <script src="/public/js/chat.js?v=20261021-resume-page"></script>
  <script src="/public/js/voice-mode.js?v=20261016-voice-hidden" data-disabled="true"></script>
  <script src="/public/js/mobile-menu.js"></script>

  <script>
    // Model selector: wire up submenu clicks → POST /api/settings/model
    document.querySelectorAll('#model-submenu .submenu-option').forEach(btn => {
      btn.addEventListener('click', async () => {
        const key = btn.dataset.value;
        const response = await fetch('/api/settings/model', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelKey: key, projectId: document.body.dataset.projectId }),
          credentials: 'include',
        });
        if (!response.ok) { const error = await response.json(); alert(error.error || 'Could not change model'); return; }
        document.querySelectorAll('#model-submenu .submenu-option').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        document.getElementById('current-model-left').textContent = btn.dataset.label || btn.querySelector('span').textContent.trim();
      });
    });

    // Set initial model label
    const selectedModelBtn = document.querySelector('#model-submenu .submenu-option.selected');
    if (selectedModelBtn) {
      document.getElementById('current-model-left').textContent = selectedModelBtn.dataset.label || selectedModelBtn.querySelector('span').textContent.trim();
    }

    // Artifacts panel toggle is handled by artifacts.js (uses #artifacts-toggle and #resize-handle)
    
  </script>

  <script src="/public/js/connectors.js"></script>
</body>
</html>`;
}
