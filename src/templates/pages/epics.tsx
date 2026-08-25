import { html } from "hono/html";

/**
 * EPICS — one page that answers "what is this feature, and what came out of it?".
 *
 * An epic already owns its docs, its tickets, its branch and the chat it was born
 * from, but until now that was only visible as a grouping inside other screens. This
 * page turns the epic into the thing you look AT: for each one, the delivery unit's
 * whole trail — tickets built, documents written, branches cut, conversations had —
 * on a single card, so opening an epic tells you everything without hunting.
 *
 * Server-rendered from four queries (epics, tickets, docs, conversations) grouped in
 * memory; no client fetching, so the page is complete on first paint.
 */

interface EpicRow {
  id: string;
  epicKey: string | null;
  name: string;
  goal: string | null;
  status: string;
  branch: string | null;
  baseBranch: string;
  prUrl: string | null;
  previewUrl: string | null;
  conversationId: string | null;
  mergedAt?: Date | string | null;
  createdAt?: Date | string | null;
}

interface EpicTicket {
  id: string;
  epicId: string | null;
  ticketKey: string | null;
  name: string;
  status: string;
  priority: string;
  githubBranch: string | null;
  conversationId: string | null;
  lastExecutionAt?: Date | string | null;
}

interface EpicDoc {
  id: string;
  epicId: string;
  name: string;
  fileType: string;
  /** true when the doc is OWNED by the epic (a draft), false when merely linked. */
  owned: boolean;
}

interface EpicConversation {
  id: string;
  title: string | null;
}

interface Props {
  project: { id: string; projectId: string; name: string; icon?: string | null };
  user: { name: string; email?: string };
  epics: EpicRow[];
  tickets: EpicTicket[];
  docs: EpicDoc[];
  conversations: EpicConversation[];
}

const EPIC_STATUS_COLOR: Record<string, string> = {
  draft: "#94a3b8",
  building: "#3b82f6",
  in_review: "#a78bfa",
  approved: "#10b981",
  merged: "#22c55e",
  rejected: "#ef4444",
};

const TICKET_STATUS_COLOR: Record<string, string> = {
  open: "#94a3b8",
  in_progress: "#f59e0b",
  review: "#a78bfa",
  done: "#10b981",
  failed: "#ef4444",
  blocked: "#ef4444",
};

export function EpicsPage({ project, user, epics, tickets, docs, conversations }: Props) {
  const avatarLetter = (user.name || "U").charAt(0).toUpperCase();
  const convById = new Map(conversations.map((c) => [c.id, c]));

  // Group once, in memory — cheaper and simpler than a query per epic.
  const ticketsByEpic = new Map<string, EpicTicket[]>();
  for (const t of tickets) {
    if (!t.epicId) continue;
    (ticketsByEpic.get(t.epicId) ?? ticketsByEpic.set(t.epicId, []).get(t.epicId)!).push(t);
  }
  const docsByEpic = new Map<string, EpicDoc[]>();
  for (const d of docs) {
    (docsByEpic.get(d.epicId) ?? docsByEpic.set(d.epicId, []).get(d.epicId)!).push(d);
  }

  const fmt = (d?: Date | string | null) => {
    if (!d) return "";
    const dt = new Date(d);
    return isNaN(dt.getTime()) ? "" : dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };

  const pill = (text: string, color: string) => html`
    <span style="font-size:0.66rem;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;padding:3px 8px;border-radius:5px;background:${color}22;color:${color};white-space:nowrap;">${text}</span>
  `;

  const sectionTitle = (label: string, count: number) => html`
    <div style="display:flex;align-items:center;gap:8px;margin:0 0 8px;">
      <span style="font-size:0.68rem;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--text-secondary);">${label}</span>
      <span style="font-size:0.68rem;color:var(--text-secondary);opacity:0.6;">${count}</span>
    </div>
  `;

  const emptyNote = (text: string) => html`
    <div style="font-size:0.78rem;color:var(--text-secondary);opacity:0.5;padding:2px 0 4px;">${text}</div>
  `;

  return html`<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/x-icon" href="/public/images/favicon.ico" />
  <title>${project.name} Epics — LFG</title>
  <script>(function(){if(localStorage.getItem('sidebarMinimized')==='true'){document.documentElement.classList.add('sidebar-minimized-preload');}})()</script>
  <link rel="stylesheet" href="/public/css/theme-variables.css" />
  <link rel="stylesheet" href="/public/css/common.css" />
  <link rel="stylesheet" href="/public/css/sidebar.css" />
  <link rel="stylesheet" href="/public/css/tickets.css" />
  <link rel="stylesheet" href="/public/css/polish.css" />
  <link rel="stylesheet" href="/public/css/light/light-mode.css" />
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css" />
  <script src="/public/js/theme-switcher.js"></script>
  <style>
    .epics-page { height: 100vh; overflow: hidden; display: flex; flex-direction: column; }
    .epics-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 1.25rem 1.5rem 3rem; }
    .epic-card {
      border: 1px solid var(--border-color);
      border-radius: 12px;
      background: var(--card-bg, var(--background-surface));
      margin-bottom: 1rem;
      overflow: hidden;
    }
    .epic-head { padding: 1rem 1.1rem; display: flex; flex-direction: column; gap: 0.5rem; }
    .epic-body { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1.25rem; padding: 0 1.1rem 1.1rem; }
    .epic-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 0.45rem 0.9rem; font-size: 0.75rem; color: var(--text-secondary); }
    .epic-row {
      display: flex; align-items: center; gap: 0.5rem; padding: 5px 0;
      font-size: 0.8rem; color: var(--text-color); text-decoration: none;
      border-bottom: 1px solid color-mix(in srgb, var(--border-color) 45%, transparent);
    }
    .epic-row:last-child { border-bottom: none; }
    .epic-row:hover { color: #a78bfa; }
    .epic-key { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.7rem; color: var(--text-secondary); flex: none; }
    .epic-branch {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.68rem;
      background: color-mix(in srgb, var(--border-color) 45%, transparent);
      padding: 2px 7px; border-radius: 5px; color: var(--text-secondary);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%;
    }
    .epic-truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .epic-btn {
      padding: 5px 12px; border-radius: 7px; font-size: 0.76rem; font-weight: 600; cursor: pointer;
      border: 1px solid var(--border-color); background: transparent; color: var(--text-color); white-space: nowrap;
    }
    .epic-btn:disabled { opacity: 0.5; cursor: default; }
    .epic-btn-go { background: #7c3aed; border-color: #7c3aed; color: #fff; }
    .epic-btn-no { color: #f87171; }
  </style>
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
        <a href="/projects/${project.projectId}" class="nav-link">
          <i class="fas fa-tachometer-alt"></i><span class="nav-text">Dashboard</span>
        </a>
        <a href="/chat/project/${project.projectId}" class="nav-link">
          <i class="fas fa-comments"></i><span class="nav-text">Chat</span>
        </a>
        <a href="/projects/${project.projectId}/epics" class="nav-link active">
          <i class="fas fa-layer-group"></i><span class="nav-text">Epics</span>
        </a>
        <a href="/projects/${project.projectId}/tickets" class="nav-link">
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

  <!-- Main epics page — INSIDE .app-container, which is the flex row that offsets it
       past the sidebar. Outside it, the page sat under the rail with its left edge
       clipped and the sidebar's bottom block stranded at the top of the content. -->
  <div class="epics-page">
    <div style="padding:1.1rem 1.5rem 0;display:flex;align-items:baseline;gap:0.75rem;flex-wrap:wrap;">
      <h1 style="margin:0;font-size:1.15rem;font-weight:600;color:var(--text-color);">Epics</h1>
      <span style="font-size:0.8rem;color:var(--text-secondary);">
        ${epics.length === 0 ? "No epics yet" : `${epics.length} delivery ${epics.length === 1 ? "unit" : "units"}`}
      </span>
    </div>

    <div class="epics-scroll">
      ${epics.length === 0 ? html`
        <div style="max-width:520px;margin:3rem auto;text-align:center;color:var(--text-secondary);">
          <i class="fas fa-layer-group" style="font-size:1.8rem;opacity:0.25;"></i>
          <p style="margin:0.9rem 0 0.3rem;font-size:0.95rem;color:var(--text-color);">No epics yet</p>
          <p style="margin:0;font-size:0.82rem;line-height:1.6;">
            An epic groups a feature's docs, tickets and branch into one reviewable unit.
            Ask in chat to group work into an epic, or pick "Move to epic" on a ticket.
          </p>
        </div>
      ` : epics.map((e) => {
        const ets = ticketsByEpic.get(e.id) ?? [];
        const eds = docsByEpic.get(e.id) ?? [];
        // The origin chat plus every distinct chat a ticket in this epic was built from.
        const convIds: string[] = [];
        if (e.conversationId) convIds.push(e.conversationId);
        for (const t of ets) if (t.conversationId && !convIds.includes(t.conversationId)) convIds.push(t.conversationId);
        const branches = ets.map((t) => t.githubBranch).filter(Boolean) as string[];
        const color = EPIC_STATUS_COLOR[e.status] ?? "#94a3b8";
        return html`
          <div class="epic-card">
            <div class="epic-head">
              <div style="display:flex;align-items:center;gap:0.6rem;flex-wrap:wrap;">
                ${e.epicKey ? html`<span class="epic-key">${e.epicKey}</span>` : ""}
                <span style="font-size:0.98rem;font-weight:600;color:var(--text-color);">${e.name}</span>
                ${pill(e.status.replace("_", " "), color)}
                <span style="flex:1;"></span>
                <!-- The approval boundary, as actions. An epic merges to main only when
                     it's been accepted, so Merge only appears once it's approved. -->
                ${e.status === "in_review" ? html`
                  <button class="epic-btn epic-btn-go" data-epic="${e.id}" data-act="approve">Approve</button>
                  <button class="epic-btn epic-btn-no" data-epic="${e.id}" data-act="reject">Reject</button>
                ` : ""}
                ${e.status === "approved" ? html`
                  <button class="epic-btn epic-btn-go" data-epic="${e.id}" data-act="merge">Merge to main</button>
                ` : ""}
              </div>
              ${e.goal ? html`<div style="font-size:0.83rem;color:var(--text-secondary);line-height:1.5;">${e.goal}</div>` : ""}
              <div class="epic-meta">
                ${e.branch ? html`
                  <span title="This epic's integration branch, cut from ${e.baseBranch}">
                    <i class="fas fa-code-branch" style="opacity:0.5;margin-right:5px;"></i>
                    <span class="epic-branch">${e.branch}</span>
                    <span style="opacity:0.5;"> ← ${e.baseBranch}</span>
                  </span>
                ` : html`<span style="opacity:0.6;">No branch cut yet</span>`}
                ${e.previewUrl ? html`<a href="${e.previewUrl}" target="_blank" rel="noopener" style="color:#a78bfa;text-decoration:none;"><i class="fas fa-play" style="margin-right:5px;"></i>Preview</a>` : ""}
                ${e.prUrl ? html`<a href="${e.prUrl}" target="_blank" rel="noopener" style="color:#a78bfa;text-decoration:none;"><i class="fas fa-code-pull-request" style="margin-right:5px;"></i>Pull request</a>` : ""}
                ${e.mergedAt ? html`<span style="color:#22c55e;">Merged ${fmt(e.mergedAt)}</span>` : ""}
                <span style="opacity:0.55;">${ets.length} ${ets.length === 1 ? "ticket" : "tickets"} · ${eds.length} ${eds.length === 1 ? "doc" : "docs"} · ${convIds.length} ${convIds.length === 1 ? "chat" : "chats"}</span>
              </div>
            </div>

            <div class="epic-body">
              <div>
                ${sectionTitle("Tickets built", ets.length)}
                ${ets.length === 0 ? emptyNote("No tickets in this epic yet.") : ets.map((t) => html`
                  <a class="epic-row" href="/projects/${project.projectId}/tickets?ticket=${t.id}" title="${t.name}">
                    ${t.ticketKey ? html`<span class="epic-key">${t.ticketKey}</span>` : ""}
                    <span class="epic-truncate" style="flex:1;min-width:0;">${t.name}</span>
                    <span style="font-size:0.68rem;color:${TICKET_STATUS_COLOR[t.status] ?? "#94a3b8"};flex:none;">${t.status.replace("_", " ")}</span>
                  </a>
                `)}
              </div>

              <div>
                ${sectionTitle("Documents", eds.length)}
                ${eds.length === 0 ? emptyNote("No documents linked.") : eds.map((d) => html`
                  <div class="epic-row" title="${d.owned ? "Draft owned by this epic — folds into the master doc on approval" : `Linked ${d.fileType}`}">
                    <i class="fas fa-file-lines" style="opacity:0.45;font-size:0.75rem;flex:none;"></i>
                    <span class="epic-truncate" style="flex:1;min-width:0;">${d.name}</span>
                    <span style="font-size:0.66rem;color:var(--text-secondary);opacity:0.7;flex:none;">${d.owned ? "draft" : d.fileType}</span>
                  </div>
                `)}
              </div>

              <div>
                ${sectionTitle("Branches", branches.length + (e.branch ? 1 : 0))}
                ${e.branch ? html`
                  <div class="epic-row" title="The epic's integration branch">
                    <i class="fas fa-code-branch" style="opacity:0.45;font-size:0.75rem;flex:none;"></i>
                    <span class="epic-branch" style="flex:1;min-width:0;">${e.branch}</span>
                    <span style="font-size:0.66rem;color:var(--text-secondary);opacity:0.7;flex:none;">epic</span>
                  </div>
                ` : ""}
                ${branches.length === 0 && !e.branch ? emptyNote("No branches cut yet.") : branches.map((b) => html`
                  <div class="epic-row" title="${b}">
                    <i class="fas fa-code-branch" style="opacity:0.3;font-size:0.75rem;flex:none;"></i>
                    <span class="epic-branch" style="flex:1;min-width:0;">${b}</span>
                  </div>
                `)}
              </div>

              <div>
                ${sectionTitle("Conversations", convIds.length)}
                ${convIds.length === 0 ? emptyNote("No linked chats.") : convIds.map((cid, i) => html`
                  <a class="epic-row" href="/chat/project/${project.projectId}/conversation/${cid}" title="Open this chat">
                    <i class="fas fa-comments" style="opacity:0.45;font-size:0.75rem;flex:none;"></i>
                    <span class="epic-truncate" style="flex:1;min-width:0;">${convById.get(cid)?.title || "Untitled chat"}</span>
                    ${i === 0 && e.conversationId === cid ? html`<span style="font-size:0.66rem;color:var(--text-secondary);opacity:0.7;flex:none;">origin</span>` : ""}
                  </a>
                `)}
              </div>
            </div>
          </div>
        `;
      })}
    </div>
  </div>
  </div>

<script src="/public/js/sidebar.js"></script>
<script>
  // Approve / reject / merge. Delegated so the buttons stay declarative in the markup.
  // A merge the system refuses comes back 409 with the blocking reason (unbuilt tickets,
  // an unmerged parent epic) — show that reason rather than a generic failure.
  document.addEventListener('click', function (ev) {
    var b = ev.target.closest ? ev.target.closest('[data-act]') : null;
    if (!b) return;
    var id = b.getAttribute('data-epic');
    var act = b.getAttribute('data-act');
    var ask = act === 'merge' ? 'Merge this epic into main?'
      : act === 'approve' ? 'Approve this epic? It can then be merged to main.'
      : 'Reject this epic? Its branch is abandoned and its draft docs are discarded.';
    if (!window.confirm(ask)) return;
    var all = document.querySelectorAll('[data-epic="' + id + '"]');
    for (var i = 0; i < all.length; i++) all[i].disabled = true;
    fetch('/api/epics/' + id + '/' + act, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; });
    }).then(function (res) {
      if (res.ok) { window.location.reload(); return; }
      window.alert(res.j && res.j.error ? res.j.error : 'That did not go through.');
      for (var i = 0; i < all.length; i++) all[i].disabled = false;
    }).catch(function () {
      window.alert('Request failed.');
      for (var i = 0; i < all.length; i++) all[i].disabled = false;
    });
  });

  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.documentElement.classList.remove('sidebar-minimized-preload');
  }));
</script>
</body>
</html>`;
}
