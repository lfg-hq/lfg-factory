import { html } from "hono/html";

interface Conversation {
  id: string;
  title: string | null;
  updatedAt: Date;
}

interface TicketStage {
  id: string;
  name: string;
  color: string;
  order: number;
}

interface EnvVar {
  id: string;
  key: string;
  isSecret: boolean;
  hasValue: boolean;
  description: string | null;
}

interface InstantAppSummary {
  appId: string;
  name: string;
  status: string;
  description: string | null;
  previewUrl: string | null;
  createdAt: Date;
}

interface ProjectDetailPageProps {
  user: { id: string; name: string; email?: string };
  project: {
    id: string;
    projectId: string;
    name: string;
    icon: string;
    status: string;
    description: string | null;
    stack: string | null;
    repoUrl: string | null;
    repoOwner: string | null;
    repoName: string | null;
  };
  conversations: Conversation[];
  stages: TicketStage[];
  ticketCounts: Record<string, number>;
  envVars: EnvVar[];
  instantApps: InstantAppSummary[];
  activeTab?: string;
}

export function ProjectDetailPage({
  user,
  project,
  conversations,
  stages,
  ticketCounts,
  envVars,
  instantApps = [],
  activeTab = "conversations",
}: ProjectDetailPageProps) {
  const totalTickets = Object.values(ticketCounts).reduce((a, b) => a + b, 0);
  const avatarLetter = (user.name?.[0] ?? user.email?.[0] ?? "?").toUpperCase();

  return html`<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${project.name} — LFG</title>
  <script>(function(){if(localStorage.getItem('sidebarMinimized')==='true'){document.documentElement.classList.add('sidebar-minimized-preload');}})()</script>
  <link rel="stylesheet" href="/public/css/theme-variables.css" />
  <link rel="stylesheet" href="/public/css/common.css" />
  <link rel="stylesheet" href="/public/css/sidebar.css" />
  <link rel="stylesheet" href="/public/css/projects.css" />
  <link rel="stylesheet" href="/public/css/project_detail.css" />
  <link rel="stylesheet" href="/public/css/polish.css" />
  <link rel="stylesheet" href="/public/css/light/light-mode.css" />
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css" />
  <script src="/public/js/theme-switcher.js"></script>
</head>
<body data-user-id="${user.id}" data-user-name="${user.name}" data-project-id="${project.projectId}">

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
                <i class="fas fa-th-large"></i>
                <span>All Projects</span>
              </a>
            </div>
          </div>
        </div>
        <div class="new-chat-section">
          <a href="/chat/project/${project.projectId}" id="new-chat-btn" class="new-chat-link">
            <i class="fas fa-pen-to-square"></i>
            <span class="button-text">New chat</span>
          </a>
        </div>
        <div class="sidebar-nav">
          <a href="/chat/project/${project.projectId}" class="nav-link">
            <i class="fas fa-comments"></i>
            <span class="nav-text">Chat</span>
          </a>
          <a href="/projects/${project.projectId}" class="nav-link${activeTab === "conversations" ? " active" : ""}">
            <i class="fas fa-tachometer-alt"></i>
            <span class="nav-text">Dashboard</span>
          </a>
          <a href="/projects/${project.projectId}/tickets" class="nav-link">
            <i class="fas fa-tasks"></i>
            <span class="nav-text">Tickets</span>
          </a>
          <a href="/instant/project/${project.projectId}" class="nav-link${activeTab === "instant" ? " active" : ""}">
            <i class="fas fa-bolt"></i>
            <span class="nav-text">Instant</span>
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
            <form method="POST" action="/api/auth/sign-out" style="margin:0;">
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
      <!-- Project Header -->
      <div class="page-header" style="padding:1.25rem 2rem;border-bottom:1px solid var(--border-color);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.75rem;">
        <div style="display:flex;align-items:center;gap:0.75rem;">
          <a href="/projects" style="color:var(--text-secondary);text-decoration:none;font-size:0.875rem;display:flex;align-items:center;gap:0.4rem;">
            <i class="fas fa-arrow-left"></i> Projects
          </a>
          <span style="color:var(--text-secondary);">/</span>
          <span style="font-size:1.5rem;">${project.icon}</span>
          <div>
            <h1 style="font-size:1.25rem;font-weight:700;color:var(--text-color);margin:0;">${project.name}</h1>
            <div style="display:flex;gap:0.5rem;align-items:center;margin-top:0.2rem;">
              <span style="font-size:0.75rem;padding:0.2rem 0.5rem;border-radius:9999px;background:${project.status === "active" ? "rgba(34,197,94,0.1)" : "rgba(156,163,175,0.1)"};color:${project.status === "active" ? "#22c55e" : "var(--text-secondary)"};">
                ${project.status}
              </span>
              ${project.stack ? html`<span style="font-size:0.75rem;color:var(--text-secondary);">${project.stack}</span>` : ""}
              ${project.repoUrl ? html`
                <a href="${project.repoUrl}" target="_blank" style="font-size:0.75rem;color:var(--text-secondary);text-decoration:none;display:flex;align-items:center;gap:0.3rem;">
                  <i class="fab fa-github"></i> ${project.repoOwner}/${project.repoName}
                </a>
              ` : ""}
            </div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:0.75rem;">
          ${!project.repoUrl ? html`
            <button onclick="showCodebaseModal()" class="btn btn-secondary" style="display:flex;align-items:center;gap:0.5rem;font-size:0.8125rem;">
              <i class="fab fa-github"></i> Link Repository
            </button>
          ` : html`
            <button onclick="showCodebaseModal()" class="btn btn-secondary" style="display:flex;align-items:center;gap:0.5rem;font-size:0.8125rem;">
              <i class="fab fa-github"></i> Change Repo
            </button>
          `}
          <a href="/chat/project/${project.projectId}" class="btn btn-primary" style="display:flex;align-items:center;gap:0.5rem;">
            <i class="fas fa-arrow-left"></i> Back to Workspace
          </a>
        </div>
      </div>

      <!-- Horizontal Tab Nav -->
      <div class="project-tabs" style="display:flex;gap:0;border-bottom:1px solid var(--border-color);padding:0 2rem;background:var(--body-bg);">
        <a href="/projects/${project.projectId}" class="tab-item${activeTab === "conversations" ? " active" : ""}" style="display:flex;align-items:center;gap:0.5rem;padding:0.875rem 1.25rem;text-decoration:none;font-size:0.875rem;font-weight:500;color:${activeTab === "conversations" ? "var(--text-color)" : "var(--text-secondary)"};border-bottom:2px solid ${activeTab === "conversations" ? "var(--primary-color)" : "transparent"};margin-bottom:-1px;transition:color 0.15s;">
          <i class="fas fa-comments"></i> Conversations
          ${conversations.length > 0 ? html`<span style="font-size:0.7rem;background:rgba(139,92,246,0.2);color:#a78bfa;padding:0.1rem 0.4rem;border-radius:9999px;">${conversations.length}</span>` : ""}
        </a>
        <a href="/projects/${project.projectId}/tickets" class="tab-item" style="display:flex;align-items:center;gap:0.5rem;padding:0.875rem 1.25rem;text-decoration:none;font-size:0.875rem;font-weight:500;color:var(--text-secondary);border-bottom:2px solid transparent;margin-bottom:-1px;transition:color 0.15s;">
          <i class="fas fa-tasks"></i> Tickets
        </a>
        <a href="/projects/${project.projectId}?tab=instant" class="tab-item${activeTab === "instant" ? " active" : ""}" style="display:flex;align-items:center;gap:0.5rem;padding:0.875rem 1.25rem;text-decoration:none;font-size:0.875rem;font-weight:500;color:${activeTab === "instant" ? "var(--text-color)" : "var(--text-secondary)"};border-bottom:2px solid ${activeTab === "instant" ? "var(--primary-color)" : "transparent"};margin-bottom:-1px;transition:color 0.15s;">
          <i class="fas fa-bolt"></i> Instant
          ${instantApps.length > 0 ? html`<span style="font-size:0.7rem;background:rgba(139,92,246,0.2);color:#a78bfa;padding:0.1rem 0.4rem;border-radius:9999px;">${instantApps.length}</span>` : ""}
        </a>
        <a href="/projects/${project.projectId}?tab=events" class="tab-item${activeTab === "events" ? " active" : ""}" style="display:flex;align-items:center;gap:0.5rem;padding:0.875rem 1.25rem;text-decoration:none;font-size:0.875rem;font-weight:500;color:${activeTab === "events" ? "var(--text-color)" : "var(--text-secondary)"};border-bottom:2px solid ${activeTab === "events" ? "var(--primary-color)" : "transparent"};margin-bottom:-1px;transition:color 0.15s;">
          <i class="fas fa-stream"></i> Events
        </a>
        <a href="/projects/${project.projectId}?tab=environment" class="tab-item${activeTab === "environment" ? " active" : ""}" style="display:flex;align-items:center;gap:0.5rem;padding:0.875rem 1.25rem;text-decoration:none;font-size:0.875rem;font-weight:500;color:${activeTab === "environment" ? "var(--text-color)" : "var(--text-secondary)"};border-bottom:2px solid ${activeTab === "environment" ? "var(--primary-color)" : "transparent"};margin-bottom:-1px;transition:color 0.15s;">
          <i class="fas fa-key"></i> Environment
        </a>
        <a href="/projects/${project.projectId}?tab=settings" class="tab-item${activeTab === "settings" ? " active" : ""}" style="display:flex;align-items:center;gap:0.5rem;padding:0.875rem 1.25rem;text-decoration:none;font-size:0.875rem;font-weight:500;color:${activeTab === "settings" ? "var(--text-color)" : "var(--text-secondary)"};border-bottom:2px solid ${activeTab === "settings" ? "var(--primary-color)" : "transparent"};margin-bottom:-1px;transition:color 0.15s;">
          <i class="fas fa-cog"></i> Settings
        </a>
      </div>

      <!-- Tab content -->
      <div style="padding:2rem;max-width:1200px;margin:0 auto;">
        ${activeTab === "conversations" ? html`
          <div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.5rem;">
              <h2 style="font-size:1.1rem;font-weight:600;color:var(--text-color);margin:0;">Conversations</h2>
              <a href="/chat/project/${project.projectId}" class="btn btn-primary" style="font-size:0.875rem;">
                <i class="fas fa-plus"></i> New Conversation
              </a>
            </div>
            ${conversations.length === 0 ? html`
              <div style="text-align:center;padding:3rem;color:var(--text-secondary);border:1px dashed var(--border-color);border-radius:var(--radius-lg);">
                <i class="fas fa-comments" style="font-size:2rem;opacity:0.3;display:block;margin-bottom:0.75rem;"></i>
                <p style="margin:0 0 1rem;">No conversations yet.</p>
                <a href="/chat/project/${project.projectId}" class="btn btn-primary">Start a conversation</a>
              </div>
            ` : html`
              <div style="display:flex;flex-direction:column;gap:0.5rem;">
                ${conversations.map((c) => html`
                  <a href="/chat/project/${project.projectId}/conversation/${c.id}"
                    style="display:flex;align-items:center;gap:1rem;padding:0.875rem 1rem;border:1px solid var(--border-color);border-radius:var(--radius);background:var(--card-bg);text-decoration:none;color:var(--text-color);transition:border-color 0.15s;">
                    <i class="fas fa-comment-dots" style="color:var(--text-secondary);width:1rem;"></i>
                    <span style="flex:1;font-size:0.9375rem;">${c.title ?? "Untitled conversation"}</span>
                    <span style="font-size:0.75rem;color:var(--text-secondary);">${new Date(c.updatedAt).toLocaleDateString()}</span>
                  </a>
                `)}
              </div>
            `}
          </div>
        ` : ""}

        ${activeTab === "events" ? html`
          <div id="events-tab-container" data-project-id="${project.projectId}">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.5rem;">
              <h2 style="font-size:1.1rem;font-weight:600;color:var(--text-color);margin:0;">Events Timeline</h2>
            </div>
            <div id="events-timeline-container">
              <div style="text-align:center;padding:2rem;color:var(--text-secondary);">
                <i class="fas fa-spinner fa-spin" style="font-size:1.25rem;opacity:0.5;"></i>
                <p style="margin:0.5rem 0 0;font-size:0.875rem;">Loading events...</p>
              </div>
            </div>
          </div>
          <link rel="stylesheet" href="/public/css/events-timeline.css" />
          <script src="/public/js/events-timeline.js"></script>
        ` : ""}

        ${activeTab === "environment" ? html`
          <div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.5rem;">
              <div>
                <h2 style="font-size:1.1rem;font-weight:600;color:var(--text-color);margin:0;">Environment Variables</h2>
                <p style="font-size:0.8125rem;color:var(--text-secondary);margin:0.25rem 0 0;">${envVars.length} variable${envVars.length !== 1 ? "s" : ""}</p>
              </div>
            </div>
            ${envVars.length === 0 ? html`
              <div style="text-align:center;padding:3rem;color:var(--text-secondary);border:1px dashed var(--border-color);border-radius:var(--radius-lg);">
                <i class="fas fa-key" style="font-size:2rem;opacity:0.3;display:block;margin-bottom:0.75rem;"></i>
                <p style="margin:0;">No environment variables. Ask the AI to set them up.</p>
              </div>
            ` : html`
              <div style="border:1px solid var(--border-color);border-radius:var(--radius-lg);overflow:hidden;">
                <table style="width:100%;border-collapse:collapse;">
                  <thead>
                    <tr style="background:var(--card-bg);border-bottom:1px solid var(--border-color);">
                      <th style="padding:0.75rem 1rem;text-align:left;font-size:0.75rem;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.05em;">Key</th>
                      <th style="padding:0.75rem 1rem;text-align:left;font-size:0.75rem;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.05em;">Value</th>
                      <th style="padding:0.75rem 1rem;text-align:left;font-size:0.75rem;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.05em;">Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${envVars.map((ev, i) => html`
                      <tr style="border-bottom:${i < envVars.length - 1 ? "1px solid var(--border-color)" : "none"};">
                        <td style="padding:0.75rem 1rem;font-family:monospace;font-size:0.875rem;color:var(--text-color);">${ev.key}</td>
                        <td style="padding:0.75rem 1rem;font-size:0.875rem;color:var(--text-secondary);">
                          ${ev.hasValue ? html`<em>${ev.isSecret ? "••••••••" : "set"}</em>` : html`<em style="color:var(--danger-color);">not set</em>`}
                        </td>
                        <td style="padding:0.75rem 1rem;font-size:0.8125rem;color:var(--text-secondary);">${ev.description ?? ""}</td>
                      </tr>
                    `)}
                  </tbody>
                </table>
              </div>
            `}
          </div>
        ` : ""}

        ${activeTab === "instant" ? html`
          <div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.5rem;">
              <h2 style="font-size:1.1rem;font-weight:600;color:var(--text-color);margin:0;">Instant Apps</h2>
              <a href="/instant/project/${project.projectId}" class="btn btn-primary" style="font-size:0.875rem;">
                <i class="fas fa-bolt"></i> New Instant App
              </a>
            </div>
            ${instantApps.length === 0 ? html`
              <div style="text-align:center;padding:3rem;color:var(--text-secondary);border:1px dashed var(--border-color);border-radius:var(--radius-lg);">
                <i class="fas fa-bolt" style="font-size:2rem;opacity:0.3;display:block;margin-bottom:0.75rem;"></i>
                <p style="margin:0 0 1rem;">No instant apps yet.</p>
                <p style="font-size:0.85rem;margin:0 0 1rem;">Use Instant Mode to quickly build full-stack apps through a conversational interface.</p>
                <a href="/instant/project/${project.projectId}" class="btn btn-primary">
                  <i class="fas fa-bolt"></i> Launch Instant Mode
                </a>
              </div>
            ` : html`
              <div style="display:flex;flex-direction:column;gap:0.5rem;">
                ${instantApps.map((app) => html`
                  <a href="/instant/project/${project.projectId}/app/${app.appId}"
                    style="display:flex;align-items:center;gap:1rem;padding:0.875rem 1rem;border:1px solid var(--border-color);border-radius:var(--radius);background:var(--card-bg);text-decoration:none;color:var(--text-color);transition:border-color 0.15s;">
                    <i class="fas fa-bolt" style="color:${app.status === "running" ? "#22c55e" : app.status === "building" ? "#f59e0b" : app.status === "error" ? "#ef4444" : "var(--text-secondary)"};width:1rem;"></i>
                    <div style="flex:1;min-width:0;">
                      <div style="display:flex;align-items:center;gap:0.5rem;">
                        <span style="font-size:0.9375rem;font-weight:500;">${app.name}</span>
                        <span style="font-size:0.65rem;padding:0.1rem 0.4rem;border-radius:10px;text-transform:uppercase;letter-spacing:0.03em;font-weight:600;background:${app.status === "running" ? "rgba(34,197,94,0.1)" : app.status === "building" ? "rgba(245,158,11,0.1)" : app.status === "error" ? "rgba(239,68,68,0.1)" : "rgba(139,92,246,0.1)"};color:${app.status === "running" ? "#22c55e" : app.status === "building" ? "#f59e0b" : app.status === "error" ? "#ef4444" : "#a78bfa"};">
                          ${app.status}
                        </span>
                      </div>
                      ${app.description ? html`<span style="font-size:0.8125rem;color:var(--text-secondary);display:block;margin-top:0.2rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${app.description.slice(0, 100)}</span>` : ""}
                    </div>
                    ${app.previewUrl ? html`<span style="font-size:0.7rem;color:#22c55e;display:flex;align-items:center;gap:0.3rem;"><i class="fas fa-circle" style="font-size:5px;"></i> Live</span>` : ""}
                    <i class="fas fa-chevron-right" style="color:var(--text-secondary);opacity:0.5;font-size:0.75rem;"></i>
                  </a>
                `)}
              </div>
            `}
          </div>
        ` : ""}

        ${activeTab === "settings" ? html`
          <div>
            <h2 style="font-size:1.1rem;font-weight:600;color:var(--text-color);margin:0 0 1.5rem;">Project Settings</h2>
            <form method="POST" action="/projects/${project.projectId}/update">
              <div style="margin-bottom:1rem;">
                <label style="display:block;font-size:0.875rem;font-weight:500;color:var(--text-color);margin-bottom:0.5rem;">Project Name</label>
                <input type="text" name="name" value="${project.name}" class="input" style="width:100%;box-sizing:border-box;" />
              </div>
              <div style="margin-bottom:1rem;">
                <label style="display:block;font-size:0.875rem;font-weight:500;color:var(--text-color);margin-bottom:0.5rem;">Description</label>
                <textarea name="description" rows="3" class="input" style="width:100%;box-sizing:border-box;resize:vertical;">${project.description ?? ""}</textarea>
              </div>
              <div style="margin-bottom:1rem;">
                <label style="display:block;font-size:0.875rem;font-weight:500;color:var(--text-color);margin-bottom:0.5rem;">Tech Stack</label>
                <input type="text" name="stack" value="${project.stack ?? ""}" placeholder="e.g. Next.js, Postgres, Tailwind" class="input" style="width:100%;box-sizing:border-box;" />
              </div>
              <div style="display:flex;gap:0.75rem;margin-top:1.5rem;">
                <button type="submit" class="btn btn-primary">Save Changes</button>
              </div>
            </form>

            <!-- Team & Guests -->
            <div style="margin-top:2.5rem;padding-top:2rem;border-top:1px solid var(--border-color);">
              <h3 style="font-size:1rem;font-weight:600;color:var(--text-color);margin:0 0 0.5rem;">Team & Guests</h3>
              <p style="font-size:0.8125rem;color:var(--text-secondary);margin:0 0 1.25rem;">Invite people to collaborate on this project.</p>

              <!-- Invite Form -->
              <div style="display:flex;gap:0.5rem;margin-bottom:1.5rem;" id="invite-form">
                <input type="email" id="invite-email" placeholder="Email address" class="input" style="flex:1;box-sizing:border-box;" />
                <select id="invite-role" class="input" style="width:auto;min-width:100px;">
                  <option value="viewer">Viewer</option>
                  <option value="member">Member</option>
                  <option value="guest">Guest</option>
                </select>
                <button type="button" class="btn btn-primary" onclick="sendInvitation()" style="white-space:nowrap;">
                  <i class="fas fa-paper-plane"></i> Invite
                </button>
              </div>
              <div id="invite-message" style="display:none;font-size:0.8125rem;margin-bottom:1rem;padding:0.5rem 0.75rem;border-radius:var(--radius);"></div>

              <!-- Members List -->
              <div id="members-list" style="margin-bottom:1rem;">
                <div style="font-size:0.8125rem;color:var(--text-secondary);padding:0.5rem 0;">Loading members...</div>
              </div>

              <!-- Pending Invitations -->
              <div id="invitations-list" style="margin-bottom:1rem;"></div>
            </div>

            <div style="margin-top:2.5rem;padding-top:2rem;border-top:1px solid var(--border-color);">
              <h3 style="font-size:1rem;font-weight:600;color:var(--danger-color);margin:0 0 0.75rem;">Danger Zone</h3>
              <form method="POST" action="/projects/${project.projectId}/delete"
                onsubmit="return confirm('Delete project &quot;${project.name}&quot;? This cannot be undone.')">
                <button type="submit" class="btn" style="background:rgba(239,68,68,0.1);color:#ef4444;border:1px solid rgba(239,68,68,0.3);">
                  <i class="fas fa-trash"></i> Delete Project
                </button>
              </form>
            </div>
          </div>
        ` : ""}
      </div>
    </div>
  </div>

  <!-- Link GitHub Repository Modal -->
  <div class="modal-overlay" id="codebaseModal" style="display:none;position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,0.7);align-items:center;justify-content:center;">
    <div style="background:var(--card-bg);border:1px solid var(--border-color);border-radius:var(--radius-lg);width:100%;max-width:520px;position:relative;transform:scale(0.95);transition:transform 0.2s ease;">
      <!-- Header -->
      <div style="display:flex;align-items:center;justify-content:space-between;padding:1.25rem 1.5rem;border-bottom:1px solid var(--border-color);">
        <h3 style="margin:0;font-size:1.1rem;font-weight:600;color:var(--text-color);display:flex;align-items:center;gap:0.5rem;">
          <i class="fab fa-github"></i> Link GitHub Repository
        </h3>
        <button type="button" onclick="closeCodebaseModal()" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:1.1rem;padding:0.25rem;">
          <i class="fas fa-times"></i>
        </button>
      </div>
      <!-- Body -->
      <div style="padding:1.5rem;">
        <form id="codebaseForm" method="POST" action="/projects/${project.projectId}/connect-repo">
          <div style="margin-bottom:1.25rem;">
            <label style="display:block;font-size:0.875rem;font-weight:500;color:var(--text-color);margin-bottom:0.5rem;">GitHub Repository URL</label>
            <input type="url" name="repo_url" id="githubUrl" required
              placeholder="https://github.com/username/repository"
              value="${project.repoUrl ?? ""}"
              class="input" style="width:100%;box-sizing:border-box;" />
            <p style="font-size:0.75rem;color:var(--text-secondary);margin:0.4rem 0 0;">Make sure you have access to this repository.</p>
          </div>
          <div style="margin-bottom:1.25rem;">
            <label style="display:block;font-size:0.875rem;font-weight:500;color:var(--text-color);margin-bottom:0.5rem;">Branch</label>
            <input type="text" name="branch" id="githubBranch" value="main"
              class="input" style="width:100%;box-sizing:border-box;" />
            <p style="font-size:0.75rem;color:var(--text-secondary);margin:0.4rem 0 0;">Typically 'main' or 'master'</p>
          </div>
          <div style="background:rgba(59,130,246,0.08);border:1px solid rgba(59,130,246,0.2);border-radius:var(--radius);padding:0.875rem 1rem;margin-bottom:1.25rem;">
            <div style="display:flex;align-items:center;gap:0.4rem;font-size:0.8125rem;font-weight:500;color:#60a5fa;margin-bottom:0.5rem;">
              <i class="fas fa-info-circle"></i> What happens next
            </div>
            <ul style="margin:0;padding-left:1.25rem;font-size:0.8125rem;color:var(--text-secondary);line-height:1.6;">
              <li>Your repository will be cloned into each ticket's sandbox</li>
              <li>AI agents will work directly on your codebase</li>
              <li>Changes are pushed to feature branches for review</li>
            </ul>
          </div>
          <div style="display:flex;gap:0.75rem;justify-content:flex-end;">
            <button type="button" onclick="closeCodebaseModal()" class="btn btn-secondary">Cancel</button>
            <button type="submit" class="btn btn-primary" style="display:flex;align-items:center;gap:0.5rem;">
              <i class="fas fa-link"></i> Link Repository
            </button>
          </div>
        </form>
        ${project.repoUrl ? html`
          <div style="margin-top:1rem;padding-top:1rem;border-top:1px solid var(--border-color);display:flex;justify-content:space-between;align-items:center;">
            <span style="font-size:0.8125rem;color:var(--text-secondary);">Currently linked: <strong style="color:var(--text-color);">${project.repoOwner}/${project.repoName}</strong></span>
            <form method="POST" action="/projects/${project.projectId}/connect-repo" style="margin:0;">
              <input type="hidden" name="repo_url" value="" />
              <button type="submit" class="btn" style="font-size:0.75rem;padding:0.25rem 0.5rem;color:#ef4444;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);" onclick="return confirm('Disconnect this repository?')">
                <i class="fas fa-unlink"></i> Disconnect
              </button>
            </form>
          </div>
        ` : ""}
      </div>
    </div>
  </div>

  <script src="/public/js/sidebar.js"></script>
  <script>requestAnimationFrame(()=>requestAnimationFrame(()=>document.documentElement.classList.remove('sidebar-minimized-preload')));</script>
  <script>
    // Codebase modal open/close
    function showCodebaseModal() {
      var modal = document.getElementById('codebaseModal');
      modal.style.display = 'flex';
      setTimeout(function() { modal.querySelector('div > div').style.transform = 'scale(1)'; }, 10);
    }
    function closeCodebaseModal() {
      var modal = document.getElementById('codebaseModal');
      modal.querySelector('div > div').style.transform = 'scale(0.95)';
      setTimeout(function() { modal.style.display = 'none'; }, 150);
    }
    // Close on overlay click
    document.getElementById('codebaseModal').addEventListener('click', function(e) {
      if (e.target === this) closeCodebaseModal();
    });
    // Auto-show modal if ?showConnect=true (after project creation)
    if (new URLSearchParams(window.location.search).get('showConnect') === 'true') {
      showCodebaseModal();
    }
  </script>

  <script>
    // Team & Guests management
    var projectId = '${project.projectId}';

    function loadMembers() {
      fetch('/api/projects/' + projectId + '/members')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          var el = document.getElementById('members-list');
          if (!el) return;
          var items = '';
          if (data.owner) {
            items += '<div style="display:flex;align-items:center;justify-content:space-between;padding:0.625rem 0;border-bottom:1px solid var(--border-color);">'
              + '<div style="display:flex;align-items:center;gap:0.75rem;">'
              + '<div style="width:32px;height:32px;border-radius:50%;background:var(--primary-color);display:flex;align-items:center;justify-content:center;font-size:0.8rem;font-weight:600;color:white;">'
              + (data.owner.name?.[0] || '?').toUpperCase() + '</div>'
              + '<div><div style="font-size:0.875rem;font-weight:500;color:var(--text-color);">' + data.owner.name + '</div>'
              + '<div style="font-size:0.75rem;color:var(--text-secondary);">' + (data.owner.email || '') + '</div></div></div>'
              + '<span style="font-size:0.7rem;padding:0.15rem 0.5rem;border-radius:10px;background:rgba(139,92,246,0.1);color:#a78bfa;font-weight:600;text-transform:uppercase;">Owner</span>'
              + '</div>';
          }
          (data.members || []).forEach(function(m) {
            var roleColor = m.role === 'admin' ? '#3b82f6' : m.role === 'member' ? '#22c55e' : '#6b7280';
            items += '<div style="display:flex;align-items:center;justify-content:space-between;padding:0.625rem 0;border-bottom:1px solid var(--border-color);">'
              + '<div style="display:flex;align-items:center;gap:0.75rem;">'
              + '<div style="width:32px;height:32px;border-radius:50%;background:var(--card-bg);border:1px solid var(--border-color);display:flex;align-items:center;justify-content:center;font-size:0.8rem;font-weight:600;color:var(--text-color);">'
              + (m.userName?.[0] || '?').toUpperCase() + '</div>'
              + '<div><div style="font-size:0.875rem;font-weight:500;color:var(--text-color);">' + m.userName + '</div>'
              + '<div style="font-size:0.75rem;color:var(--text-secondary);">' + (m.userEmail || '') + '</div></div></div>'
              + '<div style="display:flex;align-items:center;gap:0.5rem;">'
              + '<span style="font-size:0.7rem;padding:0.15rem 0.5rem;border-radius:10px;background:rgba(' + (m.role === 'admin' ? '59,130,246' : m.role === 'member' ? '34,197,94' : '107,114,128') + ',0.1);color:' + roleColor + ';font-weight:600;text-transform:uppercase;">' + m.role + '</span>'
              + '<button onclick="removeMember(\\'' + m.id + '\\')" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:0.8rem;padding:0.25rem;" title="Remove"><i class="fas fa-times"></i></button>'
              + '</div></div>';
          });
          el.innerHTML = items || '<div style="font-size:0.8125rem;color:var(--text-secondary);padding:0.5rem 0;">No team members yet.</div>';
        });
    }

    function loadInvitations() {
      fetch('/api/projects/' + projectId + '/invitations')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          var el = document.getElementById('invitations-list');
          if (!el || !data.invitations?.length) { if (el) el.innerHTML = ''; return; }
          var items = '<div style="font-size:0.8125rem;font-weight:500;color:var(--text-secondary);margin-bottom:0.5rem;">Pending Invitations</div>';
          data.invitations.forEach(function(inv) {
            items += '<div style="display:flex;align-items:center;justify-content:space-between;padding:0.5rem 0;border-bottom:1px solid var(--border-color);">'
              + '<div style="font-size:0.8125rem;color:var(--text-color);">' + inv.email + ' <span style="color:var(--text-secondary);">(' + inv.role + ')</span></div>'
              + '<button onclick="revokeInvitation(\\'' + inv.id + '\\')" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:0.75rem;">Revoke</button>'
              + '</div>';
          });
          el.innerHTML = items;
        });
    }

    function sendInvitation() {
      var email = document.getElementById('invite-email').value.trim();
      var role = document.getElementById('invite-role').value;
      var msg = document.getElementById('invite-message');
      if (!email) return;
      fetch('/api/projects/' + projectId + '/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, role: role })
      }).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
        .then(function(res) {
          msg.style.display = 'block';
          if (res.ok) {
            msg.style.background = 'rgba(34,197,94,0.1)';
            msg.style.color = '#22c55e';
            msg.textContent = 'Invitation sent to ' + email;
            document.getElementById('invite-email').value = '';
            loadInvitations();
          } else {
            msg.style.background = 'rgba(239,68,68,0.1)';
            msg.style.color = '#ef4444';
            msg.textContent = res.data.error || 'Failed to send invitation';
          }
          setTimeout(function() { msg.style.display = 'none'; }, 4000);
        });
    }

    function removeMember(memberId) {
      if (!confirm('Remove this member?')) return;
      fetch('/api/projects/' + projectId + '/members/' + memberId, { method: 'DELETE' })
        .then(function() { loadMembers(); });
    }

    function revokeInvitation(invId) {
      fetch('/api/projects/' + projectId + '/invitations/' + invId, { method: 'DELETE' })
        .then(function() { loadInvitations(); });
    }

    // Load on settings tab
    if ('${activeTab}' === 'settings') {
      loadMembers();
      loadInvitations();
    }
  </script>

</body>
</html>`;

}
