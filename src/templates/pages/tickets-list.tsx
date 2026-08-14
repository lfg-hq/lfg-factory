import { html, raw } from "hono/html";

interface TicketStage {
  id: string;
  name: string;
  color: string;
  order: number;
  isCompleted: boolean;
}

interface Ticket {
  id: string;
  ticketKey: string | null;
  name: string;
  status: string;
  priority: string;
  stageId: string | null;
  complexity: string;
  queueStatus: string;
  description: string;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

interface ExecutionModeConfig {
  claudeCodeEnabled: boolean;
  builderModelKey: string;
  models: Array<{ key: string; label: string; provider: string }>;
}

interface TicketsListPageProps {
  user: { id: string; name: string; email?: string };
  project: { id: string; projectId: string; name: string; icon: string; ticketBuildIsolation?: string; previewBranchMode?: string };
  stages: TicketStage[];
  tickets: Ticket[];
  executionMode?: ExecutionModeConfig;
}

const PRIORITY_COLOR: Record<string, string> = {
  High: "#ef4444",
  Medium: "#f59e0b",
  Low: "#6b7280",
};

export function TicketsListPage({ user, project, stages, tickets, executionMode }: TicketsListPageProps) {
  const isApiMode = executionMode ? !executionMode.claudeCodeEnabled : true;
  const avatarLetter = (user.name?.[0] ?? user.email?.[0] ?? "?").toUpperCase();

  // Group tickets by stage — unstaged tickets go into Backlog (first stage)
  const byStage: Record<string, Ticket[]> = {};
  for (const s of stages) byStage[s.id] = [];
  const backlogStage = stages.find((s) => s.name === "Backlog") ?? stages[0];
  for (const t of tickets) {
    if (t.stageId && byStage[t.stageId] !== undefined) {
      (byStage[t.stageId] as Ticket[]).push(t);
    } else if (backlogStage) {
      (byStage[backlogStage.id] as Ticket[]).push(t);
    }
  }

  return html`<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/x-icon" href="/public/images/favicon.ico" />
  <title>${project.name} Tickets — LFG</title>
  <script>(function(){if(localStorage.getItem('sidebarMinimized')==='true'){document.documentElement.classList.add('sidebar-minimized-preload');}})()</script>
  <link rel="stylesheet" href="/public/css/theme-variables.css" />
  <link rel="stylesheet" href="/public/css/common.css" />
  <link rel="stylesheet" href="/public/css/sidebar.css" />
  <link rel="stylesheet" href="/public/css/tickets.css" />
  <link rel="stylesheet" href="/public/css/polish.css" />
  <link rel="stylesheet" href="/public/css/light/light-mode.css" />
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css" />
  <script src="/public/js/theme-switcher.js"></script>
  <script src="/public/js/marked.min.js"></script>
  <style>
    /* Layout overrides — not in tickets.css */
    .tickets-page { height: 100vh; overflow: hidden; display: flex; flex-direction: column; }
    .tickets-toolbar {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.625rem 1.25rem;
      border-bottom: 1px solid var(--border-color);
      background: var(--background-color, #121212);
      flex-shrink: 0;
    }
    .tickets-toolbar .filter-search { min-width: 180px; }
    .toolbar-spacer { flex: 1; }
    .toolbar-btn-new {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.4rem 1rem;
      font-size: 0.8125rem;
      font-weight: 600;
      border-radius: 999px;
      border: none;
      background: linear-gradient(135deg, #7c3aed, #8b5cf6);
      /* !important: beats the global [data-theme="light"] a { color:#7c3aed }
         which otherwise makes this purple-on-purple / invisible in light mode. */
      color: #fff !important;
      cursor: pointer;
      text-decoration: none;
      white-space: nowrap;
      box-shadow: 0 4px 12px rgba(124,58,237,0.35);
      transition: opacity 0.2s ease;
    }
    .toolbar-btn-new:hover { opacity: 0.88; }

    /* Execution mode toggle */
    .exec-mode-toggle {
      display: inline-flex;
      align-items: center;
      gap: 0;
      border-radius: 999px;
      border: 1px solid var(--border-color);
      background: var(--input-bg);
      overflow: hidden;
    }
    .exec-mode-btn {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.3rem 0.75rem;
      font-size: 0.75rem;
      font-weight: 500;
      border: none;
      background: transparent;
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.2s ease;
      white-space: nowrap;
    }
    .exec-mode-btn.active {
      background: linear-gradient(135deg, #7c3aed, #8b5cf6);
      color: white;
      box-shadow: 0 2px 8px rgba(124,58,237,0.3);
    }
    .exec-mode-btn:hover:not(.active) { background: var(--card-bg-hover); }

    .builder-model-select {
      padding: 0.3rem 1.7rem 0.3rem 0.6rem; /* extra right pad so the native chevron doesn't overlap the text */
      font-size: 0.75rem;
      border-radius: 6px;
      border: 1px solid var(--border-color);
      background: var(--input-bg);
      color: var(--text-color);
      cursor: pointer;
      max-width: 190px;
      text-overflow: ellipsis;
    }
    .builder-model-select:focus { outline: 1px solid #7c3aed; }
    /* Build & preview settings popover (declutters the toolbar) */
    .build-settings-menu { position: relative; }
    .build-settings-btn {
      width: 34px; height: 34px; border-radius: 8px;
      border: 1px solid var(--border-color); background: var(--input-bg);
      color: var(--text-secondary); cursor: pointer; display: inline-flex;
      align-items: center; justify-content: center; font-size: 0.85rem;
    }
    .build-settings-btn:hover { color: var(--text-color); border-color: #7c3aed; }
    .build-settings-dropdown {
      display: none; position: absolute; right: 0; top: calc(100% + 6px);
      z-index: 40; min-width: 240px; padding: 10px 12px; border-radius: 10px;
      background: var(--card-bg, #16161a); border: 1px solid var(--border-color);
      box-shadow: 0 10px 30px rgba(0,0,0,.4);
    }
    .build-settings-dropdown.open { display: block; }
    .build-settings-dropdown .bs-title { font-size: 0.7rem; text-transform: uppercase; letter-spacing: .5px; color: var(--text-secondary); margin-bottom: 8px; }
    .build-settings-dropdown .bs-row { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; font-size: 0.72rem; color: var(--text-secondary); }
    .build-settings-dropdown .bs-row:last-child { margin-bottom: 0; }
    .build-settings-dropdown .bs-row select {
      padding: 0.35rem 1.7rem 0.35rem 0.5rem; font-size: 0.78rem; border-radius: 6px;
      border: 1px solid var(--border-color); background: var(--input-bg); color: var(--text-color); cursor: pointer;
    }
    /* Create-ticket modal */
    .create-ticket-overlay {
      display: none; position: fixed; inset: 0; z-index: 200;
      background: rgba(0,0,0,.55); align-items: flex-start; justify-content: center; padding: 8vh 1rem;
    }
    .create-ticket-overlay.open { display: flex; }
    .create-ticket-modal {
      width: 100%; max-width: 560px; background: var(--card-bg, #16161a);
      border: 1px solid var(--border-color); border-radius: 14px; padding: 18px 20px;
      box-shadow: 0 20px 60px rgba(0,0,0,.5); display: flex; flex-direction: column; gap: 12px;
    }
    .ctm-header { display: flex; align-items: center; justify-content: space-between; }
    .ctm-title { font-size: 1rem; font-weight: 600; color: var(--text-color); }
    .ctm-close { background: none; border: none; color: var(--text-secondary); cursor: pointer; font-size: 1rem; }
    .ctm-field { display: flex; flex-direction: column; gap: 5px; font-size: .72rem; color: var(--text-secondary); }
    .ctm-field input, .ctm-field select, .ctm-field textarea {
      padding: 9px 10px; border-radius: 8px; border: 1px solid var(--border-color);
      background: var(--input-bg); color: var(--text-color); font-size: .9rem; font-family: inherit; box-sizing: border-box; width: 100%;
    }
    .ctm-field textarea { min-height: 160px; resize: vertical; font-size: .85rem; line-height: 1.5; }
    .ctm-msg { font-size: .8rem; min-height: 16px; }
    .ctm-actions { display: flex; align-items: center; gap: 8px; }
    .ctm-chat-link { font-size: .8rem; color: #7c3aed; text-decoration: none; }
    .ctm-btn-secondary { padding: 8px 16px; border-radius: 8px; border: 1px solid var(--border-color); background: transparent; color: var(--text-color); cursor: pointer; }
    .ctm-btn-primary { padding: 8px 18px; border-radius: 8px; border: none; background: #7c3aed; color: #fff; font-weight: 600; cursor: pointer; }
    .kanban-wrap {
      flex: 1;
      overflow: hidden;
      padding: 1rem 1.25rem;
      display: flex;
      flex-direction: column;
    }
    /* Tab panes — not in tickets.css */
    .drawer-tab-content { display: none !important; }
    .drawer-tab-content.active { display: flex !important; flex-direction: column; flex: 1; }
    #tab-actions.active { padding: 0; position: relative; }
    #tab-preview.active { padding: 0; flex: 1; min-height: 0; overflow: hidden; }
    .placeholder-pane { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--text-secondary); opacity: 0.4; gap: 0.75rem; }
    .placeholder-pane i { font-size: 2rem; }
    .placeholder-pane p { font-size: 0.875rem; margin: 0; }
    /* Agent thinking indicator */
    .agent-thinking-dots {
      font-size: .8rem;
      color: #a78bfa;
      animation: thinkPulse 1.5s ease-in-out infinite;
    }
    @keyframes thinkPulse {
      0%, 100% { opacity: 0.4; }
      50%      { opacity: 1; }
    }
    /* askUser option buttons */
    .question-options {
      display: flex; flex-wrap: wrap; gap: 0.5rem;
      margin-top: 0.75rem;
    }
    .question-opt-btn {
      padding: 0.4rem 1rem;
      font-size: 0.8125rem;
      font-weight: 500;
      border-radius: 999px;
      border: 1px solid rgba(251, 191, 36, 0.4);
      background: rgba(251, 191, 36, 0.08);
      color: #fbbf24;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
    }
    .question-opt-btn:hover {
      background: rgba(251, 191, 36, 0.2);
      border-color: #fbbf24;
    }
    .question-opt-btn.question-opt-disabled,
    .question-opt-btn:disabled {
      opacity: 0.4;
      cursor: default;
      pointer-events: none;
    }
    .question-custom-hint {
      margin-top: 0.4rem;
      font-size: 0.75rem;
      color: rgba(255,255,255,0.35);
    }
  </style>
</head>
<body data-user-id="${user.id}" data-project-id="${project.projectId}">

<div class="app-container">
  <!-- Sidebar -->
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
        <div class="nav-dropdown-container" id="projectDropdownContainer">
          <button class="project-dropdown-trigger" id="projectDropdownTrigger" title="Project Options">
            <i class="fas fa-folder-open"></i>
            <span class="project-name-text">${project.name}</span>
            <i class="fas fa-chevron-down dropdown-arrow"></i>
          </button>
          <div class="nav-dropdown" id="projectDropdown">
            <a href="/projects" class="nav-dropdown-item">
              <i class="fas fa-th-large"></i><span>All Projects</span>
            </a>
          </div>
        </div>
      </div>
      <div class="new-chat-section">
        <a href="/chat/project/${project.projectId}?new=1" id="new-chat-btn" class="new-chat-link">
          <i class="fas fa-pen-to-square"></i>
          <span class="button-text">New chat</span>
        </a>
      </div>
      <div class="sidebar-nav">
        <a href="/chat/project/${project.projectId}" class="nav-link">
          <i class="fas fa-comments"></i><span class="nav-text">Chat</span>
        </a>
        <a href="/projects/${project.projectId}" class="nav-link">
          <i class="fas fa-tachometer-alt"></i><span class="nav-text">Dashboard</span>
        </a>
        <a href="/projects/${project.projectId}/tickets" class="nav-link active">
          <i class="fas fa-tasks"></i><span class="nav-text">Tickets</span>
        </a>
        <a href="/instant/project/${project.projectId}" class="nav-link">
          <i class="fas fa-bolt"></i><span class="nav-text">Instant</span>
        </a>
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

  <!-- Main tickets page -->
  <div class="tickets-page">

    <!-- Toolbar -->
    <div class="tickets-toolbar">
      <input class="filter-search" type="text" placeholder="Search tickets..." id="ticket-search" oninput="filterTickets()" />
      <select class="filter-select" id="filter-status" onchange="filterTickets()">
        <option value="">All Statuses</option>
        <option value="open">Open</option>
        <option value="in_progress">In Progress</option>
        <option value="review">Review</option>
        <option value="done">Done</option>
        <option value="failed">Failed</option>
        <option value="blocked">Blocked</option>
      </select>
      <select class="filter-select" id="filter-priority" onchange="filterTickets()">
        <option value="">All Priorities</option>
        <option value="High">High</option>
        <option value="Medium">Medium</option>
        <option value="Low">Low</option>
      </select>
      <div class="toolbar-spacer"></div>
      ${executionMode ? html`
        <div class="exec-mode-toggle" title="Execution mode">
          <button class="exec-mode-btn ${isApiMode ? "active" : ""}" id="exec-mode-api" onclick="setExecMode(false)">
            <i class="fas fa-cloud"></i> API
          </button>
          <button class="exec-mode-btn ${!isApiMode ? "active" : ""}" id="exec-mode-cli" onclick="setExecMode(true)">
            <i class="fas fa-terminal"></i> CLI
          </button>
        </div>
        <select class="builder-model-select" id="builder-model-select"
          onchange="setBuilderModel(this.value)">
          ${executionMode.models.map(m => html`
            <option value="${m.key}" ${m.key === executionMode.builderModelKey ? "selected" : ""}>${m.label}</option>
          `)}
        </select>
      ` : ""}
      <div class="build-settings-menu">
        <button class="build-settings-btn" onclick="toggleBuildSettings(event)" title="Build & preview settings"><i class="fas fa-sliders-h"></i></button>
        <div class="build-settings-dropdown" id="build-settings-dropdown">
          <div class="bs-title">Build &amp; preview</div>
          <label class="bs-row"><span>Ticket build</span>
            <select id="build-isolation-select" onchange="setBuildSetting('ticketBuildIsolation', this.value)">
              <option value="isolated" ${(project.ticketBuildIsolation ?? "isolated") === "isolated" ? "selected" : ""}>Fresh sandbox (isolated)</option>
              <option value="shared" ${project.ticketBuildIsolation === "shared" ? "selected" : ""}>Shared preview VM</option>
            </select>
          </label>
          <label class="bs-row"><span>Preview branch</span>
            <select id="preview-branch-mode-select" onchange="setBuildSetting('previewBranchMode', this.value)">
              <option value="worktree" ${(project.previewBranchMode ?? "worktree") === "worktree" ? "selected" : ""}>Worktree (separate dir)</option>
              <option value="checkout" ${project.previewBranchMode === "checkout" ? "selected" : ""}>Switch branch (stash)</option>
            </select>
          </label>
        </div>
      </div>
      <button type="button" class="toolbar-btn-new" onclick="openCreateTicket()">
        <i class="fas fa-plus"></i> New Ticket
      </button>
    </div>

    <!-- Create-ticket modal -->
    <div class="create-ticket-overlay" id="create-ticket-overlay" onclick="if(event.target===this)closeCreateTicket()">
      <div class="create-ticket-modal">
        <div class="ctm-header">
          <div class="ctm-title">New ticket</div>
          <button type="button" class="ctm-close" onclick="closeCreateTicket()"><i class="fas fa-times"></i></button>
        </div>
        <label class="ctm-field"><span>Title</span>
          <input id="ctm-name" type="text" placeholder="Short summary of the work" />
        </label>
        <label class="ctm-field"><span>Priority</span>
          <select id="ctm-priority">
            <option value="High">High</option>
            <option value="Medium" selected>Medium</option>
            <option value="Low">Low</option>
          </select>
        </label>
        <label class="ctm-field"><span>Description (markdown)</span>
          <textarea id="ctm-desc" placeholder="What needs to be done, acceptance criteria, files to touch…"></textarea>
        </label>
        <div class="ctm-msg" id="ctm-msg"></div>
        <div class="ctm-actions">
          <a href="/chat/project/${project.projectId}" class="ctm-chat-link">Or plan it in chat →</a>
          <div style="flex:1"></div>
          <button type="button" class="ctm-btn-secondary" onclick="closeCreateTicket()">Cancel</button>
          <button type="button" class="ctm-btn-primary" onclick="submitCreateTicket()">Create ticket</button>
        </div>
      </div>
    </div>

    <!-- Kanban board -->
    <div class="kanban-wrap">
      <div class="kanban-board" id="kanban-board">
        ${stages.map((stage) => {
          const stageTickets = byStage[stage.id] ?? [];
          return html`
            <div class="kanban-column" data-stage-id="${stage.id}">
              <div class="kanban-column-header" style="border-top-color:${stage.color};">
                <div class="kanban-column-title">
                  <span class="stage-color-dot" style="background:${stage.color};"></span>
                  <span class="stage-name">${stage.name}</span>
                  <span class="ticket-count">${stageTickets.length}</span>
                </div>
              </div>
              <div class="kanban-column-body" data-stage-id="${stage.id}">
                ${stageTickets.length === 0 ? html`
                  <div style="text-align:center;padding:1.5rem;color:var(--text-secondary);font-size:0.8rem;opacity:0.4;">No tickets</div>
                ` : stageTickets.map((t) => html`
                  <div class="kanban-card" data-ticket-id="${t.id}" data-status="${t.status}" data-priority="${t.priority}"
                       draggable="true" onclick="openTicketDrawer('${t.id}')">
                    <div class="kanban-card-header">
                      ${t.ticketKey ? html`<span style="font-size:0.7rem;color:var(--text-secondary);font-weight:600;font-family:monospace;letter-spacing:0.02em;">${t.ticketKey}</span>` : ""}
                      <span class="kanban-card-title">${t.name}</span>
                    </div>
                    <div class="kanban-card-meta">
                      <span class="priority-label" style="color:${PRIORITY_COLOR[t.priority] ?? "#6b7280"};">
                        <span class="kanban-priority-dot" style="background:${PRIORITY_COLOR[t.priority] ?? "#6b7280"};"></span>
                        ${t.priority}
                      </span>
                    </div>
                  </div>
                `)}
              </div>
            </div>
          `;
        })}
      </div>
    </div>
  </div>
</div>

<!-- Drawer overlay -->
<div class="drawer-overlay" id="drawer-overlay"></div>

<!-- Ticket detail drawer -->
<div class="drawer" id="ticket-drawer">
  <div class="drawer-resize-handle" id="drawer-resize-handle"></div>

  <!-- Drawer header -->
  <div class="drawer-header">
    <div class="drawer-header-left">
      <div class="drawer-title" id="drawer-title"></div>
    </div>
    <div class="drawer-header-right">
      <div class="drawer-actions">
        <button class="drawer-execute-btn" id="drawer-build-btn" onclick="buildCurrentTicket()">
          <i class="fas fa-bolt"></i> Build Ticket
        </button>
        <button class="drawer-server-btn" id="drawer-stop-btn" onclick="stopCurrentTicket()" style="display:none;color:#f87171;border-color:#5a2a30;"><i class="fas fa-stop"></i> Stop</button>
        <div class="drawer-more-menu">
          <button class="drawer-more-btn" onclick="toggleDrawerMore()">
            <i class="fas fa-ellipsis-v"></i>
          </button>
          <div class="drawer-more-dropdown" id="drawer-more-dropdown">
            <button class="drawer-more-item" onclick="shareCurrentTicket()">
              <i class="fas fa-share-nodes"></i> Share Ticket
            </button>
            <button class="drawer-more-item" onclick="clearTicketLogs()">
              <i class="fas fa-eraser"></i> Clear run logs
            </button>
            <button class="drawer-more-item" onclick="downloadPiOutput()">
              <i class="fas fa-download"></i> Download Pi output (.jsonl.gz)
            </button>
            <button class="drawer-more-item" onclick="downloadPiPrompt()">
              <i class="fas fa-download"></i> Download prompt sent to Pi
            </button>
            <button class="drawer-more-item drawer-more-item--danger" onclick="deleteCurrentTicket()">
              <i class="fas fa-trash"></i> Delete Ticket
            </button>
          </div>
        </div>
        <button class="drawer-close" onclick="closeTicketDrawer()">
          <i class="fas fa-times"></i>
        </button>
      </div>
    </div>
  </div>

  <!-- Drawer tabs -->
  <div class="drawer-tabs">
    <button class="drawer-tab active" data-tab="details" onclick="switchDrawerTab('details', this)">
      <i class="fas fa-info-circle"></i> Details
    </button>
    <button class="drawer-tab" data-tab="actions" onclick="switchDrawerTab('actions', this)">
      <i class="fas fa-terminal"></i> Actions
    </button>
    <button class="drawer-tab" data-tab="tasks" onclick="switchDrawerTab('tasks', this)">
      <i class="fas fa-list-check"></i> Tasks
    </button>
    <button class="drawer-tab" data-tab="preview" onclick="switchDrawerTab('preview', this)">
      <i class="fas fa-desktop"></i> Preview
    </button>
    <button class="drawer-tab" data-tab="git" onclick="switchDrawerTab('git', this)">
      <i class="fab fa-github"></i> Git
    </button>
    <button class="drawer-tab" data-tab="addenda" onclick="switchDrawerTab('addenda', this)">
      <i class="fas fa-plus-circle"></i> Addenda <span id="addenda-count" class="addenda-count" style="display:none;"></span>
    </button>
    <button class="drawer-tab" data-tab="logs" onclick="switchDrawerTab('logs', this)">
      <i class="fas fa-file-alt"></i> Server Logs
    </button>
  </div>

  <!-- Drawer body -->
  <div class="drawer-body">

    <!-- Details tab -->
    <div class="drawer-tab-content active" id="tab-details">
      <div class="ticket-detail-drawer">
        <div class="detail-meta-row">
          <span class="detail-label status-label" id="drawer-status"></span>
          <span class="detail-label priority-label" id="drawer-priority"></span>
          <div class="detail-meta-spacer"></div>
          <button type="button" class="detail-edit-btn" onclick="editCurrentTicket()"><i class="fas fa-pen"></i> Edit</button>
          <button type="button" class="detail-delete-btn" onclick="deleteCurrentTicket()"><i class="fas fa-trash"></i></button>
        </div>
        <div class="detail-section">
          <h4>Description</h4>
          <div id="drawer-description" class="markdown-content"></div>
        </div>
        <div class="detail-section" id="drawer-linked-docs" style="display:none;">
          <h4>Linked Documents</h4>
          <div id="drawer-linked-docs-list"></div>
        </div>
        <div class="detail-section">
          <h4>Details</h4>
          <div class="detail-grid">
            <div class="detail-grid-item">
              <div class="label">Created</div>
              <div class="value" id="drawer-created"></div>
            </div>
            <div class="detail-grid-item">
              <div class="label">Updated</div>
              <div class="value" id="drawer-updated"></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Actions tab: Execution logs + chat -->
    <div class="drawer-tab-content" id="tab-actions">
      <!-- Build status banner (persists across refresh — derived from ticket state) -->
      <div id="ticket-status-banner" style="display:none;padding:.6rem 1rem;font-size:.82rem;font-weight:600;flex-shrink:0;border-bottom:1px solid rgba(255,255,255,.06);"></div>
      <!-- Git branch banner — sticky at the top of the scrolling log -->
      <div id="actions-git-banner" style="display:none;position:sticky;top:0;z-index:6;padding:.5rem 1rem;background:var(--card-bg, #17141d);border-bottom:1px solid var(--border-color, rgba(139,92,246,.18));flex-shrink:0;">
        <div style="display:flex;align-items:center;gap:.5rem;font-size:.8rem;">
          <i class="fas fa-code-branch" style="color:var(--primary-color, #a78bfa);font-size:.75rem;"></i>
          <code id="actions-git-branch" style="color:var(--text-color);background:transparent;font-size:.8rem;">—</code>
          <span style="color:var(--text-secondary);margin:0 .25rem;">·</span>
          <code id="actions-git-sha" style="color:var(--text-secondary);background:transparent;font-size:.75rem;">—</code>
        </div>
      </div>
      <!-- Log rows -->
      <div id="actions-log-area" class="execution-logs-container"></div>
      <!-- Chat input (fixed to bottom) -->
      <div class="logs-chat-container">
        <!-- Outcome banner (failure reason / success) — pinned above the chat input -->
        <div id="actions-bottom-banner" style="display:none;margin:-.75rem -1rem .6rem;padding:.55rem 1rem;font-size:.8rem;font-weight:600;border-bottom:1px solid rgba(255,255,255,.06);"></div>
        <div id="actions-attach-chip" style="display:none;align-items:center;gap:.4rem;margin:0 0 .4rem 0;font-size:.75rem;color:var(--text-secondary,#9ca3af);"></div>
        <div class="logs-chat-field">
          <input id="actions-file-input" type="file" style="display:none;" onchange="uploadTicketFile(this.files&&this.files[0])" />
          <button onclick="document.getElementById('actions-file-input').click()" class="logs-chat-send-btn" title="Attach a file for the agent" style="background:transparent;">
            <i class="fas fa-paperclip" style="font-size:.72rem;"></i>
          </button>
          <input id="actions-chat-input" type="text" placeholder="Send a message to the agent..."
            onkeydown="if(event.key==='Enter'){sendTicketChatMsg();}" />
          <button onclick="sendTicketChatMsg()" class="logs-chat-send-btn" title="Send message">
            <i class="fas fa-arrow-up" style="font-size:.65rem;"></i>
          </button>
        </div>
      </div>
    </div>

    <!-- Tasks tab -->
    <div class="drawer-tab-content" id="tab-tasks">
      <div class="task-toolbar">
        <div id="task-add-form" style="display:none;flex:1;gap:0.5rem;align-items:center;">
          <input id="task-add-input" type="text" placeholder="Task description…" class="task-input"
            onkeydown="if(event.key==='Enter')addNewTask();" />
          <button onclick="addNewTask()" class="preview-btn preview-btn--start" style="padding:0.35rem 0.7rem;">Add</button>
          <button onclick="hideTaskForm()" class="preview-btn preview-btn--action" style="padding:0.35rem 0.5rem;">
            <i class="fas fa-times"></i>
          </button>
        </div>
        <button id="task-add-btn" onclick="showTaskForm()" class="preview-btn preview-btn--start" style="background:rgba(124,58,237,0.15);color:#a78bfa;border-color:rgba(124,58,237,0.25);">
          <i class="fas fa-plus"></i> Add Task
        </button>
      </div>
      <div id="tasks-list" style="flex:1;overflow-y:auto;padding:0.875rem 1rem;display:flex;flex-direction:column;gap:0.5rem;">
        <div class="placeholder-pane"><i class="fas fa-list-check"></i><p>No tasks yet</p></div>
      </div>
    </div>

    <!-- Preview tab -->
    <div class="drawer-tab-content" id="tab-preview">
      <div id="preview-toolbar" class="preview-toolbar">
        <span id="preview-url-label" class="preview-url-label">Not started</span>
        <button id="preview-start-btn" onclick="startPreview()" class="preview-btn preview-btn--start">
          <i class="fas fa-play"></i> Start
        </button>
        <button onclick="restartPreview()" class="preview-btn preview-btn--action" title="Restart server">
          <i class="fas fa-redo"></i>
        </button>
        <a id="preview-open-link" href="#" target="_blank" class="preview-btn preview-btn--action" style="text-decoration:none;display:none;" title="Open in new tab">
          <i class="fas fa-external-link-alt"></i>
        </a>
        <button onclick="regenerateDemo()" class="preview-btn preview-btn--action" title="Regenerate feature demo recording">
          <i class="fas fa-film"></i>
        </button>
      </div>
      <div id="preview-demo" class="preview-demo" style="display:none;padding:12px 14px;overflow:auto;border-bottom:1px solid var(--border,#e5e7eb);"></div>
      <iframe id="preview-iframe" src="about:blank" class="preview-iframe"></iframe>
    </div>

    <!-- Git tab -->
    <div class="drawer-tab-content" id="tab-git">
      <div id="git-info" style="flex:1;overflow-y:auto;padding:1rem;">
        <div class="placeholder-pane"><i class="fab fa-github"></i><p>Loading git info…</p></div>
      </div>
    </div>

    <!-- Addenda tab: follow-up change requests that feed the next (re)build -->
    <div class="drawer-tab-content" id="tab-addenda">
      <div class="addenda-toolbar">
        <input id="addendum-input" type="text" placeholder="Request a change or refinement (e.g. make the header sticky)…"
          onkeydown="if(event.key==='Enter'){submitAddendum();}" />
        <button onclick="submitAddendum()" class="addenda-add-btn"><i class="fas fa-plus"></i> Add</button>
      </div>
      <div class="addenda-hint">Pending addenda are handed to the agent the next time this ticket is built — with the original spec and what got done. Resolved on a successful build.</div>
      <div id="addenda-list" class="addenda-list">
        <div class="placeholder-pane"><i class="fas fa-plus-circle"></i><p>No change requests yet</p></div>
      </div>
    </div>

    <!-- Server Logs tab -->
    <div class="drawer-tab-content" id="tab-logs">
      <div id="server-logs-area" class="server-logs-area"></div>
      <div class="server-logs-footer">
        <button onclick="_serverLogOffset=0;document.getElementById('server-logs-area').innerHTML='';refreshServerLogs();" class="preview-btn preview-btn--action">
          <i class="fas fa-sync-alt"></i> Refresh
        </button>
      </div>
    </div>
  </div>
</div>

<script src="/public/js/sidebar.js"></script>
<script src="/public/js/sharing.js"></script>
<script>
  const PROJECT_ID = document.body.dataset.projectId;
  let _currentTicketId = null;

  // ── Execution Mode Toggle ─────────────────────────────────────────
  function setExecMode(cliEnabled) {
    fetch('/api/settings/execution-mode', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claudeCodeEnabled: cliEnabled }),
    }).then(function(r) {
      if (!r.ok) return;
      var apiBtn = document.getElementById('exec-mode-api');
      var cliBtn = document.getElementById('exec-mode-cli');
      // Model selector is shown in BOTH modes: it drives the builder model.
      // Claude models run via Claude Code CLI; all others run via Pi.
      if (cliEnabled) {
        cliBtn.classList.add('active');
        apiBtn.classList.remove('active');
      } else {
        apiBtn.classList.add('active');
        cliBtn.classList.remove('active');
      }
    });
  }

  function setBuilderModel(modelKey) {
    fetch('/api/settings/execution-mode', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ builderModelKey: modelKey }),
    });
  }

  // Per-project build/preview settings (ticket build isolation, preview branch mode).
  function setBuildSetting(key, value) {
    fetch('/api/projects/' + PROJECT_ID + '/preview/build-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: value }),
    }).catch(function(){});
  }
  window.setBuildSetting = setBuildSetting;

  function toggleBuildSettings(e) {
    if (e) e.stopPropagation();
    var d = document.getElementById('build-settings-dropdown');
    if (d) d.classList.toggle('open');
  }
  window.toggleBuildSettings = toggleBuildSettings;

  // ── New-ticket create modal ──────────────────────────────────────────
  function openCreateTicket() {
    var o = document.getElementById('create-ticket-overlay');
    if (!o) return;
    o.classList.add('open');
    var m = document.getElementById('ctm-msg'); if (m) m.textContent = '';
    var n = document.getElementById('ctm-name'); if (n) { n.value=''; setTimeout(function(){ n.focus(); }, 30); }
    var d = document.getElementById('ctm-desc'); if (d) d.value='';
  }
  function closeCreateTicket() { var o = document.getElementById('create-ticket-overlay'); if (o) o.classList.remove('open'); }
  async function submitCreateTicket() {
    var name = (document.getElementById('ctm-name')||{}).value || '';
    var description = (document.getElementById('ctm-desc')||{}).value || '';
    var priority = (document.getElementById('ctm-priority')||{}).value || 'Medium';
    var msg = document.getElementById('ctm-msg');
    if (!name.trim()) { if (msg){ msg.textContent='Title is required.'; msg.style.color='#ef4444'; } return; }
    if (!description.trim()) { if (msg){ msg.textContent='Description is required.'; msg.style.color='#ef4444'; } return; }
    if (msg){ msg.textContent='Creating…'; msg.style.color='var(--text-secondary)'; }
    try {
      var r = await fetch('/api/projects/' + PROJECT_ID + '/tickets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), description: description, priority: priority })
      });
      if (!r.ok) { var j = await r.json().catch(function(){return{};}); throw new Error(j.error || ('HTTP ' + r.status)); }
      closeCreateTicket();
      location.reload(); // show the new card on the board
    } catch (e) { if (msg){ msg.textContent='Failed: ' + e.message; msg.style.color='#ef4444'; } }
  }
  window.openCreateTicket = openCreateTicket;
  window.closeCreateTicket = closeCreateTicket;
  window.submitCreateTicket = submitCreateTicket;
  // Close the popover on an outside click.
  document.addEventListener('click', function (e) {
    var menu = e.target.closest && e.target.closest('.build-settings-menu');
    if (!menu) { var d = document.getElementById('build-settings-dropdown'); if (d) d.classList.remove('open'); }
  });

  // Restore drawer state from sessionStorage on page load
  (function restoreDrawer() {
    var saved = sessionStorage.getItem('lfg_drawer_ticket_' + PROJECT_ID);
    if (saved) {
      // Defer so DOM is ready and ticketMap is populated
      setTimeout(function() { openTicketDrawer(saved); }, 0);
    }
  })();

  // Inline ticket data (avoids extra fetch on click)
  const TICKET_DATA = ${raw(JSON.stringify(
    tickets.map((t, i) => ({
      id: t.id,
      ticketKey: t.ticketKey ?? null,
      name: t.name,
      status: t.status ?? "open",
      priority: t.priority ?? "Medium",
      description: t.description ?? "",
      complexity: t.complexity ?? "medium",
      createdAt: t.createdAt
        ? new Date(t.createdAt as string).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
        : "—",
      updatedAt: t.updatedAt
        ? new Date(t.updatedAt as string).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
        : "—",
      index: i + 1,
    }))
  // Escape </ to prevent HTML parser terminating the script tag on </script in data
  ).replace(/<\//g, "<\\/"))};
  const ticketMap = Object.fromEntries(TICKET_DATA.map(t => [t.id, t]));

  // Render the drawer's Details header from a ticket object (ticketMap entry OR a
  // freshly-fetched live row). Kept separate so a click still opens the drawer
  // even when the local ticketMap is stale/missing the ticket (was: silent no-op
  // = "card not clickable").
  function renderDrawerDetails(t) {
    if (!t) return;
    var key = t.ticketKey || t.ticket_key || ('TKT-' + (t.index != null ? t.index : ''));
    var status = t.status || 'open';
    var priority = t.priority || 'Medium';
    document.getElementById('drawer-title').textContent = key + ': ' + (t.name || 'Ticket');
    const sb = document.getElementById('drawer-status');
    sb.textContent = status.replace(/_/g, ' ');
    sb.className = 'detail-label status-label status-' + status;
    const pb = document.getElementById('drawer-priority');
    pb.textContent = priority;
    pb.className = 'detail-label priority-label priority-' + priority.toLowerCase();
    var _descEl = document.getElementById('drawer-description');
    if (t.description && typeof marked !== 'undefined') { _descEl.innerHTML = marked.parse(t.description); }
    else { _descEl.textContent = t.description || 'No description provided.'; }
    document.getElementById('drawer-created').textContent = t.createdAt || t.created_at || '';
    document.getElementById('drawer-updated').textContent = t.updatedAt || t.updated_at || '';
  }

  function openTicketDrawer(ticketId) {
    _lastLogCount = 0;
    _lastLogContent = '';
    _logsFirstLoad = true;
    _currentTicketId = ticketId;
    const t = ticketMap[ticketId];
    // Render from the local map if we have it; otherwise open with a placeholder
    // and let the live fetch below fill it in — NEVER silently return (that reads
    // as "the card isn't clickable").
    if (t) renderDrawerDetails(t);
    else document.getElementById('drawer-title').textContent = 'Loading…';

    // Pre-clear log area
    const actionsArea = document.getElementById('actions-log-area');
    if (actionsArea) actionsArea.innerHTML = '';

    // Persist drawer state so it survives page reload / re-render
    sessionStorage.setItem('lfg_drawer_ticket_' + PROJECT_ID, ticketId);

    // Show drawer immediately with Details tab as default
    document.getElementById('ticket-drawer').classList.add('active');

    // Fetch LIVE ticket status to detect executing tickets (ticketMap is stale)
    fetch('/api/projects/' + PROJECT_ID + '/tickets/' + ticketId)
      .then(function(r) { return r.json(); })
      .then(function(resp) {
        var live = resp && resp.ticket ? resp.ticket : resp;
        if (!live || (!live.id && !live.name)) return; // nothing to show
        // Cache + (re)render details from the authoritative live row — this is what
        // makes the drawer open even when ticketMap was stale/missing the ticket.
        ticketMap[ticketId] = Object.assign({}, ticketMap[ticketId] || {}, live);
        renderDrawerDetails(ticketMap[ticketId]);
        renderTicketDemo(ticketMap[ticketId]);
        var qs = live.queueStatus || live.queue_status || '';
        var st = live.status || (t && t.status) || 'open';
        var isActive = qs === 'queued' || qs === 'executing';
        // Persistent build-status banner (survives refresh — from the ticket row).
        updateTicketStatusBanner(live);
        loadAddenda(); // updates the Addenda tab badge with the pending count
        var buildBtn = document.getElementById('drawer-build-btn');
        // While a build is running you can't start another — hide Build entirely and
        // show only Stop (cleaner than a disabled "Building…" button).
        buildBtn.disabled = false;
        buildBtn.style.display = isActive ? 'none' : '';
        buildBtn.innerHTML = '<i class="fas fa-bolt"></i> Build Ticket';
        var stopBtn = document.getElementById('drawer-stop-btn');
        if (stopBtn) stopBtn.style.display = isActive ? '' : 'none';
        // If executing, switch to Actions tab so user sees live logs
        if (isActive) {
          switchDrawerTab('actions', document.querySelector('.drawer-tab[data-tab="actions"]'));
        } else {
          switchDrawerTab('details', document.querySelector('.drawer-tab[data-tab="details"]'));
        }
      }).catch(function() {
        switchDrawerTab('details', document.querySelector('.drawer-tab[data-tab="details"]'));
      });
  }

  function closeTicketDrawer() {
    document.getElementById('ticket-drawer').classList.remove('active');
    sessionStorage.removeItem('lfg_drawer_ticket_' + PROJECT_ID);
    _currentTicketId = null;
    _lastLogCount = 0;
    _lastLogContent = '';
    _logsFirstLoad = true;
    stopServerLogPolling();
  }

  // ── Inline ticket edit (title / priority / description) ──────────────
  function _esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function editCurrentTicket() {
    if (!_currentTicketId) return;
    var t = ticketMap[_currentTicketId];
    var descEl = document.getElementById('drawer-description');
    if (!t || !descEl) return;
    var fld = 'width:100%;box-sizing:border-box;margin-top:4px;padding:8px;border-radius:6px;border:1px solid var(--border-color);background:var(--input-bg);color:var(--text-color);';
    var lbl = 'font-size:.72rem;color:var(--text-secondary);display:block;margin-bottom:10px;';
    descEl.innerHTML =
      '<div class="ticket-edit-form">' +
        '<label style="'+lbl+'">Title<input id="edit-name" value="'+_esc(t.name)+'" style="'+fld+'font-size:.9rem;"/></label>' +
        '<label style="'+lbl+'">Priority<select id="edit-priority" style="'+fld+'">' +
          ['High','Medium','Low'].map(function(p){return '<option value="'+p+'"'+(t.priority===p?' selected':'')+'>'+p+'</option>';}).join('') +
        '</select></label>' +
        '<label style="'+lbl+'">Description (markdown)<textarea id="edit-desc" style="'+fld+'min-height:220px;font-family:ui-monospace,Menlo,monospace;font-size:.82rem;line-height:1.5;">'+_esc(t.description||'')+'</textarea></label>' +
        '<div style="display:flex;gap:8px;"><button type="button" onclick="saveTicketEdit()" style="padding:7px 16px;border-radius:6px;border:none;background:#7c3aed;color:#fff;cursor:pointer;font-weight:600;">Save</button>' +
        '<button type="button" onclick="cancelTicketEdit()" style="padding:7px 16px;border-radius:6px;border:1px solid var(--border-color);background:transparent;color:var(--text-color);cursor:pointer;">Cancel</button></div>' +
      '</div>';
  }
  async function saveTicketEdit() {
    if (!_currentTicketId) return;
    var name = (document.getElementById('edit-name')||{}).value || '';
    var description = (document.getElementById('edit-desc')||{}).value || '';
    var priority = (document.getElementById('edit-priority')||{}).value || '';
    try {
      var r = await fetch('/api/projects/' + PROJECT_ID + '/tickets/' + _currentTicketId, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, description: description, priority: priority })
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      if (ticketMap[_currentTicketId]) { ticketMap[_currentTicketId].name = name; ticketMap[_currentTicketId].description = description; ticketMap[_currentTicketId].priority = priority; }
      var id = _currentTicketId;
      // Update the board card's visible title, if present.
      var card = document.querySelector('[data-ticket-id="' + id + '"] .kanban-card-title, [data-ticket-id="' + id + '"] .ticket-card-title');
      openTicketDrawer(id); // re-render details from the updated map
    } catch (e) { alert('Save failed: ' + e.message); }
  }
  function cancelTicketEdit() { if (_currentTicketId) openTicketDrawer(_currentTicketId); }
  window.editCurrentTicket = editCurrentTicket;
  window.saveTicketEdit = saveTicketEdit;
  window.cancelTicketEdit = cancelTicketEdit;

  function switchDrawerTab(tabId, btn) {
    document.querySelectorAll('.drawer-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.drawer-tab-content').forEach(p => p.classList.remove('active'));
    if (btn) btn.classList.add('active');
    const pane = document.getElementById('tab-' + tabId);
    if (pane) pane.classList.add('active');
    // Lazy-load tab data
    // Stop server log polling when leaving logs tab
    if (tabId !== 'logs') stopServerLogPolling();

    if (tabId === 'actions') {
      _lastLogCount = 0;
      _lastLogContent = '';
      _logsFirstLoad = true;
      // Await the fetch+render, THEN scroll to the latest — the pane just became
      // visible and rows render after the async load, so scroll only lands once
      // the content is actually there.
      loadExecutionLogs().then(function() { scrollActionsBottom(); });
      // Logs come via WebSocket (ticket_log events) — no polling needed
    }
    if (tabId === 'tasks')   loadTasks();
    if (tabId === 'git')     loadGitInfo();
    if (tabId === 'addenda') loadAddenda();
    if (tabId === 'logs') {
      _serverLogOffset = 0;
      document.getElementById('server-logs-area').innerHTML = '';
      refreshServerLogs();
    }
    if (tabId === 'preview') { loadSandboxInfo(); renderTicketDemo(ticketMap[_currentTicketId] || {}); }
  }

  // ── Feature demo (auto-recorded on ticket completion) ──────────────────────
  function _demoEsc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function renderTicketDemo(ticket) {
    var box = document.getElementById('preview-demo');
    if (!box) return;
    var demo = ticket && ticket.details ? ticket.details.previewDemo : null;
    if (!demo) { box.style.display = 'none'; box.innerHTML = ''; return; }
    box.style.display = 'block';
    var when = demo.generatedAt ? new Date(demo.generatedAt).toLocaleString() : '';
    var head = '<div style="display:flex;align-items:center;justify-content:space-between;margin:0 0 8px;">'
      + '<strong style="font-size:13px;">Feature demo</strong>'
      + '<span style="font-size:11px;color:#888;">' + _demoEsc(when) + '</span></div>';
    var body = '';
    if (demo.status === 'running') {
      body = '<div style="padding:10px 0;color:#888;font-size:13px;"><i class="fas fa-spinner fa-spin"></i> Recording demo…</div>';
    } else if (demo.status === 'auth_gated') {
      body = '<div style="padding:10px 0;color:#b45309;font-size:13px;">' + _demoEsc(demo.summary || 'App is behind Google sign-in — rebuild to enable full-demo recording.') + '</div>';
    } else if (demo.status === 'error') {
      body = '<div style="padding:10px 0;color:#b91c1c;font-size:13px;">' + _demoEsc(demo.summary || 'Demo could not be generated.') + '</div>';
    } else if (demo.kind === 'frontend' && demo.videoUrl) {
      body = (demo.summary ? '<div style="font-size:12px;color:#666;margin-bottom:6px;">' + _demoEsc(demo.summary) + '</div>' : '')
        + '<video controls playsinline style="width:100%;border-radius:8px;background:#000;max-height:420px;" src="' + _demoEsc(demo.videoUrl) + '"></video>';
    } else if (demo.kind === 'api' && demo.transcript && demo.transcript.length) {
      var rows = '';
      for (var i = 0; i < demo.transcript.length; i++) {
        var t = demo.transcript[i];
        rows += '<div style="margin-bottom:10px;">'
          + '<div style="color:#7ee787;"><span style="color:#8b949e;">$</span> curl ' + _demoEsc(t.command)
          + (t.status ? '  <span style="color:#8b949e;">[' + _demoEsc(t.status) + ']</span>' : '') + '</div>'
          + (t.note ? '<div style="color:#8b949e;font-size:11px;margin:2px 0;"># ' + _demoEsc(t.note) + '</div>' : '')
          + '<pre style="margin:4px 0 0;white-space:pre-wrap;color:#c9d1d9;">' + _demoEsc(t.output) + '</pre></div>';
      }
      body = (demo.summary ? '<div style="font-size:12px;color:#666;margin-bottom:6px;">' + _demoEsc(demo.summary) + '</div>' : '')
        + '<div style="background:#0d1117;border-radius:8px;padding:12px;font-family:ui-monospace,Menlo,monospace;font-size:12px;line-height:1.5;overflow:auto;max-height:420px;">' + rows + '</div>';
    } else {
      body = '<div style="padding:10px 0;color:#888;font-size:13px;">No demo yet.</div>';
    }
    box.innerHTML = head + body;
  }
  function regenerateDemo() {
    if (!_currentTicketId) return;
    var box = document.getElementById('preview-demo');
    if (box) { box.style.display = 'block'; box.innerHTML = '<div style="padding:10px 0;color:#888;font-size:13px;"><i class="fas fa-spinner fa-spin"></i> Recording demo…</div>'; }
    fetch('/api/projects/' + PROJECT_ID + '/tickets/' + _currentTicketId + '/demo', { method: 'POST' }).catch(function() {});
  }
  function refreshTicketDemo() {
    if (!_currentTicketId) return;
    fetch('/api/projects/' + PROJECT_ID + '/tickets/' + _currentTicketId)
      .then(function(r) { return r.json(); })
      .then(function(resp) {
        var live = resp && resp.ticket ? resp.ticket : resp;
        if (!live) return;
        ticketMap[_currentTicketId] = Object.assign({}, ticketMap[_currentTicketId] || {}, live);
        renderTicketDemo(ticketMap[_currentTicketId]);
      }).catch(function() {});
  }

  // ── Build Ticket ─────────────────────────────────────────────────
  async function buildCurrentTicket() {
    if (!_currentTicketId) return;
    const btn = document.getElementById('drawer-build-btn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Queuing…';
    // Clear any stale outcome banner from a previous run the moment we (re)build.
    var _bb = document.getElementById('actions-bottom-banner');
    if (_bb) { _bb.style.display = 'none'; _bb.innerHTML = ''; }
    _lastFailureReason = '';
    try {
      const res = await fetch('/api/projects/' + PROJECT_ID + '/tickets/' + _currentTicketId + '/queue', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error || 'Failed to queue ticket');
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-bolt"></i> Build Ticket';
        return;
      }
      // Queued — hide Build, reveal Stop (you can't build while building).
      btn.disabled = false;
      btn.style.display = 'none';
      btn.innerHTML = '<i class="fas fa-bolt"></i> Build Ticket';
      var stopBtn = document.getElementById('drawer-stop-btn');
      if (stopBtn) stopBtn.style.display = '';
      // Switch to Actions tab so user sees logs immediately
      switchDrawerTab('actions', document.querySelector('.drawer-tab[data-tab="actions"]'));
    } catch(e) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-bolt"></i> Build Ticket';
      alert('Failed to queue ticket: ' + e.message);
    }
  }

  // ── Stop a running build ─────────────────────────────────────────
  async function stopCurrentTicket() {
    if (!_currentTicketId) return;
    var stopBtn = document.getElementById('drawer-stop-btn');
    if (stopBtn) { stopBtn.disabled = true; stopBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Stopping…'; }
    try {
      await fetch('/api/projects/' + PROJECT_ID + '/tickets/' + _currentTicketId + '/stop', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }
      });
    } catch(e) { /* best-effort */ }
    if (stopBtn) { stopBtn.disabled = false; stopBtn.innerHTML = '<i class="fas fa-stop"></i> Stop'; stopBtn.style.display = 'none'; }
    var b = document.getElementById('drawer-build-btn');
    if (b) { b.disabled = false; b.style.display = ''; b.innerHTML = '<i class="fas fa-bolt"></i> Build Ticket'; }
  }

  // ── Actions tab: execution logs + agent chat ─────────────────────
  let _lastLogCount = 0;
  let _lastLogContent = '';
  let _lastFailureReason = ''; // clean failure reason captured from the "Execution failed:" log row

  /**
   * Render a persistent build-status banner in the Actions view from the ticket's
   * DURABLE state (status/queueStatus/stage/merge) — so a page refresh still shows
   * whether the last build completed, failed, or is running. Called on drawer open
   * (from the fetched ticket) and on every WS status update.
   */
  // Pull the real failure reason out of the rendered Actions log (the executor logs
  // "Execution failed: <reason>" / "Pi build failed …" / "Command timed out …"), so the
  // banner can explain WHY instead of just "Build failed". Returns '' if none found.
  function _findFailureReasonFromLogs() {
    // Captured cleanly from the log row during render (renderLogEntry), not scraped from
    // mashed-together DOM text. Cap length to keep the banner one line.
    var r = (_lastFailureReason || '').trim();
    return r.length > 180 ? r.slice(0, 177) + '…' : r;
  }

  function updateTicketStatusBanner(fields) {
    var topEl = document.getElementById('ticket-status-banner');
    var botEl = document.getElementById('actions-bottom-banner');
    var qs = (fields.queueStatus || fields.queue_status || '').toLowerCase();
    var st = (fields.status || '').toLowerCase();
    var merge = (fields.githubMergeStatus || fields.github_merge_status || fields.mergeStatus || '').toLowerCase();
    // b.where: 'top' = live status (spinner) at the top; 'bottom' = the OUTCOME
    // (failure reason / success), pinned above the chat input like a result.
    var b = null;
    if (qs === 'executing' || qs === 'queued') {
      b = { bg: 'rgba(59,130,246,.12)', fg: '#93c5fd', icon: 'fa-spinner fa-spin', where: 'top', text: qs === 'queued' ? 'Queued — waiting to build…' : 'Building this ticket…' };
    } else if (merge === 'not_pushed') {
      b = { bg: 'rgba(248,113,113,.12)', fg: '#fca5a5', icon: 'fa-triangle-exclamation', where: 'bottom', text: 'Built but NOT pushed to git — reconnect the repo in Settings, then rebuild.' };
    } else if (st === 'failed' || qs === 'failed') {
      var reason = (fields && fields.reason) || _findFailureReasonFromLogs();
      b = { bg: 'rgba(239,68,68,.14)', fg: '#fca5a5', icon: 'fa-circle-exclamation', where: 'bottom',
            text: reason ? ('Build failed — ' + reason) : 'Build failed — check the logs above and rebuild.' };
    } else if (merge === 'merged' || st === 'done' || st === 'completed' || st === 'merged') {
      b = { bg: 'rgba(16,185,129,.12)', fg: '#6ee7b7', icon: 'fa-circle-check', where: 'bottom', text: 'Build complete' + (merge === 'merged' ? ' — merged to lfg-agent.' : ' — ready for review.') };
    } else if (st === 'in_review' || st === 'review') {
      b = { bg: 'rgba(16,185,129,.12)', fg: '#6ee7b7', icon: 'fa-circle-check', where: 'bottom', text: 'Build complete — in review.' };
    }
    // Reset both, then fill the target one.
    if (topEl) { topEl.style.display = 'none'; topEl.innerHTML = ''; }
    if (botEl) { botEl.style.display = 'none'; botEl.innerHTML = ''; }
    if (!b) return;
    var el = b.where === 'bottom' ? botEl : topEl;
    if (!el) return;
    el.style.display = 'block';
    el.style.background = b.bg;
    el.style.color = b.fg;
    el.innerHTML = '<i class="fas ' + b.icon + '" style="margin-right:.5rem;"></i>' + b.text;
  }

  /** Called by WS when ticket status changes (build done/failed). */
  function handleTicketStatus(msg) {
    const ticketId = msg.ticketId;
    const qs = msg.queueStatus || '';
    const st = msg.status || '';
    const stageId = msg.stageId || '';

    // Move kanban card to the new column if stageId changed
    if (stageId) {
      var card = document.querySelector('.kanban-card[data-ticket-id="' + ticketId + '"]');
      var targetCol = document.querySelector('.kanban-column-body[data-stage-id="' + stageId + '"]');
      if (card && targetCol) {
        card.parentNode.removeChild(card);
        card.setAttribute('data-status', st);
        // Remove "No tickets" placeholder in target
        var placeholder = targetCol.querySelector('div[style*="text-align:center"]');
        if (placeholder) placeholder.remove();
        targetCol.appendChild(card);
        // Update ticket counts on both source and target columns
        document.querySelectorAll('.kanban-column').forEach(function(col) {
          var body = col.querySelector('.kanban-column-body');
          var count = col.querySelector('.ticket-count');
          if (body && count) count.textContent = body.querySelectorAll('.kanban-card').length;
        });
      }
    }

    if (ticketId !== _currentTicketId) return;
    updateTicketStatusBanner(msg);
    if (qs !== 'queued' && qs !== 'executing') {
      hideThinkingIndicator();
      var btn = document.getElementById('drawer-build-btn');
      if (btn) { btn.disabled = false; btn.style.display = ''; btn.innerHTML = '<i class="fas fa-bolt"></i> Build Ticket'; }
      var sbtn = document.getElementById('drawer-stop-btn');
      if (sbtn) sbtn.style.display = 'none';
    }
  }

  function fmtLogTime(ts) {
    if (!ts) return '';
    try {
      const d = new Date(ts);
      return d.toLocaleTimeString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit', second:'2-digit', hour12:true });
    } catch(e) { return ''; }
  }

  // Derive a short description from a command message (like Django shows)
  function describeCmd(msg, explanation) {
    // If the API returned an explanation, use it
    if (explanation) return explanation;
    // Derive from message content
    if (msg.startsWith('$ ')) {
      // Bash command — try to describe it
      var cmd = msg.slice(2).trim();
      if (cmd.startsWith('npm install') || cmd.startsWith('bun add') || cmd.startsWith('yarn add'))
        return 'Install dependencies';
      if (cmd.startsWith('npm run build') || cmd.startsWith('bun run build'))
        return 'Build project';
      if (cmd.startsWith('npm run dev') || cmd.startsWith('bun run dev'))
        return 'Start dev server';
      if (cmd.startsWith('npx create-') || cmd.startsWith('bunx create-'))
        return 'Create project scaffold';
      if (cmd.startsWith('mkdir')) return 'Create directory';
      if (cmd.startsWith('cat ')) return 'Read file: ' + cmd.slice(4).split(' ')[0];
      if (cmd.startsWith('ls ')) return 'List directory';
      // Fall back to first ~80 chars
      return cmd.length > 80 ? cmd.slice(0, 80) + '...' : cmd;
    }
    if (msg.includes('Read:')) return msg.replace(/^[^\w]*/, '');
    if (msg.includes('Write:')) return 'Writing file: ' + msg.split(':').slice(1).join(':').trim();
    if (msg.includes('Edit:')) return 'Editing file: ' + msg.split(':').slice(1).join(':').trim();
    if (msg.includes('TodoWrite') || msg.includes('updating tasks')) return 'Updating task list';
    if (msg.includes('Grep:') || msg.includes('Glob:')) return msg.replace(/^[^\w]*/, '');
    // Generic — truncate
    return msg.length > 100 ? msg.slice(0, 100) + '...' : msg;
  }

  function renderLogEntry(row, idx) {
    var msg = (row.message || '').trim();
    // Capture the clean failure reason from the log ROW (not scraped DOM text) so the
    // banner shows a readable message instead of a mash of rows + timestamps.
    if (msg.indexOf('Execution failed:') === 0) _lastFailureReason = msg.slice(17).trim();
    var explanation = (row.explanation || '').trim();
    var ts = fmtLogTime(row.createdAt);
    var type = row.type || 'command';
    var rowId = 'log-' + idx;
    var el = document.createElement('div');
    el.className = 'log-entry';

    if (type === 'ai_response') {
      // Agent — coloured left border (green for success, red for a failure
      // explanation), always expanded. Render markdown (bold, inline code, lists).
      var isFailMsg = msg.charAt(0) === '❌' || msg.indexOf('Build failed') === 0;
      el.className += isFailMsg ? ' log-agent log-agent-fail' : ' log-agent';
      var agentHtml = (typeof marked !== 'undefined') ? marked.parse(msg) : escHtml(msg).split(String.fromCharCode(10)).join('<br>');
      el.innerHTML =
        '<div class="log-agent-header">' +
          '<span class="log-agent-label">Agent</span>' +
          '<span class="log-time">' + ts + '</span>' +
        '</div>' +
        '<div class="log-agent-content markdown-content">' + agentHtml + '</div>';

    } else if (type === 'user_message') {
      // User — purple left border
      el.className += ' log-user';
      el.innerHTML =
        '<div class="log-user-header">' +
          '<span class="log-user-label">You</span>' +
          '<span class="log-time">' + ts + '</span>' +
        '</div>' +
        '<div class="log-user-content">' + escHtml(msg) + '</div>';

    } else if (type === 'agent_action') {
      // LFG Agent action — orange left border
      el.className += ' log-lfg-agent';
      el.innerHTML =
        '<div class="log-lfg-agent-header">' +
          '<span class="log-lfg-agent-label">LFG Agent</span>' +
          '<span class="log-time">' + ts + '</span>' +
        '</div>' +
        '<div class="log-lfg-agent-content">' + escHtml(msg) + '</div>';

    } else if (type === 'cli_error') {
      // CLI Error — red left border, error icon
      el.className += ' log-error';
      el.innerHTML =
        '<div class="log-error-header">' +
          '<span class="log-error-label"><i class="fas fa-exclamation-triangle"></i> CLI Error</span>' +
          '<span class="log-time">' + ts + '</span>' +
        '</div>' +
        '<div class="log-error-content">' + escHtml(msg) + '</div>';

    } else if (type === 'question') {
      // Question — amber/orange, action required
      el.className += ' log-question';
      var optionsHtml = '';
      if (row.options && row.options.length) {
        var btns = row.options.map(function(opt) {
          return '<button class="question-opt-btn" data-opt="' + escHtml(opt) + '" onclick="window._selectOption(this, this.dataset.opt)">' + escHtml(opt) + '</button>';
        }).join('');
        optionsHtml =
          '<div class="question-options">' + btns + '</div>' +
          '<div class="question-custom-hint">or type your own answer below</div>';
      }
      el.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.4rem">' +
          '<span class="log-question-label"><i class="fas fa-question-circle"></i> ACTION REQUIRED</span>' +
          '<span class="log-time">' + ts + '</span>' +
        '</div>' +
        '<div class="log-question-content">' + escHtml(msg) + '</div>' +
        optionsHtml;

    } else {
      // Command / system row. Preferred: a paired row that carries its OWN output
      // (row.output, folded from the agent's tool_result via tool_use_id) — render
      // ONE collapsible: the command as the header, its output as the body. Tag the
      // row with its log id so a tool_result arriving LIVE (later) can attach here.
      // Fallback (un-paired rows, e.g. the Pi stream): the old action-vs-output
      // heuristic — an action starts with '$ ' or a known verb; anything else is
      // treated as muted output. (No regex literal — backslashes get mangled in
      // this .tsx template.)
      var out = (row.output || '');
      var hasOut = out.length > 0;
      if (row.id) el.setAttribute('data-log-id', row.id);
      var _actionVerbs = ['Running','Reading','Editing','Writing','Creating','Searching','Listing','Merging','Merged','Committing','Committed','Pushed','Pushing','Building','Build','Installing','Started','Starting','Cloning','Fetching','Continuing','Spinning','Restarting','Setting up','Verifying'];
      // Emoji-prefixed tool labels (📄 Read, ✏️ Write, 🔍 Grep…) are actions too.
      var isAction = hasOut || msg.charAt(0) === '$' || msg.charCodeAt(0) > 255 || _actionVerbs.some(function(v){ return msg.indexOf(v) === 0; });
      var desc = describeCmd(msg, explanation);
      el.className += isAction ? ' log-cmd' : ' log-cmd log-output';
      var iconHtml = isAction
        ? '<i class="fas fa-terminal log-row-ico"></i>'
        : '<i class="fas fa-angle-right log-row-ico log-output-ico"></i>';
      var label = isAction
        ? '<span class="log-cmd-text">' + escHtml(desc) + '</span>'
        : '<span class="log-out-tag">output</span><span class="log-cmd-text log-output-text">' + escHtml(desc) + '</span>';
      // Body = the paired output when present (the whole point), else the full msg.
      var bodyText = hasOut ? out : msg;
      el.innerHTML =
        '<div class="log-cmd-header">' +
          iconHtml +
          '<i id="' + rowId + '-chev" class="fas fa-chevron-right log-chev"></i>' +
          label +
          '<span class="log-time">' + ts + '</span>' +
        '</div>' +
        '<div id="' + rowId + '" class="log-cmd-body">' + escHtml(bodyText) + '</div>';
      el.querySelector('.log-cmd-header').onclick = function() { toggleCmd(rowId); };
    }
    return el;
  }

  function toggleCmd(id) {
    var details = document.getElementById(id);
    var chev = document.getElementById(id + '-chev');
    if (!details) return;
    var showing = details.style.display === 'block';
    details.style.display = showing ? 'none' : 'block';
    if (chev) chev.style.transform = showing ? '' : 'rotate(90deg)';
  }

  var _logsFirstLoad = true;
  var _agentThinking = false;

  // Scroll the Actions log to the latest (bottom). The actual overflow element
  // depends on the height chain — it can be #actions-log-area OR its .drawer-body
  // ancestor — so scroll BOTH. Retry across frames + timers because the tab may
  // have just become visible (display change) and log rows / markdown render async,
  // so scrollHeight isn't final on the first frame.
  function scrollActionsBottom() {
    var area = document.getElementById('actions-log-area');
    if (!area) return;
    var body = area.closest('.drawer-body');
    var go = function() {
      area.scrollTop = area.scrollHeight;
      if (body) body.scrollTop = body.scrollHeight;
    };
    requestAnimationFrame(function() { requestAnimationFrame(go); });
    setTimeout(go, 60);
    setTimeout(go, 250);
  }

  async function loadExecutionLogs() {
    if (!_currentTicketId) return;
    try {
      var res = await fetch('/api/projects/' + PROJECT_ID + '/tickets/' + _currentTicketId + '/logs');
      var rows = await res.json();
      var area = document.getElementById('actions-log-area');
      if (!area) return;
      if (!rows.length) {
        area.innerHTML = '<div class="log-placeholder">' +
          '<i class="fas fa-terminal" style="font-size:1.5rem;margin-bottom:.75rem;display:block;opacity:.4;"></i>' +
          'No execution logs yet.<br>Logs will appear here when the ticket is built.</div>';
        _lastLogCount = 0;
        _logsFirstLoad = true;
        return;
      }
      var contentKey = rows.length + ':' + (rows[rows.length - 1].id || rows[rows.length - 1].createdAt || '');
      if (contentKey === _lastLogContent) return;
      _lastLogContent = contentKey;
      _lastLogCount = rows.length;

      updateActionsBanner();

      var scrollContainer = area /* the .execution-logs-container is the real overflow scroller */;
      var shouldScroll = _logsFirstLoad || (scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight < 60);
      area.innerHTML = '';

      rows.forEach(function(row, idx) {
        area.appendChild(renderLogEntry(row, idx));
      });

      // Logs are now in the DOM — refresh the banner so a failed build shows its reason.
      if (ticketMap[_currentTicketId]) updateTicketStatusBanner(ticketMap[_currentTicketId]);

      // Re-add thinking indicator if agent is still processing
      if (_agentThinking && !document.getElementById('agent-thinking')) {
        var thinkEl = document.createElement('div');
        thinkEl.id = 'agent-thinking';
        thinkEl.className = 'log-entry log-agent';
        thinkEl.innerHTML = '<div class="log-agent-header">' +
          '<span class="log-agent-label">AGENT</span>' +
          '<span class="agent-thinking-dots">Thinking...</span>' +
          '</div>';
        area.appendChild(thinkEl);
      }

      if (shouldScroll) scrollActionsBottom();
      _logsFirstLoad = false;
    } catch(e) { console.error('loadExecutionLogs', e); }
  }

  async function updateActionsBanner() {
    if (!_currentTicketId) return;
    try {
      var resp = await fetch('/api/projects/' + PROJECT_ID + '/tickets/' + _currentTicketId).then(function(r) { return r.json(); });
      var ticket = resp && resp.ticket ? resp.ticket : resp;
      var branch = ticket.github_branch || ticket.githubBranch;
      var sha = ticket.github_commit_sha || ticket.githubCommitSha;
      var banner = document.getElementById('actions-git-banner');
      if (banner && branch) {
        document.getElementById('actions-git-branch').textContent = branch;
        document.getElementById('actions-git-sha').textContent = sha ? sha.slice(0, 7) : '';
        banner.style.display = 'block';
      }
    } catch(e) {}
  }

  function escHtml(s) {
    const m = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'};
    return String(s).replace(/[&<>"]/g, function(c) { return m[c] || c; });
  }

  var _thinkingTimeout = null;
  function showThinkingIndicator() {
    _agentThinking = true;
    if (_thinkingTimeout) clearTimeout(_thinkingTimeout);
    // Safety: auto-hide after 2 minutes
    _thinkingTimeout = setTimeout(function() { hideThinkingIndicator(); }, 120000);
    if (document.getElementById('agent-thinking')) return;
    var area = document.getElementById('actions-log-area');
    if (!area) return;
    var el = document.createElement('div');
    el.id = 'agent-thinking';
    el.className = 'log-entry log-agent';
    el.innerHTML = '<div class="log-agent-header">' +
      '<span class="log-agent-label">AGENT</span>' +
      '<span class="agent-thinking-dots">Thinking...</span>' +
      '</div>';
    area.appendChild(el);
    scrollActionsBottom();
  }

  function hideThinkingIndicator() {
    _agentThinking = false;
    if (_thinkingTimeout) { clearTimeout(_thinkingTimeout); _thinkingTimeout = null; }
    var el = document.getElementById('agent-thinking');
    if (el) el.remove();
  }

  // The file attached to the NEXT chat message (uploaded into the ticket sandbox).
  var _pendingUpload = null;
  window.uploadTicketFile = async function(file) {
    if (!file || !_currentTicketId) return;
    var chip = document.getElementById('actions-attach-chip');
    if (chip) { chip.style.display = 'flex'; chip.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading ' + escHtml(file.name) + '…'; }
    // Never hang forever — abort after 90s and surface a clear error.
    var ctrl = new AbortController();
    var to = setTimeout(function() { ctrl.abort(); }, 90000);
    try {
      var fd = new FormData(); fd.append('file', file);
      var r = await fetch('/api/projects/' + PROJECT_ID + '/tickets/' + _currentTicketId + '/chat/upload', { method: 'POST', body: fd, signal: ctrl.signal });
      var j = await r.json();
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      _pendingUpload = { path: j.path, url: j.url, name: file.name, isImage: j.isImage, inSandbox: j.inSandbox };
      var thumb = (j.isImage && j.url) ? '<img src="' + j.url + '" style="height:26px;width:26px;object-fit:cover;border-radius:4px;" />' : '<i class="fas fa-paperclip"></i>';
      var note = j.inSandbox ? '' : ' (attached — the agent gets it on the next build)';
      if (chip) chip.innerHTML = thumb + ' <span>' + escHtml(file.name) + escHtml(note) + '</span> <span style="cursor:pointer;color:var(--text-secondary);margin-left:.3rem;" onclick="clearTicketUpload()">✕</span>';
    } catch (e) {
      if (chip) { chip.style.display = 'none'; }
      var m = (e && e.name === 'AbortError') ? 'timed out (file too large or sandbox unreachable)' : (e && e.message) || 'error';
      if (typeof toast === 'function') toast('Upload failed: ' + m); else alert('Upload failed: ' + m);
    } finally {
      clearTimeout(to);
      var fi = document.getElementById('actions-file-input'); if (fi) fi.value = '';
    }
  };
  window.clearTicketUpload = function() {
    _pendingUpload = null;
    var chip = document.getElementById('actions-attach-chip');
    if (chip) { chip.style.display = 'none'; chip.innerHTML = ''; }
  };

  async function sendTicketChatMsg() {
    var input = document.getElementById('actions-chat-input');
    var msg = input.value.trim();
    // Allow sending with just an attachment (no text).
    if ((!msg && !_pendingUpload) || !_currentTicketId) return;
    input.value = '';
    // Fold the uploaded file reference into the message so the agent can find it.
    var _upload = null;
    if (_pendingUpload) {
      _upload = _pendingUpload;
      var _nl2 = String.fromCharCode(10) + String.fromCharCode(10);
      var ref = _upload.path
        ? 'I uploaded a file to ' + _upload.path + ' (original name: ' + _upload.name + '). Use it as needed.'
        : 'I attached a file (' + _upload.name + ') available at ' + _upload.url + '. It will be placed in the sandbox on the next build.';
      msg = (msg ? msg + _nl2 : '') + ref;
      clearTicketUpload();
    }
    // Optimistically render YOUR message immediately, BEFORE the thinking bubble,
    // so it always appears first (don't wait for the server round-trip / poll).
    var area = document.getElementById('actions-log-area');
    if (area) {
      var ph = area.querySelector('.log-placeholder');
      if (ph) area.innerHTML = '';
      area.appendChild(renderLogEntry({ type: 'user_message', message: msg, createdAt: new Date().toISOString() }, 'you-' + Date.now()));
      // Show the uploaded image inline in the thread.
      if (_upload && _upload.isImage && _upload.url) {
        var imgEl = document.createElement('div');
        imgEl.className = 'log-entry log-user';
        imgEl.innerHTML = '<a href="' + _upload.url + '" target="_blank" rel="noopener"><img src="' + _upload.url + '" alt="' + escHtml(_upload.name) + '" style="max-width:220px;max-height:180px;border-radius:8px;border:1px solid var(--border-color,#2a2a2a);" /></a>';
        area.appendChild(imgEl);
      }
    }
    // Then show thinking indicator (appended after your message).
    showThinkingIndicator();
    try {
      var resp = await fetch('/api/projects/' + PROJECT_ID + '/tickets/' + _currentTicketId + '/chat', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ message: msg })
      });
      if (!resp.ok) {
        var err = await resp.json().catch(function() { return { error: 'Failed' }; });
        console.error('sendTicketChatMsg error:', err);
        hideThinkingIndicator();
      }
      _lastLogCount = 0; _lastLogContent = ''; _logsFirstLoad = true;
      // Poll for new logs in case WS misses the broadcast
      var chatPollCount = 0;
      var chatPollTimer = setInterval(function() {
        chatPollCount++;
        loadExecutionLogs();
        // Stop polling after 30s or if thinking is done
        if (!_agentThinking || chatPollCount > 10) clearInterval(chatPollTimer);
      }, 3000);
    } catch(e) { console.error('sendTicketChatMsg', e); hideThinkingIndicator(); }
  }

  // ── Option selection for askUser questions ──────────────────────
  window._selectOption = function(btnEl, text) {
    var input = document.getElementById('actions-chat-input');
    if (input) input.value = text;
    sendTicketChatMsg();
    // Disable all option buttons in this question block
    var container = btnEl.closest('.question-options');
    if (container) {
      var buttons = container.querySelectorAll('.question-opt-btn');
      for (var i = 0; i < buttons.length; i++) {
        buttons[i].disabled = true;
        buttons[i].classList.add('question-opt-disabled');
      }
    }
  };

  // ── Tasks tab ────────────────────────────────────────────────────
  function showTaskForm() {
    document.getElementById('task-add-form').style.display = 'flex';
    document.getElementById('task-add-btn').style.display = 'none';
    document.getElementById('task-add-input').focus();
  }
  function hideTaskForm() {
    document.getElementById('task-add-form').style.display = 'none';
    document.getElementById('task-add-btn').style.display = '';
    document.getElementById('task-add-input').value = '';
  }
  async function addNewTask() {
    var input = document.getElementById('task-add-input');
    var desc = input.value.trim();
    if (!desc || !_currentTicketId) return;
    input.value = '';
    try {
      await fetch('/api/projects/' + PROJECT_ID + '/tickets/' + _currentTicketId + '/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tasks: [{ description: desc }] })
      });
      loadTasks();
    } catch(e) { console.error('addNewTask', e); }
  }
  async function deleteTask(taskId) {
    if (!_currentTicketId) return;
    try {
      await fetch('/api/projects/' + PROJECT_ID + '/tickets/' + _currentTicketId + '/tasks/' + taskId, {
        method: 'DELETE'
      });
      loadTasks();
    } catch(e) { console.error('deleteTask', e); }
  }
  // ── Ticket Addenda (follow-up change requests) ──────────────────────
  async function loadAddenda() {
    if (!_currentTicketId) return;
    var list = document.getElementById('addenda-list');
    try {
      var r = await fetch('/api/projects/' + PROJECT_ID + '/tickets/' + _currentTicketId + '/addenda');
      var j = await r.json();
      _renderAddenda((j && j.addenda) || []);
    } catch (e) { if (list) list.innerHTML = '<div class="placeholder-pane"><p>Failed to load addenda.</p></div>'; }
  }
  function _renderAddenda(items) {
    var list = document.getElementById('addenda-list');
    var badge = document.getElementById('addenda-count');
    if (!list) return;
    var pending = items.filter(function(a){ return a.status === 'pending'; }).length;
    if (badge) { if (pending > 0) { badge.style.display = ''; badge.textContent = pending; } else { badge.style.display = 'none'; } }
    if (!items.length) { list.innerHTML = '<div class="placeholder-pane"><i class="fas fa-plus-circle"></i><p>No change requests yet</p></div>'; return; }
    list.innerHTML = items.map(function(a){
      var resolved = a.status === 'resolved';
      var when = fmtLogTime(a.createdAt);
      return '<div class="addendum-item' + (resolved ? ' resolved' : '') + '">'
        + '<div class="addendum-text">' + escHtml(a.description || '') + '</div>'
        + '<div class="addendum-meta">'
          + '<span class="addendum-status">' + (resolved ? 'Resolved' : 'Pending') + '</span>'
          + '<span>' + escHtml(when) + '</span>'
          + (resolved ? '' : '<button class="addendum-act" data-resolve="' + a.id + '">Mark resolved</button>')
          + '<button class="addendum-act addendum-del" data-del="' + a.id + '">Delete</button>'
        + '</div>'
      + '</div>';
    }).join('');
    // Delegated actions (avoids inline onclick with quoted ids in this template).
    list.onclick = function(e){
      var rb = e.target.closest('[data-resolve]');
      var dl = e.target.closest('[data-del]');
      if (rb) resolveAddendum(rb.getAttribute('data-resolve'));
      else if (dl) deleteAddendum(dl.getAttribute('data-del'));
    };
  }
  async function submitAddendum() {
    var input = document.getElementById('addendum-input');
    var v = ((input && input.value) || '').trim();
    if (!v || !_currentTicketId) return;
    input.value = '';
    try {
      await fetch('/api/projects/' + PROJECT_ID + '/tickets/' + _currentTicketId + '/addenda', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: v }) });
      loadAddenda();
    } catch (e) { if (typeof toast === 'function') toast('Failed to add: ' + e.message); }
  }
  window.submitAddendum = submitAddendum;
  async function resolveAddendum(id) {
    try { await fetch('/api/projects/' + PROJECT_ID + '/tickets/' + _currentTicketId + '/addenda/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'resolved' }) }); loadAddenda(); } catch (e) {}
  }
  window.resolveAddendum = resolveAddendum;
  async function deleteAddendum(id) {
    try { await fetch('/api/projects/' + PROJECT_ID + '/tickets/' + _currentTicketId + '/addenda/' + id, { method: 'DELETE' }); loadAddenda(); } catch (e) {}
  }
  window.deleteAddendum = deleteAddendum;

  async function loadTasks() {
    if (!_currentTicketId) return;
    try {
      const res = await fetch('/api/projects/' + PROJECT_ID + '/tickets/' + _currentTicketId + '/tasks');
      const tasks = await res.json();
      const list = document.getElementById('tasks-list');
      if (!list) return;
      if (!tasks.length) {
        list.innerHTML = '<div class="placeholder-pane"><i class="fas fa-list-check"></i><p>No tasks yet</p></div>';
        return;
      }
      const statusIcon = { pending:'○', in_progress:'◑', success:'●', fail:'✕' };
      const statusColor = { pending:'var(--text-secondary)', in_progress:'#f59e0b', success:'#34d399', fail:'#f87171' };
      list.innerHTML = tasks.map(t => {
        const icon = statusIcon[t.status] || '○';
        const color = statusColor[t.status] || 'var(--text-secondary)';
        return '<div class="task-item">'
          + '<span class="task-status-icon" style="color:' + color + ';">' + icon + '</span>'
          + '<span class="task-description">' + escHtml(t.description || '') + '</span>'
          + '<button data-delete-task="' + t.id + '" class="task-delete-btn" title="Delete task">'
          + '<i class="fas fa-times"></i></button>'
          + '</div>';
      }).join('');
      // Event delegation for delete buttons
      list.querySelectorAll('[data-delete-task]').forEach(function(btn) {
        btn.onclick = function() { deleteTask(btn.getAttribute('data-delete-task')); };
      });
    } catch(e) { console.error('loadTasks', e); }
  }

  // ── Preview tab ──────────────────────────────────────────────────
  async function loadSandboxInfo() {
    if (!_currentTicketId) return;
    try {
      const res = await fetch('/api/projects/' + PROJECT_ID + '/tickets/' + _currentTicketId + '/sandbox');
      if (!res.ok) return;
      const sb = await res.json();
      if (!sb) return;
      const label = document.getElementById('preview-url-label');
      const link = document.getElementById('preview-open-link');
      const iframe = document.getElementById('preview-iframe');
      if (sb.previewUrl) {
        label.textContent = sb.previewUrl;
        link.href = sb.previewUrl;
        link.style.display = 'inline-flex';
        iframe.src = sb.previewUrl;
      }
    } catch(e) { console.error('loadSandboxInfo', e); }
  }

  async function startPreview() {
    if (!_currentTicketId) return;
    const btn = document.getElementById('preview-start-btn');
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Starting…';
    btn.disabled = true;
    try {
      const res = await fetch('/api/projects/' + PROJECT_ID + '/tickets/' + _currentTicketId + '/preview', {
        method: 'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ action: 'start' })
      });
      const data = await res.json();
      if (data.error) {
        console.error('startPreview error:', data.error);
        alert('Preview failed: ' + data.error);
      } else if (data.previewUrl) {
        document.getElementById('preview-url-label').textContent = data.previewUrl;
        const link = document.getElementById('preview-open-link');
        link.href = data.previewUrl; link.style.display = 'inline-flex';
        document.getElementById('preview-iframe').src = data.previewUrl;
      }
    } catch(e) { console.error('startPreview', e); }
    btn.innerHTML = '<i class="fas fa-play"></i> Start';
    btn.disabled = false;
  }

  async function restartPreview() {
    if (!_currentTicketId) return;
    try {
      await fetch('/api/projects/' + PROJECT_ID + '/tickets/' + _currentTicketId + '/preview', {
        method: 'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ action: 'restart' })
      });
      setTimeout(loadSandboxInfo, 4000);
    } catch(e) { console.error('restartPreview', e); }
  }

  // ── Git tab ──────────────────────────────────────────────────────
  var _gitStatusColors = { pending:'#6b7280', pr_open:'#3b82f6', pushed:'#3b82f6', merged:'#34d399', failed:'#f87171', not_pushed:'#f87171' };
  var _gitRepo = null;   // { provider, cloneUrl, webUrl, webIdeUrl, hasRepo } for the ticket's project
  var _gitBranch = '';   // this ticket's feature branch
  var _gitStatusLabels = { not_pushed:'Not pushed', pushed:'Pushed (not merged)' };

  async function loadGitInfo() {
    if (!_currentTicketId) return;
    const info = document.getElementById('git-info');
    if (!info) return;

    const resp = await fetch('/api/projects/' + PROJECT_ID + '/tickets/' + _currentTicketId)
      .then(r => r.json()).catch(() => null);
    if (!resp || !resp.ticket) return;
    const ticket = resp.ticket;

    const branch = ticket.githubBranch || ticket.github_branch || '';
    _gitRepo = resp.repo || null;
    _gitBranch = branch;
    const sha = ticket.githubCommitSha || ticket.github_commit_sha || '';
    const shortSha = sha ? sha.slice(0, 7) : '';
    const mergeStatus = ticket.githubMergeStatus || ticket.github_merge_status || '';
    const prUrl = ticket.githubPrUrl || '';
    const rawPrNum = ticket.githubPrNumber;
    const prNumber = (typeof rawPrNum === 'number' && rawPrNum > 0) ? rawPrNum : null;
    const statusColor = _gitStatusColors[mergeStatus] || '#6b7280';
    const statusLabel = _gitStatusLabels[mergeStatus] || (mergeStatus ? mergeStatus.replace(/_/g, ' ') : 'none');
    const notPushed = mergeStatus === 'not_pushed';

    var html = '<div class="git-info-grid">';

    // Branch
    html += '<div class="git-field">'
      + '<span class="git-label">Branch</span>'
      + (branch
        ? '<code class="git-branch-badge">' + escHtml(branch) + '</code>'
        : '<span class="git-empty">No branch yet</span>')
      + '</div>';

    // Last Commit (+ when it was built, so the SHA isn't a dateless mystery)
    var commitWhen = ticket.lastExecutionAt || ticket.last_execution_at || ticket.updatedAt || ticket.updated_at || '';
    html += '<div class="git-field">'
      + '<span class="git-label">Last Commit</span>'
      + '<span style="display:inline-flex;align-items:center;gap:0.5rem;flex-wrap:wrap;">'
      + '<code class="git-value">' + (shortSha || '—') + '</code>'
      + (shortSha && commitWhen ? '<span class="git-empty" style="font-size:0.75rem;">' + escHtml(fmtLogTime(commitWhen)) + '</span>' : '')
      + '</span>'
      + '</div>';

    // Merge Status badge
    html += '<div class="git-field">'
      + '<span class="git-label">Merge Status</span>'
      + '<span style="display:inline-flex;align-items:center;gap:0.4rem;">'
      + '<span style="width:8px;height:8px;border-radius:50%;background:' + statusColor + ';display:inline-block;"></span>'
      + '<span class="git-value">' + escHtml(statusLabel) + '</span>'
      + '</span>'
      + '</div>';

    // Loud warning when the build finished but was NOT pushed (no repo/token or a
    // failed push) — the work only lives in the sandbox, so make it impossible to miss.
    if (notPushed) {
      html += '<div style="grid-column:1/-1;margin-top:.25rem;padding:.6rem .75rem;border-radius:8px;'
        + 'background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.3);color:#fca5a5;font-size:.8rem;line-height:1.45;">'
        + '<i class="fas fa-triangle-exclamation" style="margin-right:.4rem;"></i>'
        + '<strong>Changes were not pushed to git.</strong> The repo is not connected or its token expired, so the work is only in the build sandbox. '
        + '<a href="/settings" style="color:#fca5a5;text-decoration:underline;">Reconnect the repository in Settings</a>, then rebuild.'
        + '</div>';
    }

    // Actions
    html += '<div style="display:flex;gap:0.5rem;margin-top:0.25rem;flex-wrap:wrap;align-items:center;">';
    html += '<button onclick="pushToGithub()" id="git-push-btn" class="git-action-btn">'
      + '<i class="fas fa-cloud-upload-alt"></i> Push & Merge to lfg-agent</button>';

    // Open in editor menu (only when we have a real repo to clone).
    if (_gitRepo && _gitRepo.hasRepo && _gitRepo.cloneUrl) {
      html += '<div class="oie-menu" style="position:relative;display:inline-block;">'
        + '<button type="button" id="oie-btn" class="git-action-btn">'
        + '<i class="fas fa-code"></i> Open in editor <i class="fas fa-caret-down" style="margin-left:2px;"></i></button>'
        + '<div id="oie-dropdown" class="oie-dropdown">'
        + '<button type="button" class="oie-item" data-oie="cursor"><i class="fas fa-i-cursor"></i> Cursor</button>'
        + '<button type="button" class="oie-item" data-oie="vscode"><i class="fas fa-code"></i> VS Code</button>'
        + '<button type="button" class="oie-item" data-oie="windsurf"><i class="fas fa-wind"></i> Windsurf</button>'
        + '<button type="button" class="oie-item" data-oie="antigravity"><i class="fas fa-rocket"></i> Antigravity</button>'
        + '<div class="oie-sep"></div>'
        + '<button type="button" class="oie-item" data-oie="copy"><i class="fas fa-terminal"></i> Copy clone command</button>'
        + (_gitRepo.webIdeUrl ? '<button type="button" class="oie-item" data-oie="web"><i class="fas fa-globe"></i> Open in Web IDE</button>' : '')
        + '</div></div>';
    }
    html += '</div>';

    html += '</div>'; // /git-info-grid

    // Branch diff viewer: this ticket's branch vs a selectable base (default main).
    html += '<div id="git-diff-wrap" style="margin-top:1rem;border-top:1px solid var(--border-color,#2a2a2a);padding-top:1rem;">'
      + '<div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.75rem;">'
      + '<span class="git-label">Changes</span>'
      + '<code class="git-branch-badge">' + escHtml(branch || ('feature/ticket-' + _currentTicketId)) + '</code>'
      + '<span style="color:var(--text-secondary,#9ca3af);">vs</span>'
      + '<select id="git-diff-base" onchange="loadGitDiff(this.value)" style="padding:4px 8px;border-radius:6px;background:var(--border-color,#2a2a2a);color:var(--text-color,#e2e8f0);border:1px solid var(--border-color,#333);font-size:12px;"><option>main</option></select>'
      + '<button onclick="loadGitDiff()" class="git-action-btn" style="padding:4px 10px;"><i class="fas fa-sync-alt"></i></button>'
      + '</div>'
      + '<div id="git-diff-body"><div class="git-empty">Loading diff…</div></div>'
      + '</div>';

    info.innerHTML = html;
    loadGitDiff('main');
  }

  async function loadGitDiff(base) {
    var body = document.getElementById('git-diff-body');
    if (!body || !_currentTicketId) return;
    if (!base) { var _s = document.getElementById('git-diff-base'); base = (_s && _s.value) || 'main'; }
    body.innerHTML = '<div class="git-empty">Loading diff…</div>';
    var data = await fetch('/api/projects/' + PROJECT_ID + '/tickets/' + _currentTicketId + '/git/diff?base=' + encodeURIComponent(base || 'main'))
      .then(function(r){ return r.json(); }).catch(function(){ return null; });
    if (!data) { body.innerHTML = '<div class="git-empty">Failed to load diff.</div>'; return; }
    var sel = document.getElementById('git-diff-base');
    if (sel && Array.isArray(data.branches) && data.branches.length) {
      var cur = data.base || 'main';
      sel.innerHTML = data.branches.map(function(b){ return '<option' + (b === cur ? ' selected' : '') + '>' + escHtml(b) + '</option>'; }).join('');
    }
    if (data.error) { body.innerHTML = '<div class="git-empty">' + escHtml(data.error) + '</div>'; return; }
    // Commit list (multiple commits — e.g. build + chat follow-ups). Shown above
    // the diff so you see every commit on the branch, not just the latest SHA.
    var commitsHtml = '';
    if (Array.isArray(data.commits) && data.commits.length) {
      commitsHtml = '<div style="margin-bottom:.9rem;">'
        + '<div class="git-label" style="margin-bottom:.4rem;">Commits (' + data.commits.length + ')</div>'
        + data.commits.map(function(c){
            var when = c.when ? fmtLogTime(c.when * 1000) : '';
            return '<div style="display:flex;align-items:baseline;gap:.6rem;padding:.25rem 0;border-bottom:1px solid rgba(255,255,255,.04);">'
              + '<code class="git-value" style="flex:none;">' + escHtml(c.sha || '') + '</code>'
              + '<span style="flex:1;font-size:.8rem;color:var(--text-color,#e2e8f0);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escHtml(c.subject || '') + '</span>'
              + '<span class="git-empty" style="flex:none;font-size:.72rem;">' + escHtml(when) + '</span>'
              + '</div>';
          }).join('')
        + '</div>';
    }
    if (!data.files || !data.files.length) { body.innerHTML = commitsHtml + '<div class="git-empty">No file changes between these branches.</div>'; return; }
    body.innerHTML = commitsHtml + renderGitDiff(data);
  }

  var _NL = String.fromCharCode(10); // avoid backslash-escapes in this template
  function _parseDiffByFile(diff) {
    var map = {}; var parts = (diff || '').split(_NL + 'diff --git ');
    for (var idx = 0; idx < parts.length; idx++) {
      var p = parts[idx];
      if (!p.trim()) continue;
      var chunk = (idx === 0 ? p : 'diff --git ' + p);
      var bi = chunk.indexOf(' b/');
      if (bi >= 0) {
        var rest = chunk.slice(bi + 3);
        var nlPos = rest.indexOf(_NL);
        var path = (nlPos >= 0 ? rest.slice(0, nlPos) : rest).trim();
        if (path) map[path] = chunk;
      }
    }
    return map;
  }
  function _renderHunks(block) {
    var lines = (block || '').split(_NL);
    var skips = ['diff --git', 'index ', '--- ', '+++ ', 'new file', 'deleted file', 'similarity ', 'rename '];
    var out = '<pre style="margin:0;font-size:12px;line-height:1.5;font-family:ui-monospace,Menlo,monospace;">';
    for (var k = 0; k < lines.length; k++) {
      var l = lines[k]; var skip = false;
      for (var s = 0; s < skips.length; s++) { if (l.indexOf(skips[s]) === 0) { skip = true; break; } }
      if (skip) continue;
      var c0 = l.charAt(0);
      var bg = '', color = 'var(--text-color,#cbd5e1)';
      if (l.indexOf('@@') === 0) { bg = 'rgba(99,102,241,0.12)'; color = '#818cf8'; }
      else if (c0 === '+') { bg = 'rgba(52,211,153,0.12)'; color = '#34d399'; }
      else if (c0 === '-') { bg = 'rgba(248,113,113,0.12)'; color = '#f87171'; }
      out += '<div style="background:' + bg + ';color:' + color + ';padding:0 10px;white-space:pre-wrap;word-break:break-all;">' + escHtml(l || ' ') + '</div>';
    }
    return out + '</pre>';
  }
  function renderGitDiff(data) {
    var totA = 0, totR = 0; data.files.forEach(function(f){ totA += f.added; totR += f.removed; });
    var out = '<div style="font-size:12px;color:var(--text-secondary,#9ca3af);margin-bottom:0.6rem;">' + data.files.length + ' file' + (data.files.length > 1 ? 's' : '') + ' changed · <span style="color:#34d399;">+' + totA + '</span> <span style="color:#f87171;">-' + totR + '</span></div>';
    var blocks = _parseDiffByFile(data.diff || '');
    var openAll = data.files.length <= 4;
    data.files.forEach(function(f){
      out += '<details' + (openAll ? ' open' : '') + ' style="margin-bottom:0.5rem;border:1px solid var(--border-color,#2a2a2a);border-radius:8px;overflow:hidden;">'
        + '<summary style="cursor:pointer;padding:8px 12px;background:var(--background-surface,#141414);display:flex;justify-content:space-between;align-items:center;font-size:12.5px;gap:8px;">'
        + '<span style="font-family:ui-monospace,Menlo,monospace;word-break:break-all;">' + escHtml(f.path) + '</span>'
        + '<span style="flex:none;"><span style="color:#34d399;">+' + f.added + '</span> <span style="color:#f87171;">-' + f.removed + '</span></span>'
        + '</summary><div style="overflow:auto;max-height:480px;">' + _renderHunks(blocks[f.path]) + '</div></details>';
    });
    return out;
  }

  async function pushToGithub() {
    if (!_currentTicketId) return;
    var btn = document.getElementById('git-push-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Pushing…'; }
    try {
      var res = await fetch('/api/projects/' + PROJECT_ID + '/tickets/' + _currentTicketId + '/git/push', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }
      });
      var data = await res.json();
      if (!res.ok) { alert(data.error || 'Failed to push'); }
      else {
        var msg = 'Pushed ' + (data.sha || '').slice(0, 7) + ' to ' + (data.branch || '');
        if (data.mergeStatus === 'merged') msg += ' and merged to lfg-agent';
        alert(msg);
      }
      loadGitInfo();
    } catch(e) { alert('Failed: ' + e.message); }
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-cloud-upload-alt"></i> Push & Merge to lfg-agent'; }
  }


  // ── Server logs tab ──────────────────────────────────────────────
  var _serverLogOffset = 0;
  var _serverLogTimer = null;

  async function refreshServerLogs() {
    if (!_currentTicketId) return;
    var area = document.getElementById('server-logs-area');
    if (!area) return;
    try {
      var res = await fetch('/api/projects/' + PROJECT_ID + '/tickets/' + _currentTicketId + '/server-logs?offset=' + _serverLogOffset);
      if (!res.ok) return;
      var data = await res.json();
      if (data.lines && data.lines.length > 0) {
        data.lines.forEach(function(line) {
          var div = document.createElement('div');
          div.className = 'server-log-line';
          if (/error/i.test(line)) div.classList.add('server-log-error');
          else if (/warn/i.test(line)) div.classList.add('server-log-warn');
          div.textContent = line;
          area.appendChild(div);
        });
        area.scrollTop = area.scrollHeight;
      }
      if (data.newOffset !== undefined) _serverLogOffset = data.newOffset;

      // Show empty state if still nothing
      if (_serverLogOffset === 0 && area.children.length === 0) {
        area.innerHTML = '<div class="server-log-empty">No server logs yet. Start the preview to see logs.</div>';
      }
    } catch(e) { console.error('refreshServerLogs', e); }
    // Continue polling while on this tab
    startServerLogPolling();
  }

  function startServerLogPolling() {
    stopServerLogPolling();
    _serverLogTimer = setTimeout(refreshServerLogs, 3000);
  }

  function stopServerLogPolling() {
    if (_serverLogTimer) { clearTimeout(_serverLogTimer); _serverLogTimer = null; }
  }

  function toggleDrawerMore() {
    document.getElementById('drawer-more-dropdown').classList.toggle('open');
  }
  document.addEventListener('click', e => {
    if (!e.target.closest('.drawer-more-menu')) {
      document.getElementById('drawer-more-dropdown')?.classList.remove('open');
    }
  });

  // Download the raw Pi JSONL stream / the exact composite prompt from the ticket's
  // sandbox (Pi's files live at /data/.pi and are auto-cleaned ~30min after a run).
  function downloadPiOutput() {
    document.getElementById('drawer-more-dropdown')?.classList.remove('open');
    if (!_currentTicketId) return;
    window.open('/api/projects/' + PROJECT_ID + '/tickets/' + _currentTicketId + '/pi-output', '_blank');
  }
  function downloadPiPrompt() {
    document.getElementById('drawer-more-dropdown')?.classList.remove('open');
    if (!_currentTicketId) return;
    window.open('/api/projects/' + PROJECT_ID + '/tickets/' + _currentTicketId + '/pi-prompt', '_blank');
  }

  function shareCurrentTicket() {
    if (!_currentTicketId) return;
    openShareModal('ticket', _currentTicketId, PROJECT_ID);
  }

  async function clearTicketLogs() {
    if (!_currentTicketId) return;
    document.getElementById('drawer-more-dropdown')?.classList.remove('open');
    if (!confirm('Clear all run logs for this ticket? (Git/build state is untouched.)')) return;
    try {
      await fetch('/api/projects/' + PROJECT_ID + '/tickets/' + _currentTicketId + '/logs', { method: 'DELETE' });
    } catch(e) {}
    var area = document.getElementById('actions-log-area');
    if (area) area.innerHTML = '';
    _lastLogContent = '';
    _lastFailureReason = '';
  }

  // ── Open in editor (Git tab) ─────────────────────────────────────
  var _gitToastTimer = null;
  function _oieLabel(k) {
    if (k === 'vscode') return 'VS Code';
    if (k === 'windsurf') return 'Windsurf';
    if (k === 'antigravity') return 'Antigravity';
    return 'Cursor';
  }
  function _copyText(t) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(t); return; }
    } catch(e) {}
    try {
      var ta = document.createElement('textarea');
      ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      document.execCommand('copy'); ta.remove();
    } catch(e) {}
  }
  function _gitToast(msg) {
    var t = document.getElementById('_git-toast');
    if (!t) {
      t = document.createElement('div'); t.id = '_git-toast';
      t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:99999;background:#1f2937;color:#e5e7eb;padding:10px 16px;border-radius:8px;font-size:13px;line-height:1.4;box-shadow:0 4px 20px rgba(0,0,0,.4);border:1px solid rgba(139,92,246,.45);max-width:80vw;text-align:center;opacity:0;transition:opacity .2s ease;';
      document.body.appendChild(t);
    }
    t.textContent = msg; t.style.opacity = '1';
    clearTimeout(_gitToastTimer);
    _gitToastTimer = setTimeout(function(){ t.style.opacity = '0'; }, 3600);
  }
  function openInEditor(kind) {
    document.getElementById('oie-dropdown')?.classList.remove('open');
    if (!_gitRepo || !_gitRepo.cloneUrl) return;
    var url = _gitRepo.cloneUrl;
    var branch = _gitBranch || '';
    var dir = _gitRepo.name || 'repo';
    if (kind === 'web') {
      if (_gitRepo.webIdeUrl) window.open(_gitRepo.webIdeUrl, '_blank');
      return;
    }
    if (kind === 'copy') {
      var cmd = branch
        ? 'git clone -b ' + branch + ' ' + url + ' ' + dir + ' && cd ' + dir
        : 'git clone ' + url + ' ' + dir + ' && cd ' + dir;
      _copyText(cmd);
      _gitToast('Clone command copied — paste it in your terminal');
      return;
    }
    // Editor deep-link clone. Deep links can't carry a branch, so copy the
    // checkout command to the clipboard for a one-paste follow-up.
    var deeplink = kind + '://vscode.git/clone?url=' + encodeURIComponent(url);
    if (branch) _copyText('git fetch origin ' + branch + ' && git checkout ' + branch);
    var a = document.createElement('a');
    a.href = deeplink; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(function(){ a.remove(); }, 0);
    _gitToast(branch
      ? 'Opening ' + _oieLabel(kind) + ' — branch checkout copied, paste in its terminal after clone'
      : 'Opening ' + _oieLabel(kind) + '…');
  }
  document.addEventListener('click', function(e) {
    if (!e.target || !e.target.closest) return;
    if (e.target.closest('#oie-btn')) {
      e.preventDefault();
      document.getElementById('oie-dropdown')?.classList.toggle('open');
      return;
    }
    var item = e.target.closest('.oie-item');
    if (item) { e.preventDefault(); openInEditor(item.getAttribute('data-oie')); return; }
    if (!e.target.closest('.oie-menu')) {
      document.getElementById('oie-dropdown')?.classList.remove('open');
    }
  });

  async function deleteCurrentTicket() {
    if (!_currentTicketId) return;
    if (!confirm('Delete this ticket?')) return;
    try {
      const res = await fetch('/projects/' + PROJECT_ID + '/api/checklist/' + _currentTicketId + '/delete', { method: 'DELETE' });
      if (res.ok) { closeTicketDrawer(); location.reload(); }
    } catch(e) { alert('Failed to delete ticket'); }
  }

  function filterTickets() {
    const q = document.getElementById('ticket-search').value.toLowerCase();
    const status = document.getElementById('filter-status').value;
    const priority = document.getElementById('filter-priority').value;
    document.querySelectorAll('.kanban-card').forEach(card => {
      const name = card.querySelector('.kanban-card-title')?.textContent?.toLowerCase() || '';
      const s = card.dataset.status;
      const p = card.dataset.priority;
      const show = (!q || name.includes(q)) && (!status || s === status) && (!priority || p === priority);
      card.style.display = show ? '' : 'none';
    });
  }

  // Drag & drop
  let _dragId = null;
  document.querySelectorAll('.kanban-card').forEach(card => {
    card.addEventListener('dragstart', e => {
      _dragId = card.dataset.ticketId;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => { card.classList.remove('dragging'); _dragId = null; });
  });
  document.querySelectorAll('.kanban-column-body').forEach(col => {
    col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('drag-over'); });
    col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
    col.addEventListener('drop', async e => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const stageId = col.dataset.stageId;
      if (!_dragId || !stageId) return;
      try {
        await fetch('/projects/' + PROJECT_ID + '/api/checklist/' + _dragId + '/stage', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stageId })
        });
        location.reload();
      } catch(e) { console.error('Move failed', e); }
    });
  });

  // Drawer resize (remembers width in localStorage)
  (function() {
    const handle = document.getElementById('drawer-resize-handle');
    const drawer = document.getElementById('ticket-drawer');
    const KEY = 'ticketDrawerWidth';
    // Restore a saved width (clamped to the current viewport).
    var saved = parseInt(localStorage.getItem(KEY) || '', 10);
    if (saved && !isNaN(saved)) {
      drawer.style.width = Math.max(400, Math.min(window.innerWidth * 0.95, saved)) + 'px';
    }
    let resizing = false, startX = 0, startW = 0;
    handle.addEventListener('mousedown', e => {
      resizing = true; startX = e.clientX; startW = drawer.offsetWidth;
      drawer.classList.add('resizing');
      document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', e => {
      if (!resizing) return;
      const newW = Math.max(400, Math.min(window.innerWidth * 0.85, startW + (startX - e.clientX)));
      drawer.style.width = newW + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (resizing) {
        resizing = false; drawer.classList.remove('resizing'); document.body.style.userSelect = '';
        try { localStorage.setItem(KEY, String(drawer.offsetWidth)); } catch(e) {}
      }
    });
  })();

  // ── WebSocket for live log updates ───────────────────────────────
  (function() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var wsUrl = proto + '//' + location.host + '/ws/chat';
    var ws = null;
    var reconnectTimer = null;

    function connectWS() {
      try {
        ws = new WebSocket(wsUrl);
      } catch(e) { console.warn('[ws] connect error', e); return; }

      ws.onopen = function() {
        console.log('[ws] connected for live ticket logs');
      };

      ws.onmessage = function(evt) {
        try {
          var msg = JSON.parse(evt.data);
          if (msg.type === 'ticket_log' && msg.ticketId === _currentTicketId) {
            console.log('[ws] live log:', msg.log.type, msg.log.message?.slice(0, 80));
            appendLiveLog(msg.log);
          } else if (msg.type === 'ticket_log_output' && msg.ticketId === _currentTicketId) {
            attachOutputToRow(msg.logId, msg.output);
          } else if (msg.type === 'tasks_updated' && msg.ticketId === _currentTicketId) {
            // Subtasks changed during the build (seeded / status updated) — refresh
            // the Tasks tab live so progress shows as it happens.
            loadTasks();
          } else if (msg.type === 'ticket_status') {
            handleTicketStatus(msg);
          } else if (msg.type === 'ticket_demo' && msg.ticketId === _currentTicketId) {
            if (msg.status === 'running') {
              var _db = document.getElementById('preview-demo');
              if (_db) { _db.style.display = 'block'; _db.innerHTML = '<div style="padding:10px 0;color:#888;font-size:13px;"><i class="fas fa-spinner fa-spin"></i> Recording demo…</div>'; }
            } else {
              refreshTicketDemo();
            }
          }
        } catch(e) {}
      };

      ws.onclose = function() {
        console.log('[ws] disconnected, reconnecting in 5s...');
        reconnectTimer = setTimeout(connectWS, 5000);
      };

      ws.onerror = function() {
        // onclose will fire after onerror
      };
    }

    // A tool_result arrived for a command already on screen — fold its output into
    // that command's collapsible body instead of adding a second, orphan row.
    function attachOutputToRow(logId, output) {
      if (!logId) return;
      var row = document.querySelector('[data-log-id="' + logId + '"]');
      if (!row) return;
      var body = row.querySelector('.log-cmd-body');
      if (body) body.textContent = output || '';
      row.classList.remove('log-output');
      row.classList.add('log-cmd');
      var chev = row.querySelector('.log-chev');
      if (chev) chev.style.display = '';
    }

    function appendLiveLog(log) {
      var area = document.getElementById('actions-log-area');
      if (!area) return;
      // Check if we are on Actions tab
      var actionsTab = document.getElementById('tab-actions');
      if (!actionsTab || !actionsTab.classList.contains('active')) return;

      // Hide thinking indicator when agent responds
      if (log.type !== 'user_message') hideThinkingIndicator();

      var placeholder = area.querySelector('.log-placeholder');
      if (placeholder) area.innerHTML = '';

      var idx = area.children.length;
      var wasAtBottom = !area.children.length || (area.scrollHeight - area.scrollTop - area.clientHeight < 120);
      area.appendChild(renderLogEntry(log, 'live-' + idx));

      if (wasAtBottom) scrollActionsBottom();
      _lastLogCount = area.children.length;
      _lastLogContent = '';
    }

    connectWS();
  })();

  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.documentElement.classList.remove('sidebar-minimized-preload');
  }));
</script>
</body>
</html>`;
}
