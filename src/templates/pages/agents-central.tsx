import { html } from "hono/html";

interface AgentSummary {
  agentId: string;
  internalId: string;
  name: string;
  status: string;
}

interface AgentMessage {
  id: string;
  agentId: string;
  agentName: string;
  role: string;
  content: string;
  createdAt: Date;
}

interface AgentsCentralPageProps {
  user: { id: string; name: string; email: string };
  agents: AgentSummary[];
  messages: AgentMessage[];
}

export function AgentsCentralPage({ user, agents, messages }: AgentsCentralPageProps) {
  const avatarLetter = (user.name?.[0] ?? user.email?.[0] ?? "?").toUpperCase();
  const statusColors: Record<string, string> = {
    idle: "#6b7280",
    starting: "#f59e0b",
    running: "#22c55e",
    paused: "#3b82f6",
    error: "#ef4444",
    stopped: "#6b7280",
  };

  return html`<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Central Chat — Agents — LFG</title>
  <script>(function(){if(localStorage.getItem('sidebarMinimized')==='true'){document.documentElement.classList.add('sidebar-minimized-preload');}})()</script>
  <link rel="stylesheet" href="/public/css/theme-variables.css" />
  <link rel="stylesheet" href="/public/css/common.css" />
  <link rel="stylesheet" href="/public/css/sidebar.css" />
  <link rel="stylesheet" href="/public/css/agents.css" />
  <link rel="stylesheet" href="/public/css/polish.css" />
  <link rel="stylesheet" href="/public/css/light/light-mode.css" />
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css" />
  <script src="/public/js/theme-switcher.js"></script>
</head>
<body data-user-id="${user.id}">
  <div class="app-container">
    <!-- Sidebar -->
    <div class="sidebar" id="sidebar">
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
          <a href="/projects" class="project-dropdown-trigger">
            <i class="fas fa-folder"></i>
            <span class="project-name-text">Projects</span>
          </a>
        </div>
        <div class="sidebar-nav">
          <a href="/instant/" class="nav-link">
            <i class="fas fa-bolt"></i>
            <span class="nav-text">Instant Apps</span>
          </a>
          <a href="/agents" class="nav-link active">
            <i class="fas fa-robot"></i>
            <span class="nav-text">Agents</span>
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
            <div class="user-avatar">
              <div class="avatar-text">${avatarLetter}</div>
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

    <!-- Main content -->
    <div class="main-content-with-sidebar">
      <div class="central-chat-layout">
        <!-- Chat area -->
        <div class="central-chat-main">
          <div class="central-chat-header">
            <a href="/agents" style="color:var(--text-secondary);text-decoration:none;margin-right:0.75rem;">
              <i class="fas fa-arrow-left"></i>
            </a>
            <h1 style="font-size:1.125rem;font-weight:600;margin:0;">Central Agent Chat</h1>
          </div>

          <div class="central-chat-messages" id="central-chat-messages">
            ${messages.length === 0 ? html`
              <div class="chat-empty-state">
                <i class="fas fa-comments" style="font-size:2rem;opacity:0.3;margin-bottom:0.5rem;"></i>
                <p>Messages from all your agents will appear here.</p>
              </div>
            ` : html`
              ${messages.map((m) => html`
                <div class="central-message ${m.role === "user" ? "central-message-user" : "central-message-agent"} ${m.role === "agent_question" ? "central-message-question" : ""}">
                  <div class="central-message-header">
                    <span class="central-message-agent-name">
                      ${m.role === "user" ? html`<i class="fas fa-user"></i> You` : html`<i class="fas fa-robot"></i> ${m.agentName}`}
                    </span>
                    <span class="central-message-time">${new Date(m.createdAt).toLocaleTimeString()}</span>
                  </div>
                  <div class="central-message-content">${m.content}</div>
                  ${m.role === "agent_question" ? html`<div class="central-message-badge">Question</div>` : ""}
                </div>
              `)}
            `}
          </div>

          <div class="central-chat-input-container">
            <form id="central-chat-form" onsubmit="handleCentralSend(event)">
              <div style="display:flex;gap:0.5rem;">
                <select id="central-agent-select" class="input" style="width:180px;">
                  <option value="" disabled selected>Select Agent</option>
                  ${agents.filter((a) => a.status === "running").map((a) => html`
                    <option value="${a.agentId}">${a.name}</option>
                  `)}
                </select>
                <input type="text" id="central-chat-input" placeholder="Send to agent..." class="input" style="flex:1;" autocomplete="off" />
                <button type="submit" class="btn btn-primary">
                  <i class="fas fa-paper-plane"></i>
                </button>
              </div>
            </form>
          </div>
        </div>

        <!-- Agent Status Sidebar -->
        <div class="central-agents-sidebar">
          <h3 style="font-size:0.875rem;font-weight:600;margin:0 0 1rem;color:var(--text-color);">Agents</h3>
          <div class="central-agents-list">
            ${agents.map((a) => {
              const sc = statusColors[a.status] ?? "#6b7280";
              return html`
                <a href="/agents/${a.agentId}" class="central-agent-item" style="text-decoration:none;">
                  <div class="central-agent-status" style="background:${sc};"></div>
                  <span class="central-agent-name">${a.name}</span>
                  <span class="central-agent-status-text" style="color:${sc};">${a.status}</span>
                </a>
              `;
            })}
          </div>
        </div>
      </div>
    </div>
  </div>

  <script src="/public/js/sidebar.js"></script>
  <script src="/public/js/agents.js"></script>
</body>
</html>`;
}
