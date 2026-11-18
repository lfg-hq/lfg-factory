import { NotificationNav } from "../components/notification-nav.tsx";
import { html } from "hono/html";

/**
 * MEETINGS: add the LFG agent to a call, and see every call it was in.
 *
 * Paste a Google Meet link and the agent joins as a participant (a browser this server runs).
 * It takes notes from the live captions, and when someone says "Hey LFG, ..." it does the work
 * and answers in the meeting chat. Each call has a chat conversation holding what the agent
 * did and its recap.
 *
 * The page's behaviour lives in /public/js/meetings.js, not inline: inline scripts in these
 * templates break on ordinary JS escapes.
 */
interface Props {
  project: { id: string; projectId: string; name: string; icon?: string | null };
  user: { name: string; email?: string };
  /** Why the agent cannot join calls on this server, shown instead of the form. */
  setupProblem?: string | null;
  botName?: string;
}

export function MeetingsPage({ project, user, setupProblem, botName = "LFG" }: Props) {
  const avatarLetter = (user.name || "U").charAt(0).toUpperCase();
  return html`<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/x-icon" href="/public/images/favicon.ico" />
  <title>${project.name} Meetings — LFG</title>
  <script>(function(){if(localStorage.getItem('sidebarMinimized')==='true'){document.documentElement.classList.add('sidebar-minimized-preload');}})()</script>
  <link rel="stylesheet" href="/public/css/theme-variables.css" />
  <link rel="stylesheet" href="/public/css/common.css" />
  <link rel="stylesheet" href="/public/css/sidebar.css?v=20261118-calm" />
  <link rel="stylesheet" href="/public/css/polish.css" />
  <link rel="stylesheet" href="/public/css/light/light-mode.css" />
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css" />
  <script src="/public/js/theme-switcher.js"></script>
  <style>
    /* .sidebar is position:fixed, so the page offsets itself past it (same as the other project pages). */
    .meetings-page { flex: 1; height: 100vh; overflow-y: auto; margin-left: 260px; }
    .app-container.sidebar-minimized .meetings-page { margin-left: 60px; }
    .sidebar-minimized-preload .meetings-page,
    .sidebar-minimized-init .meetings-page { margin-left: 60px !important; transition: none !important; }
    .meetings-inner { max-width: 860px; margin: 0 auto; padding: 1.5rem 1.5rem 4rem; }
    .meetings-inner h1 { font-size: 1.25rem; font-weight: 700; margin: 0 0 0.35rem; color: var(--text-color); }
    .meetings-lead { color: var(--text-secondary); font-size: 0.88rem; line-height: 1.5; margin: 0 0 1.1rem; }
    .meeting-add { display: flex; gap: 0.6rem; flex-wrap: wrap; }
    .meeting-add .input { flex: 1; min-width: 240px; }
    .meeting-note { font-size: 0.82rem; margin: 0.6rem 0 0; min-height: 1.2em; color: var(--text-secondary); }
    .meeting-note.error { color: #ef4444; }
    .meeting-setup { border: 1px solid var(--border-color); border-radius: 10px; padding: 0.85rem 1rem; font-size: 0.86rem; color: var(--text-color); line-height: 1.5; }
    .meeting-list { margin-top: 1.75rem; }
    .meeting-list h2 { font-size: 0.68rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-secondary); margin: 0 0 0.4rem; }
    .meeting-row { border-bottom: 1px solid var(--border-color); padding: 0.85rem 0; }
    .meeting-top { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
    .meeting-title { font-weight: 650; font-size: 0.92rem; color: var(--text-color); flex: 1; min-width: 160px; }
    .meeting-meta { font-size: 0.78rem; color: var(--text-secondary); margin-top: 0.25rem; }
    .meeting-pill { font-size: 0.66rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; padding: 2px 7px; border-radius: 5px; border: 1px solid; white-space: nowrap; }
    .meeting-pill[data-status="in_call"] { color: #10b981; }
    .meeting-pill[data-status="joining"], .meeting-pill[data-status="waiting_room"] { color: #f59e0b; }
    .meeting-pill[data-status="ended"] { color: #94a3b8; }
    .meeting-pill[data-status="failed"] { color: #ef4444; }
    .meeting-actions { display: flex; gap: 0.4rem; flex-wrap: wrap; }
    .meeting-actions .btn { padding: 0.3rem 0.65rem; font-size: 0.78rem; }
    .meeting-transcript { margin-top: 0.7rem; max-height: 340px; overflow-y: auto; border: 1px solid var(--border-color); border-radius: 10px; padding: 0.7rem 0.9rem; font-size: 0.84rem; line-height: 1.5; }
    .meeting-transcript[hidden] { display: none; }
    .meeting-line { margin: 0 0 0.45rem; color: var(--text-color); overflow-wrap: anywhere; }
    .meeting-line b { font-weight: 650; }
    .meeting-line[data-kind="agent"] b { color: var(--primary-color, #8b5cf6); }
    .meeting-line[data-kind="chat"] { color: var(--text-secondary); }
    .meetings-empty { color: var(--text-secondary); font-size: 0.86rem; padding: 0.6rem 0; }
    @media (max-width: 768px) { .meetings-page { margin-left: 0; } }
  </style>
  <link rel="stylesheet" href="/public/css/build-notifications.css?v=4" />
  <link rel="stylesheet" href="/public/css/calm.css?v=2" />
</head>
<body>
  <div class="app-container">
    <div class="sidebar" id="sidebar" data-current-project-id="${project.projectId}">
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
        <a href="/chat/project/${project.projectId}?new=1" id="new-chat-btn" class="new-chat-link">
          <i class="fas fa-pen-to-square"></i>
          <span class="button-text">New chat</span>
        </a>
      </div>
      <div class="sidebar-nav">
          ${NotificationNav()}
        <a href="/projects/${project.projectId}" class="nav-link">
          <i class="fas fa-tachometer-alt"></i><span class="nav-text">Dashboard</span>
        </a>
        <a href="/chat/project/${project.projectId}" class="nav-link">
          <i class="fas fa-comments"></i>
          <span class="nav-text">Chat</span>
        </a>
        <a href="/projects/${project.projectId}/tickets" class="nav-link">
          <i class="fas fa-tasks"></i>
          <span class="nav-text">Tickets</span>
        </a>
        <a href="/projects/${project.projectId}/whiteboards" class="nav-link">
          <i class="fas fa-chalkboard"></i>
          <span class="nav-text">Whiteboards</span>
        </a>
        <button type="button" class="nav-link sidebar-more-toggle" aria-expanded="false" aria-controls="sidebar-more-items">
          <i class="fas fa-ellipsis"></i>
          <span class="nav-text">More</span>
          <i class="fas fa-chevron-down sidebar-more-caret nav-text"></i>
        </button>
        <div class="sidebar-more-items" id="sidebar-more-items">
          <a href="/projects/${project.projectId}/epics" class="nav-link">
            <i class="fas fa-layer-group"></i><span class="nav-text">Epics</span>
          </a>
          <a href="/projects/${project.projectId}/meetings" class="nav-link active">
            <i class="fas fa-video"></i><span class="nav-text">Meetings</span>
          </a>
          <a href="/projects/${project.projectId}?tab=documents" class="nav-link">
            <i class="fas fa-file-lines"></i><span class="nav-text">Docs</span>
          </a>
          <a href="/projects/${project.projectId}?tab=inbox" class="nav-link">
            <i class="fas fa-inbox"></i><span class="nav-text">Inbox</span>
          </a>
          <a href="/projects/${project.projectId}?tab=environment" class="nav-link">
            <i class="fas fa-key"></i><span class="nav-text">Environment</span>
          </a>
        </div>
      </div>
        <div class="conversations-section" data-sidebar-chats data-project="${project.projectId}">
          <h3 class="sidebar-section-title">Recent chats</h3>
          <div id="conversation-list" class="conversation-list">
            <!-- Populated by /public/js/sidebar-chats.js -->
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
          <div class="user-avatar"><div class="avatar-text">${avatarLetter}</div></div>
          <div class="user-details"><span class="username">${user.name}</span></div>
          <i class="fas fa-chevron-down dropdown-icon"></i>
        </button>
        <div class="user-dropdown" id="user-dropdown">
          <a href="/settings" class="dropdown-item"><i class="fas fa-cog"></i><span>Settings</span></a>
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

  <div class="meetings-page" id="meetings-page" data-project="${project.projectId}" data-bot="${botName}">
    <div class="meetings-inner">
      <h1>Meetings</h1>
      <p class="meetings-lead">Add ${botName} to a Google Meet call and it joins as a participant, takes notes on what is said and can look at a shared screen. Say <b>"Hey agent, create a PRD on what we just discussed"</b>, or type <b>@${botName} how many tickets are pending?</b> in the meeting chat, and it does the work and answers in the meeting chat. Everything it does lands in a chat for that meeting, with a recap when the call ends. It joins from LFG's own Google account, so someone in the call admits it; if your company's Google Workspace blocks people from outside it, allow external participants for the meeting first.</p>
      ${setupProblem ? html`<div class="meeting-setup" role="status">${setupProblem}</div>` : html`
      <form class="meeting-add" id="meeting-add">
        <input class="input" id="meeting-url" type="url" required placeholder="Paste a Google Meet link" aria-label="Meeting link" autocomplete="off" />
        <button class="btn btn-primary" type="submit" id="meeting-add-btn"><i class="fas fa-video" aria-hidden="true"></i> Add ${botName} to call</button>
      </form>`}
      <p class="meeting-note" id="meeting-note" role="status"></p>
      <div class="meeting-list">
        <h2>Calls</h2>
        <div id="meeting-rows"><div class="meetings-empty">Loading…</div></div>
      </div>
    </div>
  </div>
  </div>
<script src="/public/js/sidebar.js?v=20261118-peek"></script>
<script src="/public/js/sidebar-chats.js"></script>
<script src="/public/js/meetings.js?v=20261116"></script>
<script>
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.documentElement.classList.remove('sidebar-minimized-preload');
  }));
</script>
</body>
</html>`;
}
