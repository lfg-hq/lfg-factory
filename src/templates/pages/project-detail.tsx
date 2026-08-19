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
    repoProvider?: string;
  };
  githubConnected: boolean;
  gitlabConnected?: boolean;
  role?: string;
  isOwner?: boolean;
  conversations: Conversation[];
  stages: TicketStage[];
  ticketCounts: Record<string, number>;
  envVars: EnvVar[];
  instantApps: InstantAppSummary[];
  docsCount?: number;
  memberCount?: number;
  openTicketCount?: number;
  activeTab?: string;
}

export function ProjectDetailPage({
  user,
  project,
  githubConnected,
  gitlabConnected = false,
  role = "owner",
  isOwner = true,
  conversations,
  stages,
  ticketCounts,
  envVars,
  instantApps = [],
  docsCount = 0,
  memberCount = 1,
  openTicketCount = 0,
  activeTab = "conversations",
}: ProjectDetailPageProps) {
  const totalTickets = Object.values(ticketCounts).reduce((a, b) => a + b, 0);
  const avatarLetter = (user.name?.[0] ?? user.email?.[0] ?? "?").toUpperCase();
  // Human labels: an invited "member" is shown as a Collaborator.
  const roleLabel = ({ owner: "Owner", admin: "Admin", member: "Collaborator", viewer: "Viewer", guest: "Guest" }[role] ?? role);

  return html`<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/x-icon" href="/public/images/favicon.ico" />
  <title>${project.name} — LFG</title>
  <script>(function(){if(localStorage.getItem('sidebarMinimized')==='true'){document.documentElement.classList.add('sidebar-minimized-preload');}})()</script>
  <link rel="stylesheet" href="/public/css/theme-variables.css" />
  <link rel="stylesheet" href="/public/css/common.css" />
  <link rel="stylesheet" href="/public/css/sidebar.css" />
  <link rel="stylesheet" href="/public/css/projects.css" />
  <link rel="stylesheet" href="/public/css/project_detail.css" />
  <link rel="stylesheet" href="/public/css/artifacts.css" />
  <link rel="stylesheet" href="/public/css/document-comments.css" />
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
          <a href="/projects/${project.projectId}" class="nav-link${activeTab === "home" ? " active" : ""}">
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
      <!-- Project Header -->
      <div class="page-header" style="padding:1.25rem 2rem;border-bottom:1px solid var(--border-color);display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:nowrap;gap:1rem;">
        <div style="display:flex;align-items:center;gap:0.75rem;flex:1 1 auto;min-width:0;">
          <a href="/projects" style="color:var(--text-secondary);text-decoration:none;font-size:0.875rem;display:flex;align-items:center;gap:0.4rem;white-space:nowrap;">
            <i class="fas fa-arrow-left"></i> Projects
          </a>
          <span style="color:var(--text-secondary);">/</span>
          <span style="font-size:1.5rem;">${project.icon}</span>
          <div style="min-width:0;">
            <h1 style="font-size:1.25rem;font-weight:700;color:var(--text-color);margin:0;">${project.name}</h1>
            <div style="display:flex;gap:0.5rem;align-items:center;margin-top:0.2rem;flex-wrap:wrap;">
              <span style="font-size:0.75rem;padding:0.2rem 0.5rem;border-radius:9999px;background:${project.status === "active" ? "rgba(34,197,94,0.1)" : "rgba(156,163,175,0.1)"};color:${project.status === "active" ? "#22c55e" : "var(--text-secondary)"};">
                ${project.status}
              </span>
              ${!isOwner ? html`<span title="You were invited to this project" style="font-size:0.75rem;padding:0.2rem 0.5rem;border-radius:9999px;background:rgba(139,92,246,0.12);color:var(--primary-color);display:inline-flex;align-items:center;gap:0.3rem;"><i class="fas fa-user-group"></i> Shared · ${roleLabel}</span>` : ""}
              ${project.repoUrl ? html`
                <a href="${project.repoUrl}" target="_blank" style="font-size:0.75rem;color:var(--text-secondary);text-decoration:none;display:flex;align-items:center;gap:0.3rem;">
                  <i class="fab ${project.repoProvider === "gitlab" ? "fa-gitlab" : "fa-github"}"></i> ${project.repoOwner}/${project.repoName}
                </a>
              ` : ""}
            </div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:0.75rem;flex:0 0 auto;">
          ${!project.repoUrl ? html`
            <button onclick="showCodebaseModal()" class="btn btn-secondary" style="display:flex;align-items:center;gap:0.5rem;font-size:0.8125rem;white-space:nowrap;">
              <i class="fas fa-link"></i> Link Repository
            </button>
          ` : html`
            <button onclick="showCodebaseModal()" class="btn btn-secondary" style="display:flex;align-items:center;gap:0.5rem;font-size:0.8125rem;white-space:nowrap;">
              <i class="fab ${project.repoProvider === "gitlab" ? "fa-gitlab" : "fa-github"}"></i> Change Repo
            </button>
          `}
          <a href="/chat/project/${project.projectId}" class="btn btn-primary" style="display:flex;align-items:center;gap:0.5rem;white-space:nowrap;">
            <i class="fas fa-arrow-left"></i> Back to Workspace
          </a>
        </div>
      </div>

      <!-- Horizontal Tab Nav -->
      <div class="project-tabs" style="display:flex;gap:0;border-bottom:1px solid var(--border-color);padding:0 2rem;background:var(--body-bg);">
        <a href="/projects/${project.projectId}" class="tab-item${activeTab === "home" ? " active" : ""}" style="display:flex;align-items:center;gap:0.5rem;padding:0.875rem 1.25rem;text-decoration:none;font-size:0.875rem;font-weight:500;color:${activeTab === "home" ? "var(--text-color)" : "var(--text-secondary)"};border-bottom:2px solid ${activeTab === "home" ? "var(--primary-color)" : "transparent"};margin-bottom:-1px;transition:color 0.15s;">
          <i class="fas fa-house"></i> Home
        </a>
        <a href="/projects/${project.projectId}?tab=inbox" class="tab-item${activeTab === "inbox" ? " active" : ""}" style="display:flex;align-items:center;gap:0.5rem;padding:0.875rem 1.25rem;text-decoration:none;font-size:0.875rem;font-weight:500;color:${activeTab === "inbox" ? "var(--text-color)" : "var(--text-secondary)"};border-bottom:2px solid ${activeTab === "inbox" ? "var(--primary-color)" : "transparent"};margin-bottom:-1px;transition:color 0.15s;">
          <i class="fas fa-inbox"></i> Inbox
          <span id="inbox-tab-badge" style="display:none;font-size:0.7rem;background:var(--primary-color);color:#fff;padding:0.1rem 0.4rem;border-radius:9999px;"></span>
        </a>
        <a href="/projects/${project.projectId}?tab=conversations" class="tab-item${activeTab === "conversations" ? " active" : ""}" style="display:flex;align-items:center;gap:0.5rem;padding:0.875rem 1.25rem;text-decoration:none;font-size:0.875rem;font-weight:500;color:${activeTab === "conversations" ? "var(--text-color)" : "var(--text-secondary)"};border-bottom:2px solid ${activeTab === "conversations" ? "var(--primary-color)" : "transparent"};margin-bottom:-1px;transition:color 0.15s;">
          <i class="fas fa-comments"></i> Chats
          ${conversations.length > 0 ? html`<span style="font-size:0.7rem;background:rgba(139,92,246,0.2);color:#a78bfa;padding:0.1rem 0.4rem;border-radius:9999px;">${conversations.length}</span>` : ""}
        </a>
        <a href="/projects/${project.projectId}?tab=documents" class="tab-item${activeTab === "documents" ? " active" : ""}" style="display:flex;align-items:center;gap:0.5rem;padding:0.875rem 1.25rem;text-decoration:none;font-size:0.875rem;font-weight:500;color:${activeTab === "documents" ? "var(--text-color)" : "var(--text-secondary)"};border-bottom:2px solid ${activeTab === "documents" ? "var(--primary-color)" : "transparent"};margin-bottom:-1px;transition:color 0.15s;">
          <i class="fas fa-file-lines"></i> Documents
        </a>
        <a href="/projects/${project.projectId}?tab=tickets" class="tab-item${activeTab === "tickets" ? " active" : ""}" style="display:flex;align-items:center;gap:0.5rem;padding:0.875rem 1.25rem;text-decoration:none;font-size:0.875rem;font-weight:500;color:${activeTab === "tickets" ? "var(--text-color)" : "var(--text-secondary)"};border-bottom:2px solid ${activeTab === "tickets" ? "var(--primary-color)" : "transparent"};margin-bottom:-1px;transition:color 0.15s;">
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
      <style>
        /* Clean, blended list — one bordered container with subtle row dividers. */
        .lfg-list { border:1px solid var(--border-color); border-radius:var(--radius); overflow:hidden; background:var(--card-bg); }
        .lfg-row { display:flex; align-items:center; gap:0.875rem; padding:0.875rem 1rem; border-bottom:1px solid var(--border-color); text-decoration:none; color:var(--text-color); cursor:pointer; transition:background 0.12s; }
        .lfg-row:last-child { border-bottom:none; }
        .lfg-row:hover { background:rgba(139,92,246,0.06); }
      </style>
      <script>
        (function(){
          // Populate the Inbox tab's unread badge. On Home the /home payload
          // already sets it, so skip the extra call there.
          if ('${activeTab}' === 'home') return;
          fetch('/api/projects/${project.projectId}/notifications').then(function(r){return r.json();}).then(function(d){
            var unread = (d.notifications||[]).filter(function(n){ return !n.readAt; }).length;
            var b = document.getElementById('inbox-tab-badge');
            if (b && unread){ b.textContent = unread; b.style.display = ''; }
          }).catch(function(){});
        })();
      </script>

      <!-- Tab content -->
      <div style="padding:2rem;max-width:1200px;margin:0 auto;">
        ${(activeTab === "home" || activeTab === "inbox") ? html`
          <style>
            @media (max-width: 900px) {
              .home-grid { grid-template-columns: 1fr !important; }
              .start-work-options { grid-template-columns: 1fr !important; }
            }
            .home-card { border:1px solid var(--border-color); border-radius:var(--radius-lg); background:var(--card-bg); padding:1.25rem 1.5rem; }
            .home-sec-title { font-size:0.75rem; font-weight:600; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.03em; margin:0 0 0.75rem; }
            .start-work-card { margin-bottom:1.5rem; padding:1.5rem; border-color:rgba(139,92,246,0.28); background:linear-gradient(135deg,rgba(139,92,246,0.07),rgba(139,92,246,0.015) 50%,var(--card-bg)); }
            .start-work-eyebrow { display:flex;align-items:center;gap:0.4rem;margin-bottom:0.45rem;color:var(--primary-color);font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.08em; }
            .start-work-title { margin:0;color:var(--text-color);font-size:1.15rem;font-weight:700; }
            .start-work-intro { margin:0.4rem 0 0;color:var(--text-secondary);font-size:0.86rem;line-height:1.5; }
            .start-work-options { display:grid;grid-template-columns:1.25fr 1fr;gap:0.75rem;margin-top:1.15rem; }
            .start-choice { display:flex;align-items:flex-start;gap:0.9rem;min-width:0;padding:1rem;border:1px solid var(--border-color);border-radius:var(--radius);background:var(--card-bg);text-decoration:none;transition:border-color .15s,background .15s,transform .15s,box-shadow .15s; }
            .start-choice:hover { transform:translateY(-1px);border-color:rgba(139,92,246,0.5);box-shadow:0 6px 18px rgba(0,0,0,0.08); }
            .start-choice-primary { border-color:rgba(139,92,246,0.42);background:rgba(139,92,246,0.08); }
            .start-choice-icon { width:38px;height:38px;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;flex:none;background:rgba(139,92,246,0.14);color:var(--primary-color);font-size:0.95rem; }
            .start-choice-secondary .start-choice-icon { background:rgba(100,116,139,0.12);color:var(--text-secondary); }
            .start-choice-body { min-width:0;flex:1; }
            .start-choice-title { display:block;color:var(--text-color);font-size:0.92rem;font-weight:650; }
            .start-choice-copy { display:block;margin-top:0.28rem;color:var(--text-secondary);font-size:0.79rem;line-height:1.45; }
            .start-choice-cta { display:inline-flex;align-items:center;gap:0.35rem;margin-top:0.72rem;color:var(--primary-color);font-size:0.8rem;font-weight:650; }
            .home-team-actions { display:flex;align-items:center;gap:0.7rem; }
            .home-team-action { display:inline-flex;align-items:center;gap:0.3rem;padding:0;border:0;background:none;color:var(--primary-color);font:inherit;font-size:0.76rem;text-decoration:none;cursor:pointer; }
          </style>

          ${activeTab === "home" ? html`
          <!-- Project summary -->
          <div class="home-card" style="margin-bottom:1rem;padding:1rem 1.25rem;">
            <div style="display:flex;align-items:center;gap:0.75rem;min-width:0;">
              <span style="font-size:1.35rem;">${project.icon}</span>
              <div style="min-width:0;flex:1;">
                <div style="display:flex;align-items:center;gap:0.55rem;flex-wrap:wrap;">
                  <h2 style="margin:0;font-size:1.08rem;font-weight:700;color:var(--text-color);">${project.name}</h2>
                  <span style="font-size:0.7rem;padding:0.12rem 0.45rem;border-radius:9999px;background:${project.status === "active" ? "rgba(34,197,94,0.12)" : "rgba(156,163,175,0.12)"};color:${project.status === "active" ? "#22c55e" : "var(--text-secondary)"};">${project.status}</span>
                </div>
                <div style="display:flex;gap:1.15rem;flex-wrap:wrap;margin-top:0.5rem;font-size:0.78rem;color:var(--text-secondary);">
                  <span><i class="fas fa-file-lines" style="margin-right:0.32rem;opacity:0.7;"></i>${docsCount} doc${docsCount === 1 ? "" : "s"}</span>
                  <span><i class="fas fa-list-check" style="margin-right:0.32rem;opacity:0.7;"></i>${openTicketCount} ticket${openTicketCount === 1 ? "" : "s"}</span>
                  <span><i class="fas fa-users" style="margin-right:0.32rem;opacity:0.7;"></i>${memberCount} member${memberCount === 1 ? "" : "s"}</span>
                  ${project.repoUrl ? html`<a href="${project.repoUrl}" target="_blank" style="color:var(--text-secondary);text-decoration:none;"><i class="fab ${project.repoProvider === "gitlab" ? "fa-gitlab" : "fa-github"}" style="margin-right:0.32rem;"></i>${project.repoOwner}/${project.repoName}</a>` : html`<span style="opacity:0.8;"><i class="fas fa-code-branch" style="margin-right:0.32rem;"></i>No repo linked</span>`}
                </div>
              </div>
              ${!project.repoUrl && (isOwner || role === "admin") ? html`<button onclick="showCodebaseModal()" class="home-team-action" style="flex:none;"><i class="fas fa-link"></i> Connect repo</button>` : ""}
            </div>
          </div>

          ${role !== "viewer" ? html`
          <!-- Guided work entry point -->
          <section class="home-card start-work-card" aria-labelledby="start-work-title">
            <div class="start-work-eyebrow"><i class="fas fa-location-arrow"></i> Start here</div>
            <h2 class="start-work-title" id="start-work-title">What would you like to work on?</h2>
            <p class="start-work-intro">Not sure where to begin? Start with a chat. You can turn the result into tickets once the work is clear.</p>
            <div class="start-work-options">
              <a href="/chat/project/${project.projectId}?new=1" class="start-choice start-choice-primary">
                <span class="start-choice-icon"><i class="fas fa-comments"></i></span>
                <span class="start-choice-body">
                  <span class="start-choice-title">Describe what you need</span>
                  <span class="start-choice-copy">Start with an idea, problem, or outcome—even if it is vague. The AI will ask questions, inspect the project, and help shape the work.</span>
                  <span class="start-choice-cta">Start a chat <i class="fas fa-arrow-right"></i></span>
                </span>
              </a>
              <a href="/projects/${project.projectId}?tab=tickets&create=1" class="start-choice start-choice-secondary">
                <span class="start-choice-icon"><i class="fas fa-list-check"></i></span>
                <span class="start-choice-body">
                  <span class="start-choice-title">Create a ticket directly</span>
                  <span class="start-choice-copy">Best for a specific task or bug you can already describe. It can still be refined before anything is built.</span>
                  <span class="start-choice-cta">Create ticket <i class="fas fa-arrow-right"></i></span>
                </span>
              </a>
            </div>
          </section>
          ` : ""}

          <!-- Two-column: (required actions + activity) | team + pins -->
          <div class="home-grid" style="display:grid;grid-template-columns:1fr 340px;gap:1.5rem;align-items:start;">
            <div style="display:flex;flex-direction:column;gap:1.5rem;">
              <!-- Required actions (unread inbox items) -->
              <div class="home-card" id="home-actions" style="display:none;border-color:var(--primary-color);background:rgba(139,92,246,0.05);">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                  <h3 class="home-sec-title" style="margin:0;color:var(--primary-color);"><i class="fas fa-bell" style="margin-right:0.35rem;"></i>Needs your attention</h3>
                  <a href="/projects/${project.projectId}?tab=inbox" style="font-size:0.78rem;color:var(--primary-color);text-decoration:none;">Open inbox</a>
                </div>
                <div id="home-actions-list" style="margin-top:0.5rem;"></div>
              </div>

              <!-- Recent chats -->
              <div class="home-card">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                  <h3 class="home-sec-title" style="margin:0;">Recent chats</h3>
                  <a href="/projects/${project.projectId}?tab=conversations" style="font-size:0.78rem;color:var(--primary-color);text-decoration:none;">See all</a>
                </div>
                ${conversations.length === 0 ? html`
                  <div style="margin-top:0.5rem;color:var(--text-secondary);font-size:0.85rem;padding:0.5rem 0;">No chats yet. <a href="/chat/project/${project.projectId}" style="color:var(--primary-color);text-decoration:none;">Start one →</a></div>
                ` : html`
                  <div class="lfg-list" style="margin-top:0.6rem;">
                    ${conversations.slice(0, 5).map((cv) => html`
                      <a href="/chat/project/${project.projectId}/conversation/${cv.id}" class="lfg-row">
                        <span style="flex:1;font-size:0.875rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${cv.title ?? "Untitled conversation"}</span>
                        <span style="font-size:0.72rem;color:var(--text-secondary);flex:none;">${new Date(cv.updatedAt).toLocaleDateString()}</span>
                      </a>
                    `)}
                  </div>
                `}
              </div>

              <!-- Activity feed -->
              <div class="home-card">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                  <h3 class="home-sec-title" style="margin:0;">Activity</h3>
                  <a href="/projects/${project.projectId}?tab=events" style="font-size:0.78rem;color:var(--primary-color);text-decoration:none;">See all</a>
                </div>
                <div id="home-activity" style="margin-top:0.5rem;"><div style="color:var(--text-secondary);font-size:0.85rem;padding:0.75rem 0;">Loading…</div></div>
              </div>
            </div>

            <!-- Sidebar -->
            <div style="display:flex;flex-direction:column;gap:1.5rem;">
              <!-- Team -->
              <div class="home-card">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                  <h3 class="home-sec-title" style="margin:0;">Team</h3>
                  <div class="home-team-actions">
                    ${memberCount > 1 ? html`<button onclick="openRequestModal()" class="home-team-action"><i class="fas fa-paper-plane"></i> Message</button>` : ""}
                    ${(isOwner || role === "admin") ? html`<a href="/projects/${project.projectId}?tab=settings" class="home-team-action"><i class="fas fa-user-plus"></i> Invite</a>` : ""}
                  </div>
                </div>
                <div id="home-team" style="margin-top:0.6rem;"><div style="color:var(--text-secondary);font-size:0.85rem;">Loading…</div></div>
              </div>

              <!-- Pinned "Start here" -->
              <div class="home-card">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                  <h3 class="home-sec-title" style="margin:0;">📌 Start here</h3>
                  <button id="home-pin-add" onclick="openPinModal()" style="display:none;background:none;border:none;color:var(--primary-color);cursor:pointer;font-size:0.78rem;"><i class="fas fa-plus"></i> Pin</button>
                </div>
                <div id="home-pins" style="margin-top:0.6rem;"><div style="color:var(--text-secondary);font-size:0.85rem;">Loading…</div></div>
              </div>
            </div>
          </div>

          <!-- Pin modal (owner/admin) -->
          <div class="modal-overlay" id="pinModal" style="position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,0.7);align-items:center;justify-content:center;">
            <div style="background:var(--card-bg);border:1px solid var(--border-color);border-radius:var(--radius-lg);width:100%;max-width:440px;">
              <div style="display:flex;align-items:center;justify-content:space-between;padding:1.25rem 1.5rem;border-bottom:1px solid var(--border-color);">
                <h3 style="margin:0;font-size:1.1rem;font-weight:600;color:var(--text-color);">Pin a resource</h3>
                <button type="button" onclick="document.getElementById('pinModal').classList.remove('active')" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:1.25rem;">&times;</button>
              </div>
              <div style="padding:1.5rem;">
                <div style="margin-bottom:1rem;"><label style="display:block;font-size:0.85rem;font-weight:500;margin-bottom:0.4rem;color:var(--text-color);">Type</label>
                  <select id="pin-type" class="input" style="width:100%;" onchange="onPinTypeChange()">
                    <option value="document">Document</option>
                    <option value="link">External link</option>
                  </select></div>
                <div id="pin-doc-wrap" style="margin-bottom:1rem;"><label style="display:block;font-size:0.85rem;font-weight:500;margin-bottom:0.4rem;color:var(--text-color);">Document</label>
                  <select id="pin-doc" class="input" style="width:100%;"></select></div>
                <div id="pin-link-wrap" style="margin-bottom:1rem;display:none;">
                  <label style="display:block;font-size:0.85rem;font-weight:500;margin-bottom:0.4rem;color:var(--text-color);">Label</label>
                  <input id="pin-label" class="input" style="width:100%;box-sizing:border-box;margin-bottom:0.6rem;" placeholder="e.g. How we work" />
                  <label style="display:block;font-size:0.85rem;font-weight:500;margin-bottom:0.4rem;color:var(--text-color);">URL</label>
                  <input id="pin-url" class="input" style="width:100%;box-sizing:border-box;" placeholder="https://…" />
                </div>
                <div id="pin-error" style="display:none;color:#ef4444;font-size:0.8rem;margin-bottom:0.6rem;"></div>
                <div style="display:flex;gap:0.75rem;justify-content:flex-end;">
                  <button class="btn btn-secondary" onclick="document.getElementById('pinModal').classList.remove('active')">Cancel</button>
                  <button class="btn btn-primary" onclick="submitPin()">Pin</button>
                </div>
              </div>
            </div>
          </div>
          ` : ""}

          ${activeTab === "inbox" ? html`
          <!-- Dedicated Inbox: received / sent messages -->
          <div class="home-card" id="inbox-section" style="margin-bottom:1.5rem;">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:0.75rem;flex-wrap:wrap;margin-bottom:0.75rem;">
              <div style="display:flex;gap:1rem;align-items:center;">
                <h2 style="margin:0;font-size:1.1rem;font-weight:600;color:var(--text-color);">Inbox</h2>
                <div style="display:inline-flex;gap:1rem;">
                  <button id="inbox-tab-received" onclick="switchInboxTab('received')" style="font-size:0.85rem;padding:0.15rem 0;border:none;background:none;color:var(--text-color);font-weight:600;border-bottom:2px solid var(--primary-color);cursor:pointer;">Received</button>
                  <button id="inbox-tab-sent" onclick="switchInboxTab('sent')" style="font-size:0.85rem;padding:0.15rem 0;border:none;background:none;color:var(--text-secondary);font-weight:500;border-bottom:2px solid transparent;cursor:pointer;">Sent</button>
                </div>
              </div>
              <div style="display:flex;gap:0.5rem;align-items:center;">
                <button id="inbox-markread" onclick="markAllInboxRead()" class="btn btn-secondary" style="font-size:0.75rem;display:none;">Mark all read</button>
                <button onclick="openRequestModal()" class="btn btn-primary" style="font-size:0.75rem;"><i class="fas fa-paper-plane"></i> New message</button>
              </div>
            </div>
            <div id="inbox-list"><div style="color:var(--text-secondary);font-size:0.875rem;padding:1rem;border:1px dashed var(--border-color);border-radius:var(--radius);text-align:center;">No items yet — assigned tickets, mentions and messages sent to you show up here.</div></div>
          </div>

          <!-- Sent-message detail modal -->
          <div class="modal-overlay" id="sentDetailModal" style="position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,0.7);align-items:center;justify-content:center;">
            <div style="background:var(--card-bg);border:1px solid var(--border-color);border-radius:var(--radius-lg);width:100%;max-width:480px;">
              <div style="display:flex;align-items:center;justify-content:space-between;padding:1.25rem 1.5rem;border-bottom:1px solid var(--border-color);">
                <h3 style="margin:0;font-size:1.1rem;font-weight:600;color:var(--text-color);">Message</h3>
                <button type="button" onclick="document.getElementById('sentDetailModal').classList.remove('active')" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:1.25rem;line-height:1;">&times;</button>
              </div>
              <div id="sent-detail-body" style="padding:1.5rem;font-size:0.9rem;color:var(--text-color);"></div>
            </div>
          </div>
          ` : ""}

          <!-- Compose-message modal (shared by Home + Inbox) -->
          <div class="modal-overlay" id="requestModal" style="position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,0.7);align-items:center;justify-content:center;">
            <div style="background:var(--card-bg);border:1px solid var(--border-color);border-radius:var(--radius-lg);width:100%;max-width:480px;">
              <div style="display:flex;align-items:center;justify-content:space-between;padding:1.25rem 1.5rem;border-bottom:1px solid var(--border-color);">
                <h3 style="margin:0;font-size:1.1rem;font-weight:600;color:var(--text-color);">Send a message</h3>
                <button type="button" onclick="closeRequestModal()" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:1.25rem;line-height:1;">&times;</button>
              </div>
              <div style="padding:1.5rem;">
                <div style="margin-bottom:1rem;"><label style="display:block;font-size:0.875rem;font-weight:500;color:var(--text-color);margin-bottom:0.4rem;">To</label><select id="rq-user" class="input" style="width:100%;"></select></div>
                <div style="margin-bottom:1rem;"><label style="display:block;font-size:0.875rem;font-weight:500;color:var(--text-color);margin-bottom:0.4rem;">Documents <span style="font-weight:400;color:var(--text-secondary);">(select any)</span></label><div id="rq-docs" style="max-height:120px;overflow-y:auto;border:1px solid var(--border-color);border-radius:var(--radius);padding:0.5rem;font-size:0.8125rem;color:var(--text-secondary);">Loading…</div></div>
                <div style="margin-bottom:1rem;"><label style="display:block;font-size:0.875rem;font-weight:500;color:var(--text-color);margin-bottom:0.4rem;">Tickets <span style="font-weight:400;color:var(--text-secondary);">(select any)</span></label><div id="rq-tickets" style="max-height:120px;overflow-y:auto;border:1px solid var(--border-color);border-radius:var(--radius);padding:0.5rem;font-size:0.8125rem;color:var(--text-secondary);">Loading…</div></div>
                <div style="margin-bottom:1.25rem;"><label style="display:block;font-size:0.875rem;font-weight:500;color:var(--text-color);margin-bottom:0.4rem;">Message</label><textarea id="rq-msg" rows="3" class="input" style="width:100%;box-sizing:border-box;resize:vertical;" placeholder="e.g. Please review the Frontend Remediation Plan"></textarea></div>
                <div id="rq-error" style="display:none;color:#ef4444;font-size:0.8125rem;margin-bottom:0.75rem;"></div>
                <div style="display:flex;gap:0.75rem;justify-content:flex-end;">
                  <button type="button" class="btn btn-secondary" onclick="closeRequestModal()">Cancel</button>
                  <button type="button" class="btn btn-primary" onclick="submitRequest()"><i class="fas fa-paper-plane"></i> Send</button>
                </div>
              </div>
            </div>
          </div>
          <script>
            (function(){
              var RQ_PID = '${project.projectId}';
              var RQ_ME = '${user.id}';
              function rqEsc(s){ return (s||'').replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
              function rqCheckboxList(el, items, cls){
                if (!items.length){ el.innerHTML = '<span style="color:var(--text-secondary);">None available</span>'; return; }
                el.innerHTML = items.map(function(it){
                  return '<label style="display:flex;align-items:center;gap:0.5rem;padding:0.2rem 0;cursor:pointer;color:var(--text-color);">'
                    + '<input type="checkbox" class="'+cls+'" value="'+it.id+'" style="margin:0;"> '
                    + '<span>'+rqEsc(it.name||'Untitled')+'</span></label>';
                }).join('');
              }
              window.openRequestModal = function(){
                document.getElementById('requestModal').classList.add('active');
                document.getElementById('rq-docs').innerHTML = 'Loading…';
                document.getElementById('rq-tickets').innerHTML = 'Loading…';
                Promise.all([
                  fetch('/api/projects/'+RQ_PID+'/members').then(function(r){return r.json();}),
                  fetch('/projects/'+RQ_PID+'/api/files/browser?per_page=100').then(function(r){return r.json();}).catch(function(){return {files:[]};}),
                  fetch('/api/projects/'+RQ_PID+'/tickets').then(function(r){return r.json();}).catch(function(){return {tickets:[]};})
                ]).then(function(res){
                  var m = res[0]||{}; var raw = [];
                  if (m.owner) raw.push({ id:m.owner.id, name:m.owner.name, email:m.owner.email });
                  (m.members||[]).forEach(function(x){ raw.push({ id:x.userId, name:x.userName, email:x.userEmail }); });
                  // Exclude my own account and dedupe by id.
                  var seen = {}, people = [];
                  raw.forEach(function(p){ if (!p.id || p.id===RQ_ME || seen[p.id]) return; seen[p.id]=1; people.push(p); });
                  var uSel = document.getElementById('rq-user');
                  if (!people.length){ uSel.innerHTML = '<option value="">No teammates yet — invite someone first</option>'; }
                  else { uSel.innerHTML = people.map(function(p){ var lbl = (p.name||p.email||'Unknown'); if (p.email && p.name) lbl += ' ('+p.email+')'; return '<option value="'+p.id+'">'+rqEsc(lbl)+'</option>'; }).join(''); }
                  rqCheckboxList(document.getElementById('rq-docs'), (res[1]&&res[1].files)||[], 'rq-doc-cb');
                  rqCheckboxList(document.getElementById('rq-tickets'), (res[2]&&res[2].tickets)||[], 'rq-tkt-cb');
                });
              };
              window.closeRequestModal = function(){ document.getElementById('requestModal').classList.remove('active'); };
              window.submitRequest = function(){
                var toUserId = document.getElementById('rq-user').value;
                var docIds = Array.prototype.slice.call(document.querySelectorAll('.rq-doc-cb:checked')).map(function(c){return c.value;});
                var ticketIds = Array.prototype.slice.call(document.querySelectorAll('.rq-tkt-cb:checked')).map(function(c){return c.value;});
                var message = document.getElementById('rq-msg').value.trim();
                var err = document.getElementById('rq-error');
                if (!toUserId || !message){ err.style.display='block'; err.textContent='Pick a person and write a message.'; return; }
                err.style.display='none';
                fetch('/api/projects/'+RQ_PID+'/requests', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ toUserId:toUserId, message:message, docIds:docIds, ticketIds:ticketIds }) })
                  .then(function(r){ return r.json().then(function(d){return{ok:r.ok,data:d};}); })
                  .then(function(res){ if(!res.ok){ err.style.display='block'; err.textContent=(res.data&&res.data.error)||'Failed to send'; return; } document.getElementById('rq-msg').value=''; closeRequestModal(); if (window.reloadInbox) window.reloadInbox(); });
              };
            })();
          </script>
          <script>
            (function(){
              var IB_PID = '${project.projectId}';
              var IB_TAB = 'received';
              window.markAllInboxRead = function(){
                fetch('/api/projects/'+IB_PID+'/notifications/read', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' }).then(loadInbox);
              };
              function ibEsc(s){ return (s||'').replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
              function relTime(ts){ if(!ts) return ''; var d=new Date(ts); var s=Math.floor((Date.now()-d.getTime())/1000); if(s<60)return 'just now'; if(s<3600)return Math.floor(s/60)+'m ago'; if(s<86400)return Math.floor(s/3600)+'h ago'; return d.toLocaleDateString(); }
              function iconFor(t){ return t==='assigned'?'fa-user-check':(t==='mentioned'?'fa-at':(t==='review_requested'?'fa-paper-plane':'fa-comment')); }
              function ibEmpty(msg){ return '<div style="color:var(--text-secondary);font-size:0.875rem;padding:1rem;border:1px dashed var(--border-color);border-radius:var(--radius);text-align:center;">'+msg+'</div>'; }
              var IB_SENT = [], IB_RECV = [];
              // e.g. "Ada Lovelace" / "ada@example.com" -> "@ada" for a compact tagged handle.
              function atHandle(name, email){
                var h = ((name||'').trim().split(/\s+/)[0]) || ((email||'').split('@')[0]) || 'user';
                return '@' + h.toLowerCase();
              }
              // Split "message — re: 📄 A, 🎫 B" into a clean body + referenced-item list.
              function splitRefs(msg){
                var idx = (msg||'').indexOf(' — re: ');
                if (idx < 0) return { body: msg||'', refs: [] };
                var body = msg.slice(0, idx);
                var refs = msg.slice(idx + 7).split(/,\s+(?=📄|🎫)/).map(function(s){ return s.trim(); }).filter(Boolean);
                return { body: body, refs: refs };
              }
              // Structured refs → rows (one per line). Clickable when we have an id.
              function refsLinkHtml(refs){
                if (!refs.length) return '';
                return '<div style="margin-bottom:1rem;">'+refs.map(function(r){
                  var icon = r.type==='ticket' ? '🎫' : '📄';
                  var inner = icon+' <span style="flex:1;">'+ibEsc(r.name||'Untitled')+'</span>';
                  if (!r.id){
                    return '<div style="display:flex;align-items:center;gap:0.5rem;padding:0.6rem 0.75rem;border:1px solid var(--border-color);border-radius:var(--radius);margin-bottom:0.4rem;font-size:0.85rem;">'+inner+'</div>';
                  }
                  var href = r.type==='ticket'
                    ? ('/projects/'+IB_PID+'?tab=tickets')
                    : ('/projects/'+IB_PID+'?tab=documents&doc='+encodeURIComponent(r.id)+'&docName='+encodeURIComponent(r.name||''));
                  return '<a href="'+href+'" style="display:flex;align-items:center;gap:0.5rem;padding:0.6rem 0.75rem;border:1px solid var(--border-color);border-radius:var(--radius);margin-bottom:0.4rem;font-size:0.85rem;text-decoration:none;color:var(--text-color);">'
                    + inner+'<i class="fas fa-arrow-right" style="font-size:0.7rem;color:var(--text-secondary);"></i></a>';
                }).join('')+'</div>';
              }
              // Resolve legacy text refs ("📄 Name") to {type,id,name} by matching the
              // project's docs by name — so old messages become clickable too.
              var IB_DOCS = null;
              function ensureDocs(cb){
                if (IB_DOCS) return cb(IB_DOCS);
                fetch('/projects/'+IB_PID+'/api/files/browser?per_page=200').then(function(r){return r.json();})
                  .then(function(d){ IB_DOCS = (d && d.files) || []; cb(IB_DOCS); })
                  .catch(function(){ IB_DOCS = []; cb(IB_DOCS); });
              }
              function textRefsToStruct(textRefs, docs){
                return textRefs.map(function(t){
                  var isTicket = /^\s*🎫/.test(t);
                  var name = t.replace(/^\s*(📄|🎫)\s*/, '').trim();
                  var doc = !isTicket && docs ? docs.find(function(d){ return (d.name||'') === name; }) : null;
                  return { type: isTicket ? 'ticket' : 'document', id: doc ? doc.id : null, name: name };
                });
              }
              window.switchInboxTab = function(tab){
                IB_TAB = tab;
                var r = document.getElementById('inbox-tab-received'), s = document.getElementById('inbox-tab-sent');
                var on = 'font-size:0.85rem;padding:0.15rem 0;border:none;background:none;cursor:pointer;color:var(--text-color);font-weight:600;border-bottom:2px solid var(--primary-color);';
                var off = 'font-size:0.85rem;padding:0.15rem 0;border:none;background:none;cursor:pointer;color:var(--text-secondary);font-weight:500;border-bottom:2px solid transparent;';
                r.style.cssText = (tab==='received'?on:off);
                s.style.cssText = (tab==='sent'?on:off);
                document.getElementById('inbox-markread').style.display = 'none';
                if (tab==='sent') loadSent(); else loadInbox();
              };
              window.reloadInbox = function(){ if (IB_TAB==='sent') loadSent(); else loadInbox(); };
              function openDetail(who, whoLabel, n, canDelete){
                var parsed = splitRefs(n.message);
                var when = new Date(n.createdAt).toLocaleString();
                function render(refsArr){
                  var refsBlock = (refsArr && refsArr.length) ? refsLinkHtml(refsArr) : '';
                  document.getElementById('sent-detail-body').innerHTML =
                    '<div style="margin-bottom:0.75rem;"><span style="color:var(--text-secondary);">'+whoLabel+':</span> '+ibEsc(who)+'</div>'
                    + '<div style="margin-bottom:1rem;padding:0.85rem;border:1px solid var(--border-color);border-radius:var(--radius);background:var(--body-bg);font-size:0.9rem;line-height:1.5;">'+ibEsc(parsed.body)+'</div>'
                    + (refsBlock ? '<div style="font-size:0.75rem;color:var(--text-secondary);margin-bottom:0.4rem;font-weight:500;">Referenced</div>'+refsBlock : '')
                    + '<div style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem;">'
                    +   '<span style="font-size:0.8rem;color:var(--text-secondary);">'+(n.readAt?'Seen':'Sent')+' · '+when+'</span>'
                    +   (canDelete ? '<button onclick="deleteCurrentMessage()" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:0.8rem;"><i class="fas fa-trash"></i> Delete</button>' : '')
                    + '</div>';
                }
                IB_DELETE_ID = canDelete ? n.id : null;
                if (n.refs && n.refs.length) {
                  render(n.refs); // structured refs — already clickable
                } else if (parsed.refs.length) {
                  render(textRefsToStruct(parsed.refs, IB_DOCS)); // instant (clickable if docs cached)
                  if (!IB_DOCS) ensureDocs(function(docs){ render(textRefsToStruct(parsed.refs, docs)); });
                } else {
                  render(null);
                }
                document.getElementById('sentDetailModal').classList.add('active');
              }
              var IB_DELETE_ID = null;
              window.showSentDetail = function(i){ var n = IB_SENT[i]; if (n) openDetail(atHandle(n.toName, n.toEmail), n.type==='mentioned'?'Tagged':'To', n, true); };
              window.deleteCurrentMessage = function(){
                var id = IB_DELETE_ID; if (!id) return;
                if (!confirm('Delete this message? It will be removed from the recipient inbox too.')) return;
                fetch('/api/projects/'+IB_PID+'/requests/'+id, { method:'DELETE' })
                  .then(function(r){ return r.json().then(function(d){return {ok:r.ok,data:d};}); })
                  .then(function(res){
                    if (!res.ok){ alert((res.data&&res.data.error)||'Failed to delete'); return; }
                    document.getElementById('sentDetailModal').classList.remove('active');
                    if (window.reloadInbox) window.reloadInbox();
                  });
              };
              window.showRecvDetail = function(i){
                var n = IB_RECV[i]; if (!n) return;
                openDetail(n.actorName||'Someone', 'From', n, false);
                if (!n.readAt){ // mark this one read
                  fetch('/api/projects/'+IB_PID+'/notifications/read', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id:n.id }) })
                    .then(function(){ n.readAt = new Date().toISOString(); loadInbox(); });
                }
              };
              function row(n, i, dim){
                var parsed = splitRefs(n.message);
                return '<div onclick="showRecvDetail('+i+')" class="lfg-row" style="'+(dim?'opacity:0.55;':'')+'">'
                  + '<span style="flex:1;font-size:0.875rem;">'+ibEsc(parsed.body)+(parsed.refs.length?' <span style="color:var(--text-secondary);font-size:0.8rem;">· '+parsed.refs.length+' item'+(parsed.refs.length>1?'s':'')+'</span>':'')+'</span>'
                  + (dim?'':'<span style="width:8px;height:8px;border-radius:50%;background:var(--primary-color);flex:none;"></span>')
                  + '<span style="font-size:0.7rem;color:var(--text-secondary);min-width:64px;text-align:right;">'+relTime(n.createdAt)+'</span>'
                  + '</div>';
              }
              function loadInbox(){
                var list = document.getElementById('inbox-list');
                if (!list) return; // not on the Inbox tab
                fetch('/api/projects/'+IB_PID+'/notifications').then(function(r){return r.json();}).then(function(data){
                  IB_RECV = data.notifications || [];
                  if (!IB_RECV.length){ list.innerHTML = ibEmpty('No items yet — assigned tickets, mentions and messages sent to you show up here.'); return; }
                  document.getElementById('inbox-markread').style.display = IB_RECV.some(function(n){return !n.readAt;}) ? '' : 'none';
                  var html = '<div class="lfg-list">';
                  IB_RECV.forEach(function(n,i){ html += row(n, i, !!n.readAt); });
                  html += '</div>';
                  list.innerHTML = html;
                });
              }
              function loadSent(){
                fetch('/api/projects/'+IB_PID+'/requests/sent').then(function(r){return r.json();}).then(function(data){
                  IB_SENT = data.requests || [];
                  var list = document.getElementById('inbox-list');
                  if (!IB_SENT.length){ list.innerHTML = ibEmpty('You haven\\'t sent any messages yet. Use “New message” to ask a teammate to review docs, tickets, or anything else.'); return; }
                  var html = '<div class="lfg-list">';
                  IB_SENT.forEach(function(n, i){
                    var parsed = splitRefs(n.message);
                    var lbl = n.type==='mentioned' ? 'Tagged' : 'To';
                    html += '<div onclick="showSentDetail('+i+')" class="lfg-row">'
                      + '<span style="flex:1;font-size:0.875rem;"><span style="color:var(--text-secondary);">'+lbl+' </span><span style="color:var(--primary-color);font-weight:500;">'+ibEsc(atHandle(n.toName,n.toEmail))+'</span><span style="color:var(--text-secondary);">:</span> '+ibEsc(parsed.body)+(parsed.refs.length?' <span style="color:var(--text-secondary);font-size:0.8rem;">· '+parsed.refs.length+' item'+(parsed.refs.length>1?'s':'')+'</span>':'')+'</span>'
                      + '<span style="font-size:0.7rem;color:'+(n.readAt?'#22c55e':'var(--text-secondary)')+';min-width:64px;text-align:right;">'+(n.readAt?'seen':'sent')+' · '+relTime(n.createdAt)+'</span>'
                      + '</div>';
                  });
                  html += '</div>';
                  list.innerHTML = html;
                });
              }
              if ('${activeTab}' === 'inbox') loadInbox();
            })();
          </script>
          <script>
            (function(){
              if ('${activeTab}' !== 'home') return; // Home-only widgets (shared script block)
              var HM_PID = '${project.projectId}';
              function hEsc(s){ return (s||'').replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
              function hRel(ts){ if(!ts) return ''; var d=new Date(ts); var s=Math.floor((Date.now()-d.getTime())/1000); if(s<60)return 'just now'; if(s<3600)return Math.floor(s/60)+'m ago'; if(s<86400)return Math.floor(s/3600)+'h ago'; return d.toLocaleDateString(); }
              function actIcon(t){ t=t||''; if(t.indexOf('ticket')>=0)return 'fa-list-check'; if(t.indexOf('doc')>=0||t.indexOf('file')>=0)return 'fa-file-lines'; if(t.indexOf('member')>=0||t.indexOf('join')>=0||t.indexOf('invite')>=0)return 'fa-user-plus'; if(t.indexOf('build')>=0||t.indexOf('deploy')>=0)return 'fa-hammer'; if(t.indexOf('chat')>=0||t.indexOf('conversation')>=0||t.indexOf('message')>=0)return 'fa-comments'; if(t.indexOf('comment')>=0)return 'fa-comment'; return 'fa-circle-dot'; }
              function initials(n){ n=(n||'').trim(); if(!n) return '?'; var p=n.split(/\\s+/); return (p[0][0]+(p[1]?p[1][0]:'')).toUpperCase(); }
              function roleLabel(r){ return (r==='viewer'||r==='guest')?'Viewer':(r==='admin'?'Admin':(r==='owner'?'Owner':'Collaborator')); }

              function renderActivity(acts){
                var el = document.getElementById('home-activity'); if(!el) return;
                if (!acts || !acts.length){ el.innerHTML = '<div style="color:var(--text-secondary);font-size:0.85rem;padding:0.75rem 0;">No activity yet. Actions across the project will appear here.</div>'; return; }
                el.innerHTML = acts.map(function(a){
                  return '<div style="display:flex;gap:0.7rem;padding:0.6rem 0;border-bottom:1px solid var(--border-color);">'
                    + '<i class="fas '+actIcon(a.activityType)+'" style="color:var(--primary-color);margin-top:0.15rem;width:1rem;text-align:center;font-size:0.8rem;"></i>'
                    + '<div style="flex:1;min-width:0;"><div style="font-size:0.85rem;color:var(--text-color);">'+hEsc(a.title)+'</div>'
                    + (a.description?'<div style="font-size:0.78rem;color:var(--text-secondary);margin-top:0.1rem;">'+hEsc(a.description)+'</div>':'')
                    + '<div style="font-size:0.7rem;color:var(--text-secondary);margin-top:0.15rem;">'+hRel(a.createdAt)+'</div></div>'
                    + '</div>';
                }).join('');
              }
              function renderActions(notifs){
                var unread = (notifs||[]).filter(function(n){ return !n.readAt; });
                var card = document.getElementById('home-actions'), list = document.getElementById('home-actions-list');
                if (!card || !list || !unread.length) return;
                list.innerHTML = unread.slice(0,6).map(function(n){
                  var body = (n.message||'').split(' — re: ')[0];
                  return '<a href="'+(n.link||('/projects/'+HM_PID+'?tab=inbox'))+'" style="display:flex;align-items:center;gap:0.6rem;padding:0.5rem 0;border-bottom:1px solid var(--border-color);text-decoration:none;color:var(--text-color);">'
                    + '<span style="width:7px;height:7px;border-radius:50%;background:var(--primary-color);flex:none;"></span>'
                    + '<span style="flex:1;font-size:0.85rem;">'+hEsc(body)+'</span>'
                    + '<span style="font-size:0.7rem;color:var(--text-secondary);flex:none;">'+hRel(n.createdAt)+'</span></a>';
                }).join('');
                card.style.display = '';
              }
              function renderTeam(m){
                var people = [];
                if (m && m.owner) people.push({ name:m.owner.name, email:m.owner.email, role:'owner' });
                ((m&&m.members)||[]).forEach(function(x){ people.push({ name:x.userName, email:x.userEmail, role:x.role }); });
                var el = document.getElementById('home-team'); if(!el) return;
                el.innerHTML = people.map(function(p){
                  return '<div style="display:flex;align-items:center;gap:0.6rem;padding:0.35rem 0;">'
                    + '<span style="width:28px;height:28px;border-radius:50%;background:rgba(139,92,246,0.15);color:var(--primary-color);display:inline-flex;align-items:center;justify-content:center;font-size:0.72rem;font-weight:600;flex:none;">'+hEsc(initials(p.name||p.email))+'</span>'
                    + '<div style="flex:1;min-width:0;"><div style="font-size:0.85rem;color:var(--text-color);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+hEsc(p.name||p.email||'Member')+'</div></div>'
                    + '<span style="font-size:0.7rem;color:var(--text-secondary);flex:none;">'+roleLabel(p.role)+'</span>'
                    + '</div>';
                }).join('');
              }
              function renderPins(pins, canManage){
                window.__pinCanManage = !!canManage;
                var addBtn = document.getElementById('home-pin-add'); if (addBtn) addBtn.style.display = canManage ? '' : 'none';
                var el = document.getElementById('home-pins'); if(!el) return;
                pins = pins || [];
                if (!pins.length){ el.innerHTML = '<div style="color:var(--text-secondary);font-size:0.82rem;">'+(canManage?'Pin key docs or links so everyone knows where to start.':'Nothing pinned yet.')+'</div>'; return; }
                el.innerHTML = pins.map(function(p){
                  var icon = p.targetType==='link'?'fa-link':(p.targetType==='ticket'?'fa-list-check':'fa-file-lines');
                  var ext = p.targetType==='link' ? ' target="_blank"' : '';
                  return '<div style="display:flex;align-items:center;gap:0.5rem;padding:0.3rem 0;">'
                    + '<a href="'+hEsc(p.href)+'"'+ext+' style="flex:1;display:flex;align-items:center;gap:0.5rem;text-decoration:none;color:var(--text-color);font-size:0.85rem;min-width:0;"><i class="fas '+icon+'" style="color:var(--primary-color);font-size:0.8rem;"></i> <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+hEsc(p.label)+'</span></a>'
                    + (window.__pinCanManage?'<button onclick="deletePin(\\''+p.id+'\\')" title="Unpin" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:0.72rem;flex:none;"><i class="fas fa-times"></i></button>':'')
                    + '</div>';
                }).join('');
              }
              function loadPins(){
                fetch('/api/projects/'+HM_PID+'/pins').then(function(r){return r.json();}).then(function(d){ renderPins(d.pins, d.canManage); }).catch(function(){});
              }
              window.__loadPins = loadPins;

              // One combined request for the whole Home (activities + notifications
              // + members + pins) instead of four separate round-trips.
              fetch('/api/projects/'+HM_PID+'/home').then(function(r){return r.json();}).then(function(d){
                renderActivity(d.activities);
                renderActions(d.notifications);
                renderTeam(d.members || {});
                renderPins(d.pins, d.canManagePins);
                var b = document.getElementById('inbox-tab-badge'); if (b && d.unreadCount){ b.textContent = d.unreadCount; b.style.display = ''; }
              }).catch(function(){ var el=document.getElementById('home-activity'); if(el) el.innerHTML='<div style="color:var(--text-secondary);font-size:0.85rem;">Couldn\\'t load.</div>'; });

              window.deletePin = function(id){
                if (!confirm('Unpin this?')) return;
                fetch('/api/projects/'+HM_PID+'/pins/'+id, { method:'DELETE' }).then(function(){ loadPins(); });
              };
              window.onPinTypeChange = function(){
                var t = document.getElementById('pin-type').value;
                document.getElementById('pin-doc-wrap').style.display = t==='document'?'':'none';
                document.getElementById('pin-link-wrap').style.display = t==='link'?'':'none';
              };
              window.openPinModal = function(){
                document.getElementById('pin-error').style.display='none';
                document.getElementById('pinModal').classList.add('active');
                onPinTypeChange();
                var dSel = document.getElementById('pin-doc'); dSel.innerHTML = '<option value="">Loading…</option>';
                fetch('/projects/'+HM_PID+'/api/files/browser?per_page=200').then(function(r){return r.json();}).then(function(d){
                  var docs = (d&&d.files)||[];
                  dSel.innerHTML = docs.length ? docs.map(function(x){ return '<option value="'+x.id+'">'+hEsc(x.name||'Untitled')+'</option>'; }).join('') : '<option value="">No documents yet</option>';
                }).catch(function(){ dSel.innerHTML='<option value="">Failed to load</option>'; });
              };
              window.submitPin = function(){
                var t = document.getElementById('pin-type').value;
                var err = document.getElementById('pin-error');
                var body = { targetType: t };
                if (t==='document'){ var id=document.getElementById('pin-doc').value; if(!id){ err.textContent='Pick a document.'; err.style.display='block'; return; } body.targetId=id; body.label=document.getElementById('pin-doc').selectedOptions[0].text; }
                else { var url=document.getElementById('pin-url').value.trim(); var lbl=document.getElementById('pin-label').value.trim(); if(!url||!lbl){ err.textContent='Label and URL are required.'; err.style.display='block'; return; } body.url=url; body.label=lbl; }
                fetch('/api/projects/'+HM_PID+'/pins', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) })
                  .then(function(r){ return r.json().then(function(dd){return {ok:r.ok,data:dd};}); })
                  .then(function(res){ if(!res.ok){ err.textContent=(res.data&&res.data.error)||'Failed'; err.style.display='block'; return; } document.getElementById('pinModal').classList.remove('active'); loadPins(); });
              };
            })();
          </script>
        ` : ""}

        ${activeTab === "conversations" ? html`
          <div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.5rem;">
              <h2 style="font-size:1.1rem;font-weight:600;color:var(--text-color);margin:0;">Chats</h2>
              <a href="/chat/project/${project.projectId}" class="btn btn-primary" style="font-size:0.875rem;">
                <i class="fas fa-plus"></i> New Chat
              </a>
            </div>
            ${conversations.length === 0 ? html`
              <div style="text-align:center;padding:3rem;color:var(--text-secondary);border:1px dashed var(--border-color);border-radius:var(--radius-lg);">
                <i class="fas fa-comments" style="font-size:2rem;opacity:0.3;display:block;margin-bottom:0.75rem;"></i>
                <p style="margin:0 0 1rem;">No chats yet.</p>
                <a href="/chat/project/${project.projectId}" class="btn btn-primary">Start a chat</a>
              </div>
            ` : html`
              <div class="lfg-list">
                ${conversations.map((c) => html`
                  <a href="/chat/project/${project.projectId}/conversation/${c.id}" class="lfg-row">
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

        ${activeTab === "documents" ? html`
          <!-- The doc viewer is absolute-positioned for the chat panel; on the
               dashboard it must flow within the tab content, not escape to the
               viewport (which clips it behind the sidebar/header). -->
          <style>
            #filebrowser-viewer { position: static !important; inset: auto !important; min-height: 65vh; }
            #filebrowser-viewer .viewer-content { min-height: 55vh; }
            #viewer-markdown { color: var(--text-color) !important; }
            /* Viewer header buttons (back / title / edit / copy / more) are styled
               for the dark chat panel (#e2e8f0) — invisible on the light dashboard. */
            #filebrowser-viewer .viewer-back,
            #filebrowser-viewer #viewer-title,
            #filebrowser-viewer #viewer-title-text,
            #filebrowser-viewer .viewer-actions button,
            #filebrowser-viewer .viewer-actions button i { color: var(--text-color) !important; }
            #filebrowser-viewer .viewer-header { border-bottom-color: var(--border-color) !important; }
            [data-theme="light"] #filebrowser-viewer .viewer-back:hover,
            [data-theme="light"] #filebrowser-viewer .viewer-actions button:hover { background: rgba(0,0,0,0.06) !important; }
            /* Theme the options / download dropdowns (they use hardcoded dark colors in JS). */
            #viewer-options-dropdown { background: var(--card-bg) !important; border: 1px solid var(--border-color) !important; box-shadow: 0 4px 16px rgba(0,0,0,0.18) !important; }
            #viewer-options-dropdown button { color: var(--text-color) !important; background: transparent !important; }
            #viewer-options-dropdown button:hover { background: rgba(139,92,246,0.12) !important; }
            /* the Download row is a bare wrapper (no box); its nested submenu is the floating menu */
            #viewer-options-dropdown > div { background: transparent !important; border: none !important; box-shadow: none !important; }
            #viewer-options-dropdown > div > div { background: var(--card-bg) !important; border: 1px solid var(--border-color) !important; box-shadow: 0 4px 16px rgba(0,0,0,0.18) !important; }
            /* Subtle divider lines in the rendered doc (default hr looks thick in dark mode). */
            #viewer-markdown hr { border: none !important; border-top: 1px solid var(--border-color) !important; height: 0 !important; background: none !important; margin: 1.75rem 0 !important; }
          </style>
          <div id="filebrowser" class="filebrowser-container" style="position:relative;display:flex;flex-direction:column;">
            <div id="filebrowser-main" style="display:flex;flex-direction:column;">
              <div class="filebrowser-header" style="padding-bottom:1rem;border-bottom:1px solid var(--border-color);margin-bottom:1rem;">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem;flex-wrap:wrap;gap:0.5rem;">
                  <h2 style="color:var(--text-color);margin:0;font-size:1.1rem;font-weight:600;">Documents</h2>
                  <div style="display:flex;gap:0.5rem;align-items:center;">
                    <select id="file-type-filter" class="input" style="padding:0.4rem 0.6rem;font-size:0.8125rem;">
                      <option value="">All Types</option>
                    </select>
                    <button id="refresh-filebrowser" class="btn btn-secondary" style="font-size:0.8125rem;display:flex;align-items:center;gap:0.4rem;">
                      <i class="fas fa-sync-alt"></i> Refresh
                    </button>
                  </div>
                </div>
                <div style="position:relative;">
                  <input type="text" id="file-search" placeholder="Search documents..." class="input" style="width:100%;box-sizing:border-box;padding-left:2.25rem;" />
                  <i class="fas fa-search" style="position:absolute;left:0.85rem;top:50%;transform:translateY(-50%);color:var(--text-secondary);font-size:0.85rem;"></i>
                </div>
              </div>
              <div class="filebrowser-content" style="flex:1;overflow-y:auto;">
                <div id="file-table-header" style="display:none;"></div>
                <div class="loading-state" id="filebrowser-loading" style="text-align:center;padding:3rem;display:none;">
                  <i class="fas fa-spinner fa-spin" style="opacity:0.5;font-size:1.25rem;"></i>
                  <div style="margin-top:0.5rem;color:var(--text-secondary);">Loading documents...</div>
                </div>
                <div class="empty-state" id="filebrowser-empty" style="text-align:center;padding:3rem;color:var(--text-secondary);border:1px dashed var(--border-color);border-radius:var(--radius-lg);">
                  <div class="empty-state-icon"><i class="fas fa-folder-open" style="font-size:2rem;opacity:0.3;"></i></div>
                  <div class="empty-state-text" style="margin-top:0.75rem;">No documents found in this project.</div>
                </div>
                <div id="filebrowser-list"></div>
                <div id="filebrowser-pagination" style="display:none;"></div>
              </div>
            </div>
            <div id="filebrowser-viewer" style="display:none;flex-direction:column;">
              <div class="viewer-header">
                <div class="viewer-title-container">
                  <button id="viewer-back" class="viewer-back"><i class="fas fa-arrow-left"></i></button>
                  <h3 id="viewer-title"></h3>
                </div>
                <div id="viewer-actions" class="viewer-actions"></div>
              </div>
              <div class="viewer-content" style="flex:1;overflow-y:auto;">
                <div id="viewer-markdown" class="prd-content markdown-content" style="padding:1rem 0;color:var(--text-color);"></div>
              </div>
            </div>
          </div>
          <script src="/public/js/marked.min.js"></script>
          <script src="/public/js/markdown-config.js"></script>
          <!-- jsPDF + html2canvas — power "Download → PDF" (renders tables/code faithfully).
               SELF-HOSTED (was cdnjs): a blocked/slow CDN left window.jspdf undefined →
               "PDF generation library not loaded". Same-origin can't be blocked. -->
          <script src="/public/js/jspdf.umd.min.js"></script>
          <script src="/public/js/html2canvas.min.js"></script>
          <script src="/public/js/artifacts-loader.js"></script>
          <script src="/public/js/document-comments.js"></script>
          <script>
            // Reuse the SAME docs module as the chat Docs panel (window.ArtifactsLoader),
            // so reads/edits/renders stay in sync across the dashboard and chat.
            (function () {
              function start() {
                if (window.ArtifactsLoader && typeof window.ArtifactsLoader.loadFileBrowser === "function") {
                  var p = new URLSearchParams(window.location.search);
                  var openId = p.get("doc");
                  var opts = openId ? { openFileId: openId, openFileName: p.get("docName") || "Document" } : {};
                  window.ArtifactsLoader.loadFileBrowser("${project.projectId}", opts);
                } else {
                  setTimeout(start, 100);
                }
              }
              if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
              else start();
            })();
          </script>
        ` : ""}

        ${activeTab === "tickets" ? html`
          <div>
            <div style="display:flex;justify-content:space-between;align-items:center;gap:0.75rem;margin-bottom:1.25rem;flex-wrap:wrap;">
              <h2 style="font-size:1.1rem;font-weight:600;color:var(--text-color);margin:0;">Tickets</h2>
              <button class="btn btn-primary" onclick="openCreateTicket()" style="font-size:0.875rem;"><i class="fas fa-plus"></i> New Ticket</button>
            </div>
            <div style="display:flex;gap:0.5rem;margin-bottom:1rem;flex-wrap:wrap;">
              <input id="tk-search" class="input" placeholder="Search tickets..." style="flex:1;min-width:180px;box-sizing:border-box;" oninput="renderDashTickets()" />
              <select id="tk-status" class="input" style="width:auto;" onchange="renderDashTickets()">
                <option value="">All statuses</option>
                <option value="open">Open</option>
                <option value="in_progress">In Progress</option>
                <option value="review">In Review</option>
                <option value="done">Done</option>
                <option value="failed">Failed</option>
              </select>
              <select id="tk-priority" class="input" style="width:auto;" onchange="renderDashTickets()">
                <option value="">All priorities</option>
                <option value="High">High</option><option value="Medium">Medium</option><option value="Low">Low</option>
              </select>
              <select id="tk-assignee" class="input" style="width:auto;" onchange="renderDashTickets()">
                <option value="">Anyone</option>
              </select>
            </div>
            <div id="dash-tickets-list"><div style="color:var(--text-secondary);padding:1rem 0;">Loading tickets…</div></div>
          </div>

          <div class="modal-overlay" id="createTicketModal" style="position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,0.7);align-items:center;justify-content:center;">
            <div style="background:var(--card-bg);border:1px solid var(--border-color);border-radius:var(--radius-lg);width:100%;max-width:520px;">
              <div style="display:flex;align-items:center;justify-content:space-between;padding:1.25rem 1.5rem;border-bottom:1px solid var(--border-color);">
                <h3 style="margin:0;font-size:1.1rem;font-weight:600;color:var(--text-color);">New Ticket</h3>
                <button type="button" onclick="closeCreateTicket()" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:1.25rem;line-height:1;">&times;</button>
              </div>
              <div style="padding:1.5rem;">
                <div style="margin-bottom:1rem;"><label style="display:block;font-size:0.875rem;font-weight:500;color:var(--text-color);margin-bottom:0.4rem;">Title</label><input id="ct-name" class="input" style="width:100%;box-sizing:border-box;" /></div>
                <div style="margin-bottom:1rem;"><label style="display:block;font-size:0.875rem;font-weight:500;color:var(--text-color);margin-bottom:0.4rem;">Description</label><textarea id="ct-desc" rows="4" class="input" style="width:100%;box-sizing:border-box;resize:vertical;"></textarea></div>
                <div style="display:flex;gap:0.75rem;margin-bottom:1.25rem;">
                  <div style="flex:1;"><label style="display:block;font-size:0.875rem;font-weight:500;color:var(--text-color);margin-bottom:0.4rem;">Priority</label><select id="ct-priority" class="input" style="width:100%;"><option>High</option><option selected>Medium</option><option>Low</option></select></div>
                  <div style="flex:1;"><label style="display:block;font-size:0.875rem;font-weight:500;color:var(--text-color);margin-bottom:0.4rem;">Assignee</label><select id="ct-assignee" class="input" style="width:100%;"><option value="">Unassigned (AI)</option></select></div>
                </div>
                <div id="ct-error" style="display:none;color:#ef4444;font-size:0.8125rem;margin-bottom:0.75rem;"></div>
                <div style="display:flex;gap:0.75rem;justify-content:flex-end;">
                  <button type="button" class="btn btn-secondary" onclick="closeCreateTicket()">Cancel</button>
                  <button type="button" class="btn btn-primary" onclick="submitCreateTicket()">Create Ticket</button>
                </div>
              </div>
            </div>
          </div>

          <script>
            var TK_PID = '${project.projectId}';
            var tkTickets = [], tkMembers = [];
            function tkEsc(s){ return (s||'').replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
            function tkMemberName(id){ if(!id) return 'Unassigned'; var x = tkMembers.find(function(m){ return m.id===id; }); return x ? (x.name||x.email) : 'Someone'; }
            function tkPrettyStatus(s){ return ({open:'Open',in_progress:'In Progress',review:'In Review',done:'Done',failed:'Failed',blocked:'Blocked',archived:'Archived'})[s] || s || 'Open'; }
            function loadDashTickets(){
              Promise.all([
                fetch('/api/projects/'+TK_PID+'/tickets').then(function(r){return r.json();}),
                fetch('/api/projects/'+TK_PID+'/members').then(function(r){return r.json();})
              ]).then(function(res){
                tkTickets = res[0].tickets || [];
                var m = res[1] || {}; tkMembers = [];
                if (m.owner) tkMembers.push({ id:m.owner.id, name:m.owner.name, email:m.owner.email });
                (m.members||[]).forEach(function(x){ tkMembers.push({ id:x.userId, name:x.userName, email:x.userEmail }); });
                var opts = tkMembers.map(function(m){ return '<option value="'+m.id+'">'+tkEsc(m.name||m.email)+'</option>'; }).join('');
                var filt = document.getElementById('tk-assignee'); if (filt) filt.innerHTML = '<option value="">Anyone</option><option value="__none">Unassigned</option>'+opts;
                var ct = document.getElementById('ct-assignee'); if (ct) ct.innerHTML = '<option value="">Unassigned (AI)</option>'+opts;
                renderDashTickets();
              });
            }
            function renderDashTickets(){
              var q = ((document.getElementById('tk-search')||{}).value||'').toLowerCase();
              var st = (document.getElementById('tk-status')||{}).value||'';
              var pr = (document.getElementById('tk-priority')||{}).value||'';
              var asg = (document.getElementById('tk-assignee')||{}).value||'';
              var list = tkTickets.filter(function(t){
                if (q && (t.name||'').toLowerCase().indexOf(q)<0) return false;
                if (st && t.status !== st) return false;
                if (pr && t.priority !== pr) return false;
                if (asg === '__none' && t.assigneeId) return false;
                if (asg && asg !== '__none' && t.assigneeId !== asg) return false;
                return true;
              });
              var el = document.getElementById('dash-tickets-list');
              if (!list.length){ el.innerHTML = '<div style="color:var(--text-secondary);padding:1rem 0;text-align:center;">No tickets match.</div>'; return; }
              el.innerHTML = list.map(function(t){
                var pc = t.priority==='High'?'#ef4444':(t.priority==='Low'?'#6b7280':'#f59e0b');
                return '<div class="dash-ticket-row" data-id="'+t.id+'" style="display:flex;align-items:center;gap:1rem;padding:0.75rem 1rem;border:1px solid var(--border-color);border-radius:var(--radius);background:var(--card-bg);margin-bottom:0.5rem;cursor:pointer;">'
                  + '<span style="font-size:0.7rem;color:var(--text-secondary);font-family:monospace;min-width:52px;">'+tkEsc(t.ticketKey||'')+'</span>'
                  + '<span style="flex:1;font-size:0.9rem;color:var(--text-color);">'+tkEsc(t.name||'')+'</span>'
                  + '<span style="font-size:0.7rem;color:'+pc+';font-weight:600;min-width:52px;">'+tkEsc(t.priority||'')+'</span>'
                  + '<span style="font-size:0.7rem;padding:0.15rem 0.5rem;border-radius:9999px;background:rgba(139,92,246,0.12);color:var(--text-secondary);">'+tkPrettyStatus(t.status)+'</span>'
                  + '<span style="font-size:0.75rem;color:var(--text-secondary);min-width:110px;text-align:right;">'+(t.assigneeId?('&#128100; '+tkEsc(tkMemberName(t.assigneeId))):'Unassigned')+'</span>'
                  + '</div>';
              }).join('');
              el.querySelectorAll('.dash-ticket-row').forEach(function(row){
                row.addEventListener('click', function(){ window.location.href = '/projects/'+TK_PID+'/tickets'; });
              });
            }
            function openCreateTicket(){ document.getElementById('createTicketModal').classList.add('active'); }
            function closeCreateTicket(){ document.getElementById('createTicketModal').classList.remove('active'); }
            function submitCreateTicket(){
              var name = document.getElementById('ct-name').value.trim();
              var desc = document.getElementById('ct-desc').value.trim();
              var priority = document.getElementById('ct-priority').value;
              var assigneeId = document.getElementById('ct-assignee').value || null;
              var err = document.getElementById('ct-error');
              if (!name || !desc){ err.style.display='block'; err.textContent='Title and description are required.'; return; }
              err.style.display='none';
              fetch('/api/projects/'+TK_PID+'/tickets', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name:name, description:desc, priority:priority, assigneeId:assigneeId }) })
                .then(function(r){ return r.json().then(function(d){ return { ok:r.ok, data:d }; }); })
                .then(function(res){ if(!res.ok){ err.style.display='block'; err.textContent=(res.data&&res.data.error)||'Failed to create ticket'; return; } document.getElementById('ct-name').value=''; document.getElementById('ct-desc').value=''; closeCreateTicket(); loadDashTickets(); });
            }
            if ('${activeTab}' === 'tickets') {
              loadDashTickets();
              if (new URLSearchParams(window.location.search).get('create') === '1') {
                requestAnimationFrame(openCreateTicket);
              }
            }
          </script>
        ` : ""}

        ${activeTab === "environment" ? html`
          <style>
            .env-table { width:100%; border-collapse:collapse; }
            .env-table th { padding:0.6rem 1rem; text-align:left; font-size:0.72rem; font-weight:600; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.05em; background:var(--card-bg); border-bottom:1px solid var(--border-color); }
            .env-table td { padding:0.6rem 1rem; font-size:0.85rem; color:var(--text-secondary); border-bottom:1px solid var(--border-color); }
            .env-key { font-family:monospace; color:var(--text-color); }
            .env-badge { font-size:0.65rem; background:var(--danger-color); color:#fff; border-radius:4px; padding:1px 6px; text-transform:uppercase; letter-spacing:0.03em; }
            .env-mini { background:var(--card-bg); border:1px solid var(--border-color); color:var(--text-secondary); border-radius:6px; padding:3px 9px; font-size:0.72rem; cursor:pointer; }
            .env-mini:hover { border-color:var(--text-secondary); color:var(--text-color); }
            .env-empty { text-align:center; padding:3rem; color:var(--text-secondary); border:1px dashed var(--border-color); border-radius:var(--radius-lg); }
            .env-input { background:var(--input-bg,var(--card-bg)); border:1px solid var(--border-color); color:var(--text-color); border-radius:7px; padding:7px 10px; font-size:0.82rem; }
          </style>
          <div>
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;margin-bottom:1rem;flex-wrap:wrap;">
              <div>
                <h2 style="font-size:1.1rem;font-weight:600;color:var(--text-color);margin:0;">Environment Variables</h2>
                <p id="env-count" style="font-size:0.8125rem;color:var(--text-secondary);margin:0.25rem 0 0;">Loading…</p>
              </div>
              <div style="display:flex;align-items:center;gap:0.5rem;">
                <label style="font-size:0.72rem;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.04em;">Database</label>
                <select id="env-db-mode" class="env-input" title="Auto: use your DATABASE_URL if set, else provision. Always new: fresh DB each run. Use my DB: never provision.">
                  <option value="auto">Auto (agent decides)</option>
                  <option value="new">Always provision new</option>
                  <option value="provided">Use my DB</option>
                </select>
              </div>
            </div>
            <div style="display:flex;gap:0.5rem;margin-bottom:1rem;flex-wrap:wrap;align-items:center;">
              <input id="env-new-key" class="env-input" placeholder="KEY" style="width:200px;" />
              <input id="env-new-value" class="env-input" placeholder="value" style="flex:1;min-width:180px;" />
              <input id="env-new-desc" class="env-input" placeholder="description (optional)" style="flex:1;min-width:160px;" />
              <button id="env-add-btn" class="env-mini" style="padding:7px 14px;">＋ Add</button>
              <label class="env-mini" style="padding:7px 14px;cursor:pointer;" title="Bulk-import KEY=VALUE lines from a .env file">⬆ Upload .env<input id="env-file" type="file" accept=".env,.txt,text/plain" style="display:none;" /></label>
            </div>
            <div id="env-list" style="border:1px solid var(--border-color);border-radius:var(--radius-lg);overflow:hidden;"></div>
          </div>
          <script>
            (function(){
              var PID = document.body.getAttribute('data-project-id');
              function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
              function api(path, opts){ return fetch('/api/projects/'+PID+path, opts).then(function(r){ return r.json(); }); }
              function render(vars){
                document.getElementById('env-count').textContent = vars.length + (vars.length===1?' variable':' variables');
                var list = document.getElementById('env-list');
                if(!vars.length){ list.style.border='none'; list.innerHTML = '<div class="env-empty">No variables yet. Add one above, or run a preview — it auto-detects what the app needs.</div>'; return; }
                list.style.border='';
                var rows = '';
                for(var i=0;i<vars.length;i++){
                  var v = vars[i];
                  var val = v.hasValue ? (v.isSecret ? '<em>••••••••</em>' : '<em>set</em>') : ('<em style="color:var(--danger-color)">not set</em>' + (v.isRequired ? ' <span class="env-badge">needed</span>' : ''));
                  rows += '<tr><td class="env-key">'+esc(v.key)+'</td><td>'+val+'</td><td>'+esc(v.description)+'</td>'
                    + '<td style="text-align:right;white-space:nowrap"><button class="env-mini env-set" data-id="'+esc(v.id)+'" data-key="'+esc(v.key)+'">Set value</button> '
                    + '<button class="env-mini env-del" data-id="'+esc(v.id)+'" data-key="'+esc(v.key)+'">Delete</button></td></tr>';
                }
                list.innerHTML = '<table class="env-table"><thead><tr><th>Key</th><th>Value</th><th>Description</th><th></th></tr></thead><tbody>'+rows+'</tbody></table>';
                var sets = list.querySelectorAll('.env-set');
                for(var a=0;a<sets.length;a++){ sets[a].addEventListener('click', function(){ setValue(this.getAttribute('data-id'), this.getAttribute('data-key')); }); }
                var dels = list.querySelectorAll('.env-del');
                for(var b=0;b<dels.length;b++){ dels[b].addEventListener('click', function(){ delVar(this.getAttribute('data-id'), this.getAttribute('data-key')); }); }
              }
              function load(){ api('/env-vars').then(function(d){ render((d&&d.envVars)||[]); }).catch(function(){}); }
              function setValue(id, key){
                var val = prompt('New value for '+key+':');
                if(val===null) return;
                api('/env-vars/'+id, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ value: val }) }).then(load);
              }
              function delVar(id, key){
                if(!confirm('Delete '+key+'?')) return;
                api('/env-vars/'+id, { method:'DELETE' }).then(load);
              }
              document.getElementById('env-add-btn').addEventListener('click', function(){
                var key = (document.getElementById('env-new-key').value||'').trim();
                if(!key){ return; }
                var value = document.getElementById('env-new-value').value||'';
                var desc = document.getElementById('env-new-desc').value||'';
                api('/env-vars', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ key: key, value: value, description: desc }) }).then(function(){
                  document.getElementById('env-new-key').value='';
                  document.getElementById('env-new-value').value='';
                  document.getElementById('env-new-desc').value='';
                  load();
                });
              });
              var fileEl = document.getElementById('env-file');
              if (fileEl) fileEl.addEventListener('change', function(){
                var f = fileEl.files && fileEl.files[0];
                if (!f) return;
                var reader = new FileReader();
                reader.onload = function(){
                  api('/env-vars/bulk', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text: String(reader.result || '') }) }).then(function(d){
                    fileEl.value = '';
                    if (d && d.count != null) { try { document.getElementById('env-count').textContent = d.count + ' imported…'; } catch(e){} }
                    load();
                  }).catch(function(){});
                };
                reader.readAsText(f);
              });
              var dbSel = document.getElementById('env-db-mode');
              dbSel.addEventListener('change', function(){
                api('/preview/build-settings', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ dbMode: dbSel.value }) }).catch(function(){});
              });
              api('/preview/build-settings').then(function(d){ if(d&&d.dbMode) dbSel.value = d.dbMode; }).catch(function(){});
              load();
            })();
          </script>
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
            ${isOwner ? html`
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
            ` : html`
            <div style="font-size:0.8125rem;color:var(--text-secondary);background:var(--card-bg);border:1px solid var(--border-color);border-radius:var(--radius);padding:0.875rem 1rem;margin-bottom:1.5rem;">
              <i class="fas fa-lock" style="margin-right:0.4rem;"></i> You have <strong>${roleLabel}</strong> access. Only the project owner can change project settings, manage the team, or delete the project.
            </div>
            <div style="margin-bottom:1rem;"><div style="font-size:0.8125rem;color:var(--text-secondary);">Project Name</div><div style="color:var(--text-color);">${project.name}</div></div>
            ${project.description ? html`<div style="margin-bottom:1rem;"><div style="font-size:0.8125rem;color:var(--text-secondary);">Description</div><div style="color:var(--text-color);white-space:pre-wrap;">${project.description}</div></div>` : ""}
            ${project.stack ? html`<div style="margin-bottom:1rem;"><div style="font-size:0.8125rem;color:var(--text-secondary);">Tech Stack</div><div style="color:var(--text-color);">${project.stack}</div></div>` : ""}
            `}

            <!-- Team & Guests -->
            <div style="margin-top:2.5rem;padding-top:2rem;border-top:1px solid var(--border-color);">
              <h3 style="font-size:1rem;font-weight:600;color:var(--text-color);margin:0 0 0.5rem;">${isOwner ? "Team & Guests" : "Team"}</h3>
              ${isOwner ? html`
              <p style="font-size:0.8125rem;color:var(--text-secondary);margin:0 0 1.25rem;">Invite people to collaborate on this project.</p>

              <!-- Invite Form -->
              <div style="display:flex;gap:0.5rem;margin-bottom:1.5rem;" id="invite-form">
                <input type="email" id="invite-email" placeholder="Email address" class="input" style="flex:1;box-sizing:border-box;" />
                <select id="invite-role" class="input" style="width:auto;min-width:130px;">
                  <option value="member">Collaborator</option>
                  <option value="viewer">Viewer (read-only)</option>
                </select>
                <button type="button" class="btn btn-primary" onclick="sendInvitation()" style="white-space:nowrap;">
                  <i class="fas fa-paper-plane"></i> Invite
                </button>
              </div>
              <div id="invite-message" style="display:none;font-size:0.8125rem;margin-bottom:1rem;padding:0.5rem 0.75rem;border-radius:var(--radius);"></div>
              ` : html`
              <p style="font-size:0.8125rem;color:var(--text-secondary);margin:0 0 1.25rem;">People with access to this project.</p>
              `}

              <!-- Members List -->
              <div id="members-list" style="margin-bottom:1rem;">
                <div style="font-size:0.8125rem;color:var(--text-secondary);padding:0.5rem 0;">Loading members...</div>
              </div>

              <!-- Pending Invitations (owner only) -->
              ${isOwner ? html`<div id="invitations-list" style="margin-bottom:1rem;"></div>` : ""}

              <!-- Fine-grained Git access sharing (owner only) -->
              ${isOwner ? html`
              <div style="margin-top:1.25rem;padding-top:1.25rem;border-top:1px solid var(--border-color);">
                <label style="display:flex;align-items:flex-start;gap:0.75rem;cursor:pointer;">
                  <input type="checkbox" id="share-git-toggle" onchange="toggleShareGit(this)" style="margin-top:3px;width:16px;height:16px;flex:none;cursor:pointer;" />
                  <span>
                    <span style="display:block;font-size:0.875rem;font-weight:600;color:var(--text-color);">Share my Git access with collaborators</span>
                    <span style="display:block;font-size:0.8125rem;color:var(--text-secondary);margin-top:2px;line-height:1.45;">When on, collaborators' ticket builds and previews use <strong>your</strong> connected GitHub/GitLab — scoped to this project's repo — so they can build, push, and open PRs/MRs without their own repo access. Off (default): each collaborator uses their own connected Git.</span>
                    <span id="share-git-status" style="display:block;font-size:0.75rem;color:var(--text-secondary);margin-top:5px;"></span>
                  </span>
                </label>
              </div>
              ` : ""}

              <!-- Chat visibility across collaborators (owner only) -->
              ${isOwner ? html`
              <div style="margin-top:1.25rem;padding-top:1.25rem;border-top:1px solid var(--border-color);">
                <label style="display:flex;align-items:flex-start;gap:0.75rem;cursor:pointer;">
                  <input type="checkbox" id="share-chat-toggle" onchange="toggleShareChat(this)" style="margin-top:3px;width:16px;height:16px;flex:none;cursor:pointer;" />
                  <span>
                    <span style="display:block;font-size:0.875rem;font-weight:600;color:var(--text-color);">Let collaborators see each other's chats</span>
                    <span style="display:block;font-size:0.8125rem;color:var(--text-secondary);margin-top:2px;line-height:1.45;">When on, every member can open every other member's AI conversations in this project, labelled with who wrote them (read-only — only the author can reply, rename, or delete). Off (default): each person's chat is private to them, including from you.</span>
                    <span id="share-chat-status" style="display:block;font-size:0.75rem;color:var(--text-secondary);margin-top:5px;"></span>
                  </span>
                </label>
              </div>
              ` : ""}
            </div>

            ${(isOwner || role === "admin") ? html`
            <div style="margin-top:2.5rem;padding-top:2rem;border-top:1px solid var(--border-color);">
              <h3 style="font-size:1rem;font-weight:600;color:var(--text-color);margin:0 0 0.35rem;">Export project</h3>
              <p style="margin:0 0 0.75rem;color:var(--text-secondary);font-size:0.85rem;">Download this project (docs, tickets, chats, pins, activity) as a file you can import on another LFG server. Env-var values and build history are not included.</p>
              <a href="/api/projects/${project.projectId}/export" class="btn btn-secondary" style="display:inline-flex;align-items:center;gap:0.5rem;font-size:0.85rem;">
                <i class="fas fa-download"></i> Export to file
              </a>
            </div>
            ` : ""}

            ${isOwner ? html`
            <div style="margin-top:2.5rem;padding-top:2rem;border-top:1px solid var(--border-color);">
              <h3 style="font-size:1rem;font-weight:600;color:var(--danger-color);margin:0 0 0.75rem;">Danger Zone</h3>
              <form method="POST" action="/projects/${project.projectId}/delete"
                onsubmit="return confirm('Delete project &quot;${project.name}&quot;? This cannot be undone.')">
                <button type="submit" class="btn" style="background:rgba(239,68,68,0.1);color:#ef4444;border:1px solid rgba(239,68,68,0.3);">
                  <i class="fas fa-trash"></i> Delete Project
                </button>
              </form>
            </div>
            ` : ""}
          </div>
        ` : ""}
      </div>
    </div>
  </div>

  <!-- Link GitHub Repository Modal -->
  <div class="modal-overlay" id="codebaseModal" style="position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,0.7);align-items:center;justify-content:center;">
    <div style="background:var(--card-bg);border:1px solid var(--border-color);border-radius:var(--radius-lg);width:100%;max-width:520px;position:relative;transform:scale(0.95);transition:transform 0.2s ease;">
      <!-- Header -->
      <div style="display:flex;align-items:center;justify-content:space-between;padding:1.25rem 1.5rem;border-bottom:1px solid var(--border-color);">
        <h3 style="margin:0;font-size:1.1rem;font-weight:600;color:var(--text-color);display:flex;align-items:center;gap:0.5rem;">
          <i class="fas fa-code-branch"></i> Link Repository
        </h3>
        <button type="button" onclick="closeCodebaseModal()" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:1.1rem;padding:0.25rem;">
          <i class="fas fa-times"></i>
        </button>
      </div>
      <!-- Body -->
      <div style="padding:1.5rem;">
        ${!githubConnected && !gitlabConnected ? html`
          <!-- Neither connected: direct the user to connect a provider first -->
          <div style="text-align:center;padding:0.5rem 0 0.25rem;">
            <div style="width:3rem;height:3rem;margin:0 auto 1rem;border-radius:9999px;background:rgba(139,92,246,0.12);display:flex;align-items:center;justify-content:center;">
              <i class="fas fa-code-branch" style="font-size:1.4rem;color:var(--text-color);"></i>
            </div>
            <h4 style="margin:0 0 0.5rem;font-size:1rem;font-weight:600;color:var(--text-color);">Connect a Git provider first</h4>
            <p style="font-size:0.8125rem;color:var(--text-secondary);margin:0 0 1.25rem;line-height:1.5;">
              To link a repository, LFG needs access to your GitHub or GitLab account. You'll be able to link a repo right after connecting.
            </p>
            <div style="display:flex;gap:0.5rem;justify-content:center;flex-wrap:wrap;">
              <a href="/accounts/github-connect?returnTo=${encodeURIComponent(`/projects/${project.projectId}?showConnect=true`)}" class="btn btn-primary" style="display:inline-flex;align-items:center;gap:0.5rem;">
                <i class="fab fa-github"></i> Connect GitHub
              </a>
              <a href="/accounts/gitlab-connect?returnTo=${encodeURIComponent(`/projects/${project.projectId}?showConnect=true`)}" class="btn btn-secondary" style="display:inline-flex;align-items:center;gap:0.5rem;">
                <i class="fab fa-gitlab"></i> Connect GitLab
              </a>
            </div>
            <p style="font-size:0.7rem;color:var(--text-secondary);margin:1rem 0 0;">
              Manage connections anytime in <a href="/settings/integrations" style="color:var(--primary-color);text-decoration:none;">Settings → Integrations</a>.
            </p>
          </div>
        ` : html`
        <form id="codebaseForm" method="POST" action="/projects/${project.projectId}/connect-repo">
          <div style="margin-bottom:1.25rem;">
            <label style="display:block;font-size:0.875rem;font-weight:500;color:var(--text-color);margin-bottom:0.5rem;">Repository URL</label>
            <input type="url" name="repo_url" id="githubUrl" required
              placeholder="https://github.com/... or https://gitlab.com/..."
              value="${project.repoUrl ?? ""}"
              class="input" style="width:100%;box-sizing:border-box;" />
            <p style="font-size:0.75rem;color:var(--text-secondary);margin:0.4rem 0 0;">
              Paste a GitHub or GitLab repository URL you have access to.
              ${!githubConnected ? html` <a href="/accounts/github-connect?returnTo=${encodeURIComponent(`/projects/${project.projectId}?showConnect=true`)}" style="color:var(--primary-color);text-decoration:none;">Connect GitHub</a>` : ""}
              ${!gitlabConnected ? html` <a href="/accounts/gitlab-connect?returnTo=${encodeURIComponent(`/projects/${project.projectId}?showConnect=true`)}" style="color:var(--primary-color);text-decoration:none;">Connect GitLab</a>` : ""}
            </p>
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
              <li>Your repository will be cloned into each ticket's workspace</li>
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
        `}
      </div>
    </div>
  </div>

  <script src="/public/js/sidebar.js"></script>
  <script>requestAnimationFrame(()=>requestAnimationFrame(()=>document.documentElement.classList.remove('sidebar-minimized-preload')));</script>
  <script>
    // Codebase modal open/close. The shared .modal-overlay class hides via
    // visibility/opacity and reveals with the .active class — toggling display
    // alone leaves it invisible.
    function showCodebaseModal() {
      var modal = document.getElementById('codebaseModal');
      modal.classList.add('active');
      setTimeout(function() { modal.querySelector('div > div').style.transform = 'scale(1)'; }, 10);
    }
    function closeCodebaseModal() {
      var modal = document.getElementById('codebaseModal');
      modal.querySelector('div > div').style.transform = 'scale(0.95)';
      setTimeout(function() { modal.classList.remove('active'); }, 150);
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
    var canManageTeam = ${isOwner ? "true" : "false"};
    // Map stored role → human label (an invited "member" is a Collaborator).
    function roleLabelFor(r) {
      return ({ owner: 'Owner', admin: 'Admin', member: 'Collaborator', viewer: 'Viewer', guest: 'Guest' })[r] || r;
    }

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
          var canShareLlm = !!data.canShareLlm;
          (data.members || []).forEach(function(m) {
            var roleColor = m.role === 'admin' ? '#3b82f6' : m.role === 'member' ? '#22c55e' : '#6b7280';
            // Owner-only per-member LLM sharing controls (rendered as a sub-row).
            var llmRow = canShareLlm ? (
              '<div style="display:flex;gap:1.25rem;flex-wrap:wrap;padding:0.15rem 0 0.6rem 2.75rem;border-bottom:1px solid var(--border-color);">'
              + '<label style="display:flex;align-items:center;gap:0.4rem;font-size:0.75rem;color:var(--text-secondary);cursor:pointer;" title="Let this collaborator use YOUR LLM API keys for the analyst chat, codebase reads, and API-key builds.">'
              + '<input type="checkbox" ' + (m.canUseOwnerLlmKey ? 'checked' : '') + ' onchange="setMemberLlm(\\'' + m.id + '\\',\\'canUseOwnerLlmKey\\',this.checked,this)" style="cursor:pointer;"> Use my API keys</label>'
              + '<label style="display:flex;align-items:center;gap:0.4rem;font-size:0.75rem;color:var(--text-secondary);cursor:pointer;" title="Let this collaborator use YOUR Claude/ChatGPT subscription for ticket builds (coding agent).">'
              + '<input type="checkbox" ' + (m.canUseOwnerLlmSubscription ? 'checked' : '') + ' onchange="setMemberLlm(\\'' + m.id + '\\',\\'canUseOwnerLlmSubscription\\',this.checked,this)" style="cursor:pointer;"> Use my subscription</label>'
              + '</div>'
            ) : '';
            var rowBorder = llmRow ? '' : 'border-bottom:1px solid var(--border-color);';
            items += '<div style="display:flex;align-items:center;justify-content:space-between;padding:0.625rem 0;' + rowBorder + '">'
              + '<div style="display:flex;align-items:center;gap:0.75rem;">'
              + '<div style="width:32px;height:32px;border-radius:50%;background:var(--card-bg);border:1px solid var(--border-color);display:flex;align-items:center;justify-content:center;font-size:0.8rem;font-weight:600;color:var(--text-color);">'
              + (m.userName?.[0] || '?').toUpperCase() + '</div>'
              + '<div><div style="font-size:0.875rem;font-weight:500;color:var(--text-color);">' + m.userName + '</div>'
              + '<div style="font-size:0.75rem;color:var(--text-secondary);">' + (m.userEmail || '') + '</div></div></div>'
              + '<div style="display:flex;align-items:center;gap:0.5rem;">'
              + '<span style="font-size:0.7rem;padding:0.15rem 0.5rem;border-radius:10px;background:rgba(' + (m.role === 'admin' ? '59,130,246' : m.role === 'member' ? '34,197,94' : '107,114,128') + ',0.1);color:' + roleColor + ';font-weight:600;text-transform:uppercase;">' + roleLabelFor(m.role) + '</span>'
              + (canManageTeam ? '<button onclick="removeMember(\\'' + m.id + '\\')" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:0.8rem;padding:0.25rem;" title="Remove"><i class="fas fa-times"></i></button>' : '')
              + '</div></div>' + llmRow;
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
              + '<div style="font-size:0.8125rem;color:var(--text-color);">' + inv.email + ' <span style="color:var(--text-secondary);">(' + roleLabelFor(inv.role) + ')</span></div>'
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
            document.getElementById('invite-email').value = '';
            loadInvitations();
            var link = res.data.acceptUrl;
            if (link) {
              // Clean card: status line + the link in a read-only field + Copy.
              // Built with DOM APIs (no inline onclick) to stay XSS-safe.
              msg.textContent = '';
              msg.style.padding = '0.75rem 0.875rem';
              var head = document.createElement('div');
              head.style.cssText = 'font-weight:600;margin-bottom:0.5rem;';
              head.textContent = res.data.emailSent
                ? '✅ Invitation emailed to ' + email
                : '📋 Invited ' + email + ' — email not delivered, share this link:';
              if (!res.data.emailSent) { msg.style.background = 'rgba(234,179,8,0.1)'; msg.style.color = '#b45309'; }
              var row = document.createElement('div');
              row.style.cssText = 'display:flex;gap:0.5rem;align-items:center;';
              var input = document.createElement('input');
              input.type = 'text'; input.readOnly = true; input.value = link;
              input.className = 'input';
              input.style.cssText = 'flex:1;font-size:0.75rem;padding:0.35rem 0.5rem;box-sizing:border-box;';
              input.addEventListener('focus', function () { input.select(); });
              var copyBtn = document.createElement('button');
              copyBtn.type = 'button'; copyBtn.className = 'btn btn-secondary';
              copyBtn.textContent = 'Copy';
              copyBtn.style.cssText = 'font-size:0.75rem;padding:0.35rem 0.75rem;white-space:nowrap;';
              copyBtn.addEventListener('click', function () {
                navigator.clipboard.writeText(link);
                copyBtn.textContent = 'Copied ✓';
                setTimeout(function () { copyBtn.textContent = 'Copy'; }, 2000);
              });
              row.appendChild(input); row.appendChild(copyBtn);
              msg.appendChild(head); msg.appendChild(row);
              return; // keep it visible (no auto-hide) so they can copy
            }
            msg.textContent = res.data.emailSent
              ? 'Invitation emailed to ' + email
              : 'Invited ' + email + ' (email not delivered).';
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

    // Owner grants/revokes a collaborator's use of the owner's LLM credentials.
    function setMemberLlm(memberId, field, value, el) {
      var body = {}; body[field] = value;
      if (el) el.disabled = true;
      fetch('/api/projects/' + projectId + '/members/' + memberId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (el) el.disabled = false;
          if (d && d.error) { if (el) el.checked = !value; alert(d.error); }
        })
        .catch(function() { if (el) { el.disabled = false; el.checked = !value; } });
    }

    function revokeInvitation(invId) {
      fetch('/api/projects/' + projectId + '/invitations/' + invId, { method: 'DELETE' })
        .then(function() { loadInvitations(); });
    }

    // Fine-grained Git access sharing (owner-only toggle).
    function setShareGitStatus(on) {
      var s = document.getElementById("share-git-status");
      if (!s) return;
      s.style.color = "var(--text-secondary)";
      s.textContent = on ? "On — collaborators build/preview this project with your Git." : "Off — collaborators use their own connected Git.";
    }
    function loadShareGit() {
      var cb = document.getElementById("share-git-toggle");
      if (!cb) return;
      fetch("/api/projects/" + projectId + "/preview/build-settings")
        .then(function(r){ return r.json(); })
        .then(function(d){ if (!d) return; cb.checked = !!d.shareGitAccess; setShareGitStatus(cb.checked); })
        .catch(function(){});
    }
    function toggleShareGit(el) {
      el.disabled = true;
      fetch("/api/projects/" + projectId + "/preview/build-settings", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ shareGitAccess: el.checked }) })
        .then(function(r){ return r.json(); })
        .then(function(d){
          el.disabled = false;
          if (d && d.error) { el.checked = !el.checked; var s = document.getElementById("share-git-status"); if (s) { s.style.color = "#dc2626"; s.textContent = d.error; } return; }
          setShareGitStatus(el.checked);
        })
        .catch(function(){ el.disabled = false; el.checked = !el.checked; });
    }

    // Chat visibility across collaborators (owner-only toggle).
    function setShareChatStatus(on) {
      var s = document.getElementById("share-chat-status");
      if (!s) return;
      s.style.color = "var(--text-secondary)";
      s.textContent = on ? "On — members can read each other's chats in this project." : "Off — each member's chat is private to them.";
    }
    function loadShareChat() {
      var cb = document.getElementById("share-chat-toggle");
      if (!cb) return;
      fetch("/api/projects/" + projectId + "/preview/build-settings")
        .then(function(r){ return r.json(); })
        .then(function(d){ if (!d) return; cb.checked = !!d.shareChatHistory; setShareChatStatus(cb.checked); })
        .catch(function(){});
    }
    function toggleShareChat(el) {
      el.disabled = true;
      fetch("/api/projects/" + projectId + "/preview/build-settings", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ shareChatHistory: el.checked }) })
        .then(function(r){ return r.json(); })
        .then(function(d){
          el.disabled = false;
          if (d && d.error) { el.checked = !el.checked; var s = document.getElementById("share-chat-status"); if (s) { s.style.color = "#dc2626"; s.textContent = d.error; } return; }
          setShareChatStatus(el.checked);
        })
        .catch(function(){ el.disabled = false; el.checked = !el.checked; });
    }

    // Load on settings tab
    if ('${activeTab}' === 'settings') {
      loadMembers();
      if (canManageTeam) { loadInvitations(); loadShareGit(); loadShareChat(); }
    }
  </script>

</body>
</html>`;

}
