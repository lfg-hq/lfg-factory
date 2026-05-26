import { html } from "hono/html";

interface AgentSummary {
  agentId: string;
  name: string;
  status: string;
  personality: string | null;
  instructions: string | null;
  composioToolkits: string[];
  sandboxUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface AgentsListPageProps {
  user: { id: string; name: string; email: string };
  agents: AgentSummary[];
}

const STATUS_COLOR: Record<string, string> = {
  idle: "#6b7280",
  starting: "#f59e0b",
  running: "#22c55e",
  paused: "#3b82f6",
  error: "#ef4444",
  stopped: "#6b7280",
};

const STATUS_LABEL: Record<string, string> = {
  idle: "Ready",
  starting: "Starting",
  running: "Working",
  paused: "Paused",
  error: "Error",
  stopped: "Ready",
};

export function AgentsListPage({ user, agents }: AgentsListPageProps) {
  const avatarLetter = (user.name?.[0] ?? user.email?.[0] ?? "?").toUpperCase();

  return html`<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Agents — LFG</title>
  <script>(function(){if(localStorage.getItem('sidebarMinimized')==='true'){document.documentElement.classList.add('sidebar-minimized-preload');}})()</script>
  <link rel="stylesheet" href="/public/css/theme-variables.css" />
  <link rel="stylesheet" href="/public/css/common.css" />
  <link rel="stylesheet" href="/public/css/sidebar.css" />
  <link rel="stylesheet" href="/public/css/projects.css" />
  <link rel="stylesheet" href="/public/css/agents.css" />
  <link rel="stylesheet" href="/public/css/polish.css" />
  <link rel="stylesheet" href="/public/css/light/light-mode.css" />
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css" />
  <script src="/public/js/theme-switcher.js"></script>
</head>
<body data-user-id="${user.id}" data-user-name="${user.name}">
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
    <div class="main-content-with-sidebar" style="padding:2rem;">
      <div style="max-width:1200px;margin:0 auto;">
        <!-- Header -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.5rem;">
          <div style="display:flex;align-items:center;gap:1rem;">
            <h1 style="font-size:1.5rem;font-weight:700;color:var(--text-color);margin:0;">Agents</h1>
            <a href="/agents/central" class="btn btn-secondary" style="font-size:0.8125rem;text-decoration:none;">
              <i class="fas fa-comments"></i> Central Chat
            </a>
          </div>
          <button
            onclick="createNewAgent()"
            class="btn btn-primary"
            style="display:flex;align-items:center;gap:0.5rem;"
          >
            <i class="fas fa-plus"></i> New Agent
          </button>
        </div>

        <!-- Agent Grid -->
        ${agents.length === 0 ? html`
          <div style="text-align:center;padding:4rem 2rem;color:var(--text-secondary);">
            <i class="fas fa-robot" style="font-size:3rem;margin-bottom:1rem;opacity:0.3;display:block;"></i>
            <p style="margin:0 0 1rem;">No agents yet. Describe what you want — the agent will help spec itself.</p>
            <button onclick="createNewAgent()" class="btn btn-primary">
              <i class="fas fa-plus"></i> Create your first agent
            </button>
          </div>
        ` : html`
          <div class="agent-grid">
            ${agents.map((agent) => {
              const statusColor = STATUS_COLOR[agent.status] ?? "#6b7280";
              const statusLabel = STATUS_LABEL[agent.status] ?? agent.status;
              const dateStr = agent.updatedAt
                ? new Date(agent.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
                : "";
              const goal = (agent.instructions ?? agent.personality ?? "").trim();
              const goalSnippet = goal.length > 140 ? goal.slice(0, 140) + "…" : goal;
              return html`
                <div class="agent-card" data-agent-id="${agent.agentId}">
                  <a href="/agents/${agent.agentId}" style="text-decoration:none;color:inherit;display:block;">
                    <div class="agent-card-header">
                      <div class="agent-card-icon">
                        <i class="fas fa-robot"></i>
                      </div>
                      <div class="agent-card-title">
                        <h3>${agent.name}</h3>
                        <span class="agent-status-badge" style="color:${statusColor};background:${statusColor}15;">
                          <span class="status-dot" style="background:${statusColor};"></span>
                          ${statusLabel}
                        </span>
                      </div>
                    </div>
                    <div class="agent-card-body">
                      ${goalSnippet ? html`
                        <p class="agent-personality">${goalSnippet}</p>
                      ` : html`
                        <p class="agent-personality" style="opacity:0.5;">No goal set yet.</p>
                      `}
                      <div class="agent-capability-row">
                        <span class="agent-capability-label">
                          <i class="fas fa-plug"></i>
                          ${agent.composioToolkits.length > 0
                            ? agent.composioToolkits.slice(0, 3).join(", ") + (agent.composioToolkits.length > 3 ? ` +${agent.composioToolkits.length - 3}` : "")
                            : "No integrations"}
                        </span>
                      </div>
                      <div class="agent-card-meta">
                        <span><i class="fas fa-clock"></i> ${dateStr}</span>
                        ${agent.sandboxUrl && agent.status === "running" ? html`<span><i class="fas fa-globe" style="color:#22c55e;"></i> Live</span>` : ""}
                      </div>
                    </div>
                  </a>
                  <div class="agent-card-actions">
                    <a href="/agents/${agent.agentId}" class="btn btn-sm btn-secondary" style="text-decoration:none;">
                      <i class="fas fa-comment"></i> Open
                    </a>
                    <button class="btn btn-sm btn-danger-outline" onclick="event.preventDefault();deleteAgent('${agent.agentId}','${agent.name}')" title="Delete">
                      <i class="fas fa-trash"></i>
                    </button>
                  </div>
                </div>
              `;
            })}
          </div>
        `}
      </div>
    </div>
  </div>

  <script src="/public/js/sidebar.js"></script>
  <script src="/public/js/agents.js"></script>
</body>
</html>`;
}
