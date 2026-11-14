import { NotificationNav } from "../components/notification-nav.tsx";
import { html } from "hono/html";

/**
 * WHITEBOARDS: the boards of a project. Each card opens the full-screen canvas
 * (whiteboard.tsx). Behaviour lives in /public/js/whiteboards.js, not inline: inline scripts
 * in these templates break on ordinary JS escapes.
 */
interface Props {
  project: { id: string; projectId: string; name: string; icon?: string | null };
  user: { name: string; email?: string };
  canEdit: boolean;
}

export function WhiteboardsPage({ project, user, canEdit }: Props) {
  const avatarLetter = (user.name || "U").charAt(0).toUpperCase();
  return html`<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/x-icon" href="/public/images/favicon.ico" />
  <title>${project.name} Whiteboards — LFG</title>
  <script>(function(){if(localStorage.getItem('sidebarMinimized')==='true'){document.documentElement.classList.add('sidebar-minimized-preload');}})()</script>
  <link rel="stylesheet" href="/public/css/theme-variables.css" />
  <link rel="stylesheet" href="/public/css/common.css" />
  <link rel="stylesheet" href="/public/css/sidebar.css?v=20260908-startup" />
  <link rel="stylesheet" href="/public/css/polish.css" />
  <link rel="stylesheet" href="/public/css/light/light-mode.css" />
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css" />
  <script src="/public/js/theme-switcher.js"></script>
  <style>
    /* .sidebar is position:fixed, so the page offsets itself past it (same as the other project pages). */
    .boards-page { flex: 1; height: 100vh; overflow-y: auto; margin-left: 260px; }
    .app-container.sidebar-minimized .boards-page { margin-left: 60px; }
    .sidebar-minimized-preload .boards-page,
    .sidebar-minimized-init .boards-page { margin-left: 60px !important; transition: none !important; }
    .boards-inner { max-width: 1040px; margin: 0 auto; padding: 1.5rem 1.5rem 4rem; }
    .boards-head { display: flex; align-items: flex-start; gap: 1rem; flex-wrap: wrap; }
    .boards-head > div { flex: 1; min-width: 240px; }
    .boards-inner h1 { font-size: 1.25rem; font-weight: 700; margin: 0 0 0.35rem; color: var(--text-color); }
    .boards-lead { color: var(--text-secondary); font-size: 0.88rem; line-height: 1.5; margin: 0; max-width: 620px; }
    .boards-note { font-size: 0.82rem; margin: 0.6rem 0 0; min-height: 1.2em; color: #ef4444; }
    .boards-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 1rem; margin-top: 1.25rem; }
    .board-card { position: relative; display: flex; flex-direction: column; border: 1px solid var(--border-color); border-radius: 12px; overflow: hidden; background: var(--card-bg); text-decoration: none; color: var(--text-color); transition: transform 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease; }
    .board-card:hover { transform: translateY(-2px); border-color: var(--primary-color, #8b5cf6); box-shadow: 0 8px 22px rgba(0, 0, 0, 0.18); }
    .board-thumb { height: 120px; background-image: radial-gradient(var(--border-color) 1px, transparent 1px); background-size: 16px 16px; display: flex; align-items: center; justify-content: center; color: var(--text-secondary); font-size: 1.6rem; }
    .board-new { border-style: dashed; cursor: pointer; font: inherit; text-align: left; padding: 0; }
    .board-new .board-thumb { color: var(--primary-color, #8b5cf6); }
    .board-meta { padding: 0.7rem 0.85rem 0.8rem; border-top: 1px solid var(--border-color); }
    .board-title { font-weight: 650; font-size: 0.9rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 1.6rem; }
    .board-sub { font-size: 0.76rem; color: var(--text-secondary); margin-top: 0.2rem; }
    .board-delete { position: absolute; right: 0.5rem; bottom: 0.7rem; background: none; border: none; color: var(--text-secondary); cursor: pointer; padding: 0.3rem; border-radius: 6px; opacity: 0; transition: opacity 0.15s ease; }
    .board-card:hover .board-delete, .board-delete:focus-visible { opacity: 1; }
    .board-delete:hover { color: #ef4444; }
    .boards-empty { color: var(--text-secondary); font-size: 0.86rem; padding: 0.6rem 0; }
    @media (max-width: 768px) { .boards-page { margin-left: 0; } }
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
        <a href="/projects/${project.projectId}/whiteboards" class="nav-link active">
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
          <a href="/projects/${project.projectId}/meetings" class="nav-link">
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

  <div class="boards-page" id="boards-page" data-project="${project.projectId}" data-can-edit="${canEdit ? "true" : "false"}">
    <div class="boards-inner">
      <div class="boards-head">
        <div>
          <h1>Whiteboards</h1>
          <p class="boards-lead">An open canvas for brainstorming with your team and clients: draw, drop notes, sketch screens and map flows. Open the chat on any board and LFG lays out ideas, feature previews and diagrams for you.</p>
        </div>
        ${canEdit ? html`<button class="btn btn-primary" type="button" id="board-new-btn"><i class="fas fa-plus" aria-hidden="true"></i> New board</button>` : ""}
      </div>
      <p class="boards-note" id="boards-note" role="status"></p>
      <div class="boards-grid" id="boards-grid"><div class="boards-empty">Loading…</div></div>
    </div>
  </div>
  </div>
<script src="/public/js/sidebar.js?v=20261016-project-notifications"></script>
<script src="/public/js/sidebar-chats.js"></script>
<script src="/public/js/whiteboards.js?v=20261114"></script>
<script>
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.documentElement.classList.remove('sidebar-minimized-preload');
  }));
</script>
</body>
</html>`;
}
