import { html } from "hono/html";

interface Project {
  id: string;
  projectId: string;
  name: string;
  icon: string;
  status: string;
  description: string | null;
  stack: string | null;
  createdAt: Date;
}

interface InstantApp {
  appId: string;
  name: string;
  status: string;
  description: string | null;
  previewUrl: string | null;
  createdAt: Date;
  projectId: string | null;
  projectPublicId: string | null;
  projectName: string | null;
}

interface AgentSummary {
  agentId: string;
  name: string;
  status: string;
  personality: string | null;
  sandboxUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface PendingInvite {
  token: string;
  role: string;
  projectName: string;
  projectIcon: string;
  inviterName: string;
}

interface ProjectListPageProps {
  user: { id: string; name: string; email?: string };
  projects: Project[];
  projectStats?: Record<string, { conversations: number; tickets: number; docs: number; pending: number }>;
  instantApps?: InstantApp[];
  agents?: AgentSummary[];
  pendingInvites?: PendingInvite[];
  activeTab?: string;
  error?: string;
  success?: string;
}

export function ProjectListPage({ user, projects, projectStats = {}, instantApps = [], agents = [], pendingInvites = [], activeTab = "projects", error, success }: ProjectListPageProps) {
  const roleLabel = (r: string) => (r === "viewer" || r === "guest" ? "Viewer" : r === "admin" ? "Admin" : "Collaborator");
  const avatarLetter = (user.name?.[0] ?? user.email?.[0] ?? "?").toUpperCase();
  const isAppsTab = activeTab === "instant_apps";
  const isAgentsTab = activeTab === "agents";
  const isProjectsTab = !isAppsTab && !isAgentsTab;

  return html`<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/x-icon" href="/public/images/favicon.ico" />
  <title>Projects — LFG</title>
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
  ${error ? html`<div class="messages"><div class="alert alert-danger">${error}</div></div>` : ""}
  ${success ? html`<div class="messages"><div class="alert alert-success">${success}</div></div>` : ""}

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
          <a href="/projects?tab=agents" class="nav-link">
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
          <h1 style="font-size:1.5rem;font-weight:700;color:var(--text-color);margin:0;">Projects</h1>
          ${isAppsTab ? html`
            <a href="/instant/" class="btn btn-primary" style="display:flex;align-items:center;gap:0.5rem;text-decoration:none;">
              <i class="fas fa-plus"></i> New Instant App
            </a>
          ` : isAgentsTab ? html`
            <button onclick="createNewAgent()" class="btn btn-primary" style="display:flex;align-items:center;gap:0.5rem;">
              <i class="fas fa-plus"></i> New Agent
            </button>
          ` : html`
            <div style="display:flex;gap:0.5rem;">
              <button onclick="document.getElementById('import-modal').classList.add('active')" class="btn btn-secondary" style="display:flex;align-items:center;gap:0.5rem;">
                <i class="fas fa-upload"></i> Import
              </button>
              <button
                onclick="document.getElementById('create-modal').classList.add('active')"
                class="btn btn-primary"
                style="display:flex;align-items:center;gap:0.5rem;"
              >
                <i class="fas fa-plus"></i> New Project
              </button>
            </div>
          `}
        </div>

        <!-- Import project modal -->
        <div class="modal-overlay" id="import-modal" style="position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,0.7);align-items:center;justify-content:center;">
          <div style="background:var(--card-bg);border:1px solid var(--border-color);border-radius:var(--radius-lg);width:100%;max-width:480px;">
            <div style="display:flex;align-items:center;justify-content:space-between;padding:1.25rem 1.5rem;border-bottom:1px solid var(--border-color);">
              <h3 style="margin:0;font-size:1.1rem;font-weight:600;color:var(--text-color);">Import a project</h3>
              <button type="button" onclick="document.getElementById('import-modal').classList.remove('active')" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:1.25rem;">&times;</button>
            </div>
            <div style="padding:1.5rem;">
              <p style="margin:0 0 1rem;color:var(--text-secondary);font-size:0.85rem;line-height:1.5;">Upload a project export file. <strong style="color:#ef4444;">If a project with the same id already exists, its data is wiped and replaced</strong> — this is not a merge.</p>
              <input type="file" id="import-file" accept="application/json,.json" class="input" style="width:100%;box-sizing:border-box;margin-bottom:1rem;" />
              <label style="display:block;font-size:0.85rem;color:var(--text-color);margin-bottom:0.35rem;">Type <strong>IMPORT</strong> to confirm</label>
              <input type="text" id="import-confirm" class="input" style="width:100%;box-sizing:border-box;margin-bottom:1rem;" placeholder="IMPORT" />
              <div id="import-error" style="display:none;color:#ef4444;font-size:0.8rem;margin-bottom:0.75rem;"></div>
              <div style="display:flex;gap:0.75rem;justify-content:flex-end;">
                <button class="btn btn-secondary" onclick="document.getElementById('import-modal').classList.remove('active')">Cancel</button>
                <button class="btn btn-primary" id="import-submit" onclick="submitImport()"><i class="fas fa-upload"></i> Import</button>
              </div>
            </div>
          </div>
        </div>
        <script>
          window.submitImport = function(){
            var err = document.getElementById('import-error');
            var fileInput = document.getElementById('import-file');
            var confirmVal = (document.getElementById('import-confirm').value || '').trim();
            if (confirmVal !== 'IMPORT'){ err.textContent = 'Type IMPORT to confirm.'; err.style.display='block'; return; }
            if (!fileInput.files || !fileInput.files[0]){ err.textContent = 'Choose an export file.'; err.style.display='block'; return; }
            err.style.display='none';
            var btn = document.getElementById('import-submit'); btn.disabled = true; btn.textContent = 'Importing…';
            var reader = new FileReader();
            reader.onload = function(){
              var payload;
              try { payload = JSON.parse(reader.result); } catch(e){ err.textContent='That file is not valid JSON.'; err.style.display='block'; btn.disabled=false; btn.innerHTML='<i class="fas fa-upload"></i> Import'; return; }
              fetch('/api/projects/import', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) })
                .then(function(r){ return r.json().then(function(d){return {ok:r.ok,data:d};}); })
                .then(function(res){
                  if(!res.ok){ err.textContent=(res.data&&res.data.error)||'Import failed'; err.style.display='block'; btn.disabled=false; btn.innerHTML='<i class="fas fa-upload"></i> Import'; return; }
                  window.location.href = '/projects/' + res.data.projectId;
                })
                .catch(function(){ err.textContent='Import failed.'; err.style.display='block'; btn.disabled=false; btn.innerHTML='<i class="fas fa-upload"></i> Import'; });
            };
            reader.readAsText(fileInput.files[0]);
          };
        </script>

        ${pendingInvites.length > 0 ? html`
          <div style="margin-bottom:1.5rem;">
            <div style="font-size:0.8rem;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.03em;margin-bottom:0.6rem;">
              <i class="fas fa-envelope-open-text" style="margin-right:0.4rem;color:var(--primary-color);"></i>Project invitations
            </div>
            ${pendingInvites.map((inv) => html`
              <div style="display:flex;align-items:center;gap:1rem;padding:1rem 1.25rem;border:1px solid var(--primary-color);border-radius:var(--radius);background:rgba(139,92,246,0.06);margin-bottom:0.6rem;">
                <span style="font-size:1.5rem;">${inv.projectIcon}</span>
                <div style="flex:1;">
                  <div style="font-weight:600;color:var(--text-color);">${inv.projectName}</div>
                  <div style="font-size:0.8rem;color:var(--text-secondary);">${inv.inviterName} invited you as ${roleLabel(inv.role)}</div>
                </div>
                <form method="POST" action="/invitations/accept/${inv.token}" style="margin:0;">
                  <button type="submit" class="btn btn-primary" style="font-size:0.85rem;"><i class="fas fa-check"></i> Accept</button>
                </form>
              </div>
            `)}
          </div>
        ` : ""}

        <!-- Tabs -->
        <div style="display:flex;gap:0;border-bottom:1px solid var(--border-color);margin-bottom:1.5rem;">
          <a href="/projects?tab=projects"
            style="padding:0.75rem 1.25rem;font-size:0.875rem;font-weight:500;text-decoration:none;border-bottom:2px solid ${isProjectsTab ? "var(--primary-color)" : "transparent"};color:${isProjectsTab ? "var(--primary-color)" : "var(--text-secondary)"};margin-bottom:-1px;">
            <i class="fas fa-folder" style="margin-right:0.5rem;"></i>Projects
            <span style="margin-left:0.5rem;font-size:0.75rem;background:var(--bg-tertiary);padding:0.125rem 0.5rem;border-radius:999px;">${projects.length}</span>
          </a>
          <a href="/projects?tab=instant_apps"
            style="padding:0.75rem 1.25rem;font-size:0.875rem;font-weight:500;text-decoration:none;border-bottom:2px solid ${isAppsTab ? "var(--primary-color)" : "transparent"};color:${isAppsTab ? "var(--primary-color)" : "var(--text-secondary)"};margin-bottom:-1px;">
            <i class="fas fa-bolt" style="margin-right:0.5rem;"></i>Instant Apps
            <span style="margin-left:0.5rem;font-size:0.75rem;background:var(--bg-tertiary);padding:0.125rem 0.5rem;border-radius:999px;">${instantApps.length}</span>
          </a>
          <a href="/projects?tab=agents"
            style="padding:0.75rem 1.25rem;font-size:0.875rem;font-weight:500;text-decoration:none;border-bottom:2px solid ${isAgentsTab ? "var(--primary-color)" : "transparent"};color:${isAgentsTab ? "var(--primary-color)" : "var(--text-secondary)"};margin-bottom:-1px;">
            <i class="fas fa-robot" style="margin-right:0.5rem;"></i>Agents
            <span style="margin-left:0.5rem;font-size:0.75rem;background:var(--bg-tertiary);padding:0.125rem 0.5rem;border-radius:999px;">${agents.length}</span>
          </a>
        </div>

        <!-- Tab content -->
        ${isAgentsTab ? html`
          <!-- Agents list -->
          ${agents.length === 0 ? html`
            <div style="text-align:center;padding:4rem 2rem;color:var(--text-secondary);">
              <i class="fas fa-robot" style="font-size:3rem;margin-bottom:1rem;opacity:0.3;display:block;"></i>
              <p style="margin:0 0 1rem;">No agents yet.</p>
              <button onclick="createNewAgent()" class="btn btn-primary">Create your first agent</button>
            </div>
          ` : html`
            <div class="project-list">
              ${agents.map((agent) => {
                const statusColors: Record<string, string> = {
                  idle: "#6b7280",
                  starting: "#f59e0b",
                  running: "#22c55e",
                  paused: "#3b82f6",
                  error: "#ef4444",
                  stopped: "#6b7280",
                };
                const statusColor = statusColors[agent.status] ?? "#6b7280";
                const dateStr = agent.updatedAt
                  ? new Date(agent.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                  : "";
                return html`
                  <div class="project-list-item">
                    <a href="/agents/${agent.agentId}" class="project-list-link" style="text-decoration:none;">
                      <div class="project-list-main">
                        <div class="project-list-header">
                          <span class="project-icon" style="font-size:1.25rem;">
                            <i class="fas fa-robot" style="color:var(--primary-color);"></i>
                          </span>
                          <h3 class="project-name">${agent.name}</h3>
                          <span style="display:inline-flex;align-items:center;gap:0.375rem;font-size:0.75rem;font-weight:500;color:${statusColor};background:${statusColor}15;padding:0.2rem 0.625rem;border-radius:999px;margin-left:0.5rem;">
                            ${agent.status === "running" ? html`<span style="width:6px;height:6px;border-radius:50%;background:${statusColor};display:inline-block;"></span>` : ""}
                            ${agent.status.charAt(0).toUpperCase() + agent.status.slice(1)}
                          </span>
                        </div>
                        <div class="project-stats">
                          ${agent.personality ? html`
                            <div class="stat-item">
                              <i class="fas fa-comment-dots"></i>
                              <span class="stat-label">${(agent.personality ?? "").slice(0, 60)}${(agent.personality ?? "").length > 60 ? "..." : ""}</span>
                            </div>
                          ` : ""}
                          <div class="stat-item">
                            <i class="fas fa-calendar"></i>
                            <span class="stat-label">${dateStr}</span>
                          </div>
                          ${agent.sandboxUrl ? html`
                            <div class="stat-item">
                              <i class="fas fa-globe" style="color:#22c55e;"></i>
                              <span class="stat-label" style="color:#22c55e;">Live</span>
                            </div>
                          ` : ""}
                        </div>
                      </div>
                    </a>
                    <div class="project-list-actions">
                      <a href="/agents/${agent.agentId}" class="project-action-button">
                        <i class="fas fa-eye"></i> View
                      </a>
                      <a href="/agents/central" class="project-action-button">
                        <i class="fas fa-comments"></i> Central
                      </a>
                    </div>
                  </div>
                `;
              })}
            </div>
          `}
        ` : isAppsTab ? html`
          <!-- Instant Apps list -->
          ${instantApps.length === 0 ? html`
            <div style="text-align:center;padding:4rem 2rem;color:var(--text-secondary);">
              <i class="fas fa-bolt" style="font-size:3rem;margin-bottom:1rem;opacity:0.3;display:block;"></i>
              <p style="margin:0 0 1rem;">No instant apps yet.</p>
              <a href="/instant/" class="btn btn-primary" style="text-decoration:none;">Create your first instant app</a>
            </div>
          ` : html`
            <div class="project-list">
              ${instantApps.map((app) => {
                const statusColors: Record<string, string> = {
                  gathering: "#3b82f6",
                  building: "#f59e0b",
                  running: "#22c55e",
                  stopped: "#6b7280",
                  error: "#ef4444",
                };
                const statusColor = statusColors[app.status] ?? "#6b7280";
                const appUrl = app.projectPublicId
                  ? `/instant/project/${app.projectPublicId}/app/${app.appId}`
                  : `/instant/app/${app.appId}`;
                const dateStr = app.createdAt
                  ? new Date(app.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                  : "";
                return html`
                  <div class="project-list-item">
                    <a href="${appUrl}" class="project-list-link" style="text-decoration:none;">
                      <div class="project-list-main">
                        <div class="project-list-header">
                          <span class="project-icon" style="font-size:1.25rem;">
                            <i class="fas fa-bolt" style="color:var(--primary-color);"></i>
                          </span>
                          <h3 class="project-name">${app.name}</h3>
                          <span style="display:inline-flex;align-items:center;gap:0.375rem;font-size:0.75rem;font-weight:500;color:${statusColor};background:${statusColor}15;padding:0.2rem 0.625rem;border-radius:999px;margin-left:0.5rem;">
                            ${app.status === "running" ? html`<span style="width:6px;height:6px;border-radius:50%;background:${statusColor};display:inline-block;"></span>` : ""}
                            ${app.status.charAt(0).toUpperCase() + app.status.slice(1)}
                          </span>
                        </div>
                        <div class="project-stats">
                          <div class="stat-item">
                            <i class="fas fa-${app.projectName ? "folder" : "user"}"></i>
                            <span class="stat-label">${app.projectName ?? "Standalone"}</span>
                          </div>
                          <div class="stat-item">
                            <i class="fas fa-calendar"></i>
                            <span class="stat-label">${dateStr}</span>
                          </div>
                          ${app.previewUrl ? html`
                            <div class="stat-item">
                              <i class="fas fa-globe" style="color:#22c55e;"></i>
                              <span class="stat-label" style="color:#22c55e;">Live</span>
                            </div>
                          ` : ""}
                        </div>
                      </div>
                    </a>
                    <div class="project-list-actions">
                      <a href="${appUrl}" class="project-action-button">
                        <i class="fas fa-eye"></i> View
                      </a>
                      ${app.previewUrl ? html`
                        <a href="${app.previewUrl}" target="_blank" rel="noopener" class="project-action-button">
                          <i class="fas fa-external-link-alt"></i> Preview
                        </a>
                      ` : ""}
                      <button type="button" class="project-action-button" data-delete-app="${app.appId}" data-app-name="${app.name}" style="color:#f87171;border-color:rgba(248,113,113,.3);background:transparent;cursor:pointer;">
                        <i class="fas fa-trash"></i> Delete
                      </button>
                    </div>
                  </div>
                `;
              })}
            </div>
          `}
        ` : html`
          <!-- Project list -->
          <p style="color:var(--text-secondary);font-size:0.875rem;margin:0 0 1rem;">
            ${projects.length} project${projects.length !== 1 ? "s" : ""}
          </p>
          ${projects.length === 0 ? html`
            <div style="text-align:center;padding:4rem 2rem;color:var(--text-secondary);">
              <i class="fas fa-folder-open" style="font-size:3rem;margin-bottom:1rem;opacity:0.3;display:block;"></i>
              <p style="margin:0 0 1rem;">No projects yet.</p>
              <button
                onclick="document.getElementById('create-modal').classList.add('active')"
                class="btn btn-primary"
              >Create your first project</button>
            </div>
          ` : html`
            <div class="project-list">
              ${projects.map((p) => {
                const st = projectStats[p.id] ?? { conversations: 0, tickets: 0, docs: 0, pending: 0 };
                return html`
                <div class="project-list-item">
                  <a href="/projects/${p.projectId}" class="project-list-link">
                    <div class="project-list-main">
                      <div class="project-list-header">
                        <span class="project-icon">${p.icon}</span>
                        <h3 class="project-name">${p.name}</h3>
                        ${st.pending > 0 ? html`<span title="${st.pending} item${st.pending === 1 ? "" : "s"} need your attention" style="margin-left:0.5rem;font-size:0.7rem;background:var(--primary-color);color:#fff;padding:0.1rem 0.5rem;border-radius:9999px;font-weight:600;"><i class="fas fa-bell" style="font-size:0.6rem;margin-right:0.25rem;"></i>${st.pending}</span>` : ""}
                      </div>
                      <div class="project-stats">
                        <div class="stat-item">
                          <i class="fas fa-comments"></i>
                          <span class="stat-value">${st.conversations}</span>
                          <span class="stat-label">Chat${st.conversations === 1 ? "" : "s"}</span>
                        </div>
                        <div class="stat-item">
                          <i class="fas fa-file-lines"></i>
                          <span class="stat-value">${st.docs}</span>
                          <span class="stat-label">Doc${st.docs === 1 ? "" : "s"}</span>
                        </div>
                        <div class="stat-item">
                          <i class="fas fa-tasks"></i>
                          <span class="stat-value">${st.tickets}</span>
                          <span class="stat-label">Ticket${st.tickets === 1 ? "" : "s"}</span>
                        </div>
                      </div>
                    </div>
                  </a>
                  <div class="project-list-actions">
                    <a href="/chat/project/${p.projectId}" class="project-action-button">
                      <i class="fas fa-comment"></i> Chat
                    </a>
                    <a href="/projects/${p.projectId}" class="project-action-button">
                      <i class="fas fa-tachometer-alt"></i> Dashboard
                    </a>
                    <a href="/instant/project/${p.projectId}" class="project-action-button">
                      <i class="fas fa-bolt"></i> Instant
                    </a>
                  </div>
                </div>
              `; })}
            </div>
          `}
        `}
      </div>
    </div>
  </div>

  <!-- Create Project Modal -->
  <div id="create-modal" class="modal-overlay" style="display:none;position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,0.6);align-items:center;justify-content:center;">
    <div class="modal-content" style="background:var(--card-bg);border:1px solid var(--border-color);border-radius:var(--radius-lg);padding:2rem;width:100%;max-width:480px;position:relative;">
      <button onclick="document.getElementById('create-modal').classList.remove('active')"
        style="position:absolute;top:1rem;right:1rem;background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:1.25rem;">
        <i class="fas fa-times"></i>
      </button>
      <h2 style="margin:0 0 1.5rem;font-size:1.25rem;font-weight:600;color:var(--text-color);">New Project</h2>
      <form method="POST" action="/projects/create" id="create-project-form">
        <div style="margin-bottom:1rem;">
          <label style="display:block;font-size:0.875rem;font-weight:500;color:var(--text-color);margin-bottom:0.5rem;">
            Project Name <span style="color:var(--danger-color);">*</span>
          </label>
          <input
            type="text"
            name="name"
            id="project-name"
            required
            placeholder="e.g. My Awesome App"
            class="input"
            style="width:100%;box-sizing:border-box;"
          />
        </div>
        <div style="margin-bottom:1.5rem;">
          <label style="display:block;font-size:0.875rem;font-weight:500;color:var(--text-color);margin-bottom:0.5rem;">Icon</label>
          <div class="emoji-picker" style="display:flex;flex-wrap:wrap;gap:0.5rem;">
            ${(["📋","🚀","💡","🛠️","🎯","📱","🌐","🔧","⚡","🎨","🤖","📊"] as string[]).map((e, i) => html`
              <button type="button" class="emoji-option${i === 0 ? " selected" : ""}"
                data-emoji="${e}"
                style="font-size:1.25rem;padding:0.25rem 0.5rem;border-radius:var(--radius);border:1px solid ${i === 0 ? "var(--primary-color)" : "var(--border-color)"};background:${i === 0 ? "rgba(139,92,246,0.1)" : "transparent"};cursor:pointer;">
                ${e}
              </button>
            `)}
          </div>
          <input type="hidden" name="icon" id="project-icon" value="📋" />
        </div>
        <div style="display:flex;gap:0.75rem;justify-content:flex-end;">
          <button type="button"
            onclick="document.getElementById('create-modal').classList.remove('active')"
            class="btn btn-secondary">Cancel</button>
          <button type="submit" class="btn btn-primary">
            <i class="fas fa-plus"></i> Create Project
          </button>
        </div>
      </form>
    </div>
  </div>

  <script src="/public/js/sidebar.js"></script>
  <script src="/public/js/projects.js"></script>
  <script src="/public/js/agents.js"></script>
  <script>
    // Modal open/close
    const modal = document.getElementById('create-modal');
    const observer = new MutationObserver(mutations => {
      for (const m of mutations) {
        if (m.type === 'attributes' && m.attributeName === 'class') {
          modal.style.display = modal.classList.contains('active') ? 'flex' : 'none';
        }
      }
    });
    observer.observe(modal, { attributes: true });
    modal.addEventListener('click', function(e) {
      if (e.target === this) this.classList.remove('active');
    });
    // Emoji picker - use data-emoji attribute to avoid textContent trimming issues
    document.querySelectorAll('.emoji-option').forEach(btn => {
      btn.addEventListener('click', function() {
        document.getElementById('project-icon').value = this.dataset.emoji || this.textContent.trim();
        document.querySelectorAll('.emoji-option').forEach(o => {
          o.classList.remove('selected');
          o.style.border = '1px solid var(--border-color)';
          o.style.background = 'transparent';
        });
        this.classList.add('selected');
        this.style.border = '1px solid var(--primary-color)';
        this.style.background = 'rgba(139,92,246,0.1)';
      });
    });
    // Delete an instant app (data-attr + delegated listener — no inline onclick).
    document.addEventListener('click', function(e) {
      var btn = e.target.closest && e.target.closest('[data-delete-app]');
      if (!btn) return;
      e.preventDefault();
      var appId = btn.getAttribute('data-delete-app');
      var name = btn.getAttribute('data-app-name') || 'this app';
      if (!confirm('Delete "' + name + '"? This stops its sandbox and permanently removes the app.')) return;
      btn.disabled = true;
      fetch('/api/instant/apps/' + appId, { method: 'DELETE', credentials: 'same-origin' })
        .then(function(r){ return r.json().catch(function(){ return {}; }); })
        .then(function(d){ if (d && d.error) { alert(d.error); btn.disabled = false; } else { window.location.reload(); } })
        .catch(function(){ btn.disabled = false; alert('Failed to delete the app.'); });
    });
  </script>
</body>
</html>`;
}
