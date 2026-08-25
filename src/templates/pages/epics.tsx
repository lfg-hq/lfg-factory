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
    /* .sidebar is position:fixed (sidebar.css), so it's OUT OF FLOW — being a flex
       sibling of it offsets this page by nothing, and the content renders underneath the
       rail with its left edge clipped. Every full-page view compensates with an explicit
       margin; .tickets-page does exactly this. The preload variant matches the class the
       inline <head> script sets, so a minimized rail doesn't flash a 260px indent. */
    .epics-page {
      flex: 1; height: 100vh; overflow: hidden; display: flex; flex-direction: column;
      margin-left: 260px;
    }
    .app-container.sidebar-minimized .epics-page { margin-left: 60px; }
    .sidebar-minimized-preload .epics-page,
    .sidebar-minimized-init .epics-page { margin-left: 60px !important; transition: none !important; }
    .epics-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 0.5rem 1.5rem 3rem; }

    /* ── The list ─────────────────────────────────────────────────────────── */
    .epic-item { border-bottom: 1px solid var(--border-color); }
    .epic-summary {
      width: 100%; display: flex; align-items: center; gap: 0.85rem;
      padding: 0.9rem 0.25rem; background: none; border: none; cursor: pointer;
      text-align: left; color: var(--text-color); font-size: 0.9rem;
    }
    .epic-summary:hover { background: color-mix(in srgb, var(--border-color) 22%, transparent); }
    .epic-caret { font-size: 0.7rem; color: var(--text-secondary); transition: transform .15s; flex: none; width: 12px; }
    .epic-item.open .epic-caret { transform: rotate(90deg); }
    .epic-ident { display: flex; align-items: baseline; gap: 0.55rem; flex: 1; min-width: 0; }
    .epic-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .epic-key { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.72rem; color: var(--text-secondary); flex: none; }
    .epic-pill {
      flex: none; padding: 0.2rem 0.55rem; border-radius: 5px; border: 1px solid;
      font-size: 0.65rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
    }
    .epic-counts { flex: none; display: flex; gap: 0.9rem; font-size: 0.75rem; color: var(--text-secondary); }
    .epic-dim { color: var(--text-secondary); font-weight: 400; }
    .epic-goal {
      padding: 0 0.25rem 0.85rem 2.1rem; margin-top: -0.55rem;
      font-size: 0.82rem; line-height: 1.5; color: var(--text-secondary); max-width: 80ch;
    }

    /* ── Expanded detail ──────────────────────────────────────────────────── */
    .epic-detail { padding: 0 0.25rem 1.2rem 2.1rem; }
    .epic-detail-head {
      display: flex; align-items: center; gap: 0.9rem; flex-wrap: wrap;
      padding: 0.5rem 0 0.9rem; font-size: 0.78rem; color: var(--text-secondary);
    }
    .epic-branch-line { display: inline-flex; align-items: center; gap: 0.45rem; min-width: 0; }
    .epic-branch {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.7rem;
      background: color-mix(in srgb, var(--border-color) 45%, transparent);
      padding: 2px 7px; border-radius: 5px; color: var(--text-secondary);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 340px;
    }
    .epic-link { color: #a78bfa; text-decoration: none; }
    .epic-merged { color: #22c55e; }
    .epic-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1.4rem; }
    .epic-cols h4 {
      margin: 0 0 0.5rem; font-size: 0.68rem; font-weight: 700; letter-spacing: 0.06em;
      text-transform: uppercase; color: var(--text-secondary);
    }
    .epic-row {
      display: flex; align-items: center; gap: 0.5rem; width: 100%;
      padding: 0.35rem 0; font-size: 0.8rem; text-align: left;
      color: var(--text-color); text-decoration: none;
      background: none; border: none; border-bottom: 1px solid color-mix(in srgb, var(--border-color) 40%, transparent);
      cursor: pointer;
    }
    .epic-row:last-child { border-bottom: none; }
    button.epic-row:hover, a.epic-row:hover { color: #a78bfa; }
    .epic-row-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .epic-btn {
      padding: 5px 12px; border-radius: 7px; font-size: 0.76rem; font-weight: 600; cursor: pointer;
      border: 1px solid var(--border-color); background: transparent; color: var(--text-color); white-space: nowrap;
    }
    .epic-btn:disabled { opacity: 0.5; cursor: default; }
    .epic-btn-go { background: #7c3aed; border-color: #7c3aed; color: #fff; }
    .epic-btn-no { color: #f87171; }

    .epics-empty { max-width: 520px; margin: 3rem auto; text-align: center; color: var(--text-secondary); }
    .epics-empty i { font-size: 1.8rem; opacity: 0.25; }
    .epics-empty-title { margin: 0.9rem 0 0.3rem; font-size: 0.95rem; color: var(--text-color); }
    .epics-empty p { font-size: 0.82rem; line-height: 1.6; margin: 0; }

    /* ── Detail drawer ────────────────────────────────────────────────────── */
    .epic-drawer {
      position: fixed; top: 0; right: 0; bottom: 0; width: min(760px, 82vw); z-index: 1200;
      background: var(--card-bg, var(--background-surface)); border-left: 1px solid var(--border-color);
      box-shadow: -18px 0 50px rgba(0,0,0,.35); display: flex; flex-direction: column;
    }
    .epic-drawer-scrim { position: fixed; inset: 0; z-index: 1150; background: rgba(0,0,0,.35); }
    .epic-drawer-head {
      display: flex; align-items: center; justify-content: space-between; gap: 1rem;
      padding: 0.85rem 1.1rem; border-bottom: 1px solid var(--border-color);
      font-weight: 600; color: var(--text-color); font-size: 0.9rem;
    }
    .epic-drawer-x { background: none; border: none; color: var(--text-secondary); cursor: pointer; font-size: 1rem; }
    .epic-drawer-body { flex: 1; min-height: 0; overflow: auto; }
    .epic-drawer-body iframe { width: 100%; height: 100%; border: 0; display: block; }
    .epic-doc { padding: 1.1rem 1.3rem; font-size: 0.86rem; line-height: 1.65; color: var(--text-color); }
    .epic-doc pre { white-space: pre-wrap; word-break: break-word; font-family: inherit; margin: 0; }
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
        <div class="epics-empty">
          <i class="fas fa-layer-group"></i>
          <p class="epics-empty-title">No epics yet</p>
          <p>An epic groups a feature's docs, tickets and branch into one reviewable unit.
             Ask in chat to group work into an epic, or pick "Move to epic" on a ticket.</p>
        </div>
      ` : epics.map((e) => {
        const ets = ticketsByEpic.get(e.id) ?? [];
        const eds = docsByEpic.get(e.id) ?? [];
        const convIds: string[] = [];
        if (e.conversationId) convIds.push(e.conversationId);
        for (const t of ets) if (t.conversationId && !convIds.includes(t.conversationId)) convIds.push(t.conversationId);
        const branches = ets.map((t) => t.githubBranch).filter(Boolean) as string[];
        const color = EPIC_STATUS_COLOR[e.status] ?? "#94a3b8";
        const done = ets.filter((t) => t.status === "done" || t.status === "review").length;
        return html`
          <div class="epic-item" data-epic-row="${e.id}">
            <!-- The SUMMARY row is the whole list: identity, one line of intent, and the
                 counts. Detail stays folded away until you ask for it — four columns of
                 everything for every epic is not a list, it's a wall. -->
            <button class="epic-summary" data-epic-toggle="${e.id}" aria-expanded="false">
              <i class="fas fa-chevron-right epic-caret"></i>
              <span class="epic-ident">
                ${e.epicKey ? html`<span class="epic-key">${e.epicKey}</span>` : ""}
                <span class="epic-name">${e.name}</span>
              </span>
              <span class="epic-pill" style="color:${color};border-color:${color}55;background:${color}1a;">${e.status.replace("_", " ")}</span>
              <span class="epic-counts">
                <span>${ets.length} ${ets.length === 1 ? "ticket" : "tickets"}${ets.length ? html` <span class="epic-dim">(${done} done)</span>` : ""}</span>
                <span>${eds.length} ${eds.length === 1 ? "doc" : "docs"}</span>
                <span>${branches.length + (e.branch ? 1 : 0)} ${branches.length + (e.branch ? 1 : 0) === 1 ? "branch" : "branches"}</span>
                <span>${convIds.length} ${convIds.length === 1 ? "chat" : "chats"}</span>
              </span>
            </button>
            ${e.goal ? html`<div class="epic-goal">${e.goal}</div>` : ""}

            <div class="epic-detail" id="epic-detail-${e.id}" hidden>
              <div class="epic-detail-head">
                ${e.branch ? html`
                  <span class="epic-branch-line">
                    <i class="fas fa-code-branch"></i>
                    <code class="epic-branch">${e.branch}</code>
                    <span class="epic-dim">from ${e.baseBranch}</span>
                  </span>` : html`<span class="epic-dim">No branch cut yet</span>`}
                ${e.previewUrl ? html`<a href="${e.previewUrl}" target="_blank" rel="noopener" class="epic-link"><i class="fas fa-play"></i> Preview</a>` : ""}
                ${e.prUrl ? html`<a href="${e.prUrl}" target="_blank" rel="noopener" class="epic-link"><i class="fas fa-code-pull-request"></i> Request</a>` : ""}
                ${e.mergedAt ? html`<span class="epic-merged">Merged ${fmt(e.mergedAt)}</span>` : ""}
                <span style="flex:1;"></span>
                ${e.status === "in_review" ? html`
                  <button class="epic-btn epic-btn-go" data-epic="${e.id}" data-act="approve">Approve</button>
                  <button class="epic-btn epic-btn-no" data-epic="${e.id}" data-act="reject">Reject</button>` : ""}
                ${e.status === "approved" ? html`
                  <button class="epic-btn epic-btn-go" data-epic="${e.id}" data-act="merge">Merge to main</button>` : ""}
              </div>

              <div class="epic-cols">
                <section>
                  <h4>Tickets <span class="epic-dim">${ets.length}</span></h4>
                  ${ets.length === 0 ? html`<p class="epic-dim">None yet.</p>` : ets.map((t) => html`
                    <button class="epic-row" data-open-ticket="${t.id}" title="${t.name}">
                      ${t.ticketKey ? html`<span class="epic-key">${t.ticketKey}</span>` : ""}
                      <span class="epic-row-name">${t.name}</span>
                      <span class="epic-dim" style="color:${TICKET_STATUS_COLOR[t.status] ?? "#94a3b8"};">${t.status.replace("_", " ")}</span>
                    </button>`)}
                </section>

                <section>
                  <h4>Documents <span class="epic-dim">${eds.length}</span></h4>
                  ${eds.length === 0 ? html`<p class="epic-dim">None linked.</p>` : eds.map((d) => html`
                    <button class="epic-row" data-open-doc="${d.id}" data-doc-name="${d.name}" title="${d.name}">
                      <i class="fas fa-file-lines epic-dim"></i>
                      <span class="epic-row-name">${d.name}</span>
                      <span class="epic-dim">${d.owned ? "draft" : d.fileType}</span>
                    </button>`)}
                </section>

                <section>
                  <h4>Conversations <span class="epic-dim">${convIds.length}</span></h4>
                  ${convIds.length === 0 ? html`<p class="epic-dim">None linked.</p>` : convIds.map((cid, i) => html`
                    <a class="epic-row" href="/chat/project/${project.projectId}/conversation/${cid}">
                      <i class="fas fa-comments epic-dim"></i>
                      <span class="epic-row-name">${convById.get(cid)?.title || "Untitled chat"}</span>
                      ${i === 0 && e.conversationId === cid ? html`<span class="epic-dim">origin</span>` : ""}
                    </a>`)}
                </section>

                <section>
                  <h4>Branches <span class="epic-dim">${branches.length + (e.branch ? 1 : 0)}</span></h4>
                  ${e.branch ? html`<div class="epic-row"><code class="epic-branch">${e.branch}</code><span class="epic-dim">epic</span></div>` : ""}
                  ${branches.map((b) => html`<div class="epic-row"><code class="epic-branch">${b}</code></div>`)}
                </section>
              </div>
            </div>
          </div>`;
      })}
    </div>
  </div>
  </div>

  <!-- Detail drawer: a ticket or a document opens HERE, over the list, instead of
       navigating away to the tickets board and losing your place. -->
  <div id="epic-drawer" class="epic-drawer" hidden>
    <div class="epic-drawer-head">
      <span id="epic-drawer-title">Details</span>
      <button class="epic-drawer-x" onclick="closeEpicDrawer()"><i class="fas fa-xmark"></i></button>
    </div>
    <div id="epic-drawer-body" class="epic-drawer-body"></div>
  </div>
  <div id="epic-drawer-scrim" class="epic-drawer-scrim" hidden onclick="closeEpicDrawer()"></div>

<script src="/public/js/sidebar.js"></script>
<script>
  var PROJECT_ID = '${project.projectId}';

  // Expand/collapse. The list stays a list; detail is opt-in.
  document.addEventListener('click', function (ev) {
    var t = ev.target.closest ? ev.target.closest('[data-epic-toggle]') : null;
    if (!t) return;
    var id = t.getAttribute('data-epic-toggle');
    var item = document.querySelector('[data-epic-row="' + id + '"]');
    var detail = document.getElementById('epic-detail-' + id);
    if (!item || !detail) return;
    var open = !detail.hidden;
    detail.hidden = open;
    item.classList.toggle('open', !open);
    t.setAttribute('aria-expanded', String(!open));
  });

  // A ticket opens HERE, in a drawer, using the ticket board's existing embed render —
  // same drawer the chat page uses. Going to the board and back loses your place.
  function openEpicDrawer(title, html) {
    document.getElementById('epic-drawer-title').textContent = title;
    document.getElementById('epic-drawer-body').innerHTML = html;
    document.getElementById('epic-drawer').hidden = false;
    document.getElementById('epic-drawer-scrim').hidden = false;
  }
  function closeEpicDrawer() {
    document.getElementById('epic-drawer').hidden = true;
    document.getElementById('epic-drawer-scrim').hidden = true;
    document.getElementById('epic-drawer-body').innerHTML = '';
  }
  window.closeEpicDrawer = closeEpicDrawer;
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeEpicDrawer(); });

  document.addEventListener('click', function (ev) {
    var tk = ev.target.closest ? ev.target.closest('[data-open-ticket]') : null;
    if (tk) {
      var tid = tk.getAttribute('data-open-ticket');
      var name = (tk.querySelector('.epic-row-name') || {}).textContent || 'Ticket';
      openEpicDrawer(name, '<iframe src="/projects/' + PROJECT_ID + '/tickets?embed=' + encodeURIComponent(tid) + '"></iframe>');
      return;
    }
    var dc = ev.target.closest ? ev.target.closest('[data-open-doc]') : null;
    if (dc) {
      var fid = dc.getAttribute('data-open-doc');
      var dname = dc.getAttribute('data-doc-name') || 'Document';
      openEpicDrawer(dname, '<div class="epic-doc">Loading\u2026</div>');
      fetch('/projects/' + PROJECT_ID + '/api/files/' + fid + '/content')
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var body = document.getElementById('epic-drawer-body');
          if (!body) return;
          var pre = document.createElement('pre');
          pre.textContent = (j && j.content) || 'This document is empty.';
          var wrap = document.createElement('div');
          wrap.className = 'epic-doc';
          wrap.appendChild(pre);
          body.innerHTML = '';
          body.appendChild(wrap);
        })
        .catch(function () {
          var body = document.getElementById('epic-drawer-body');
          if (body) body.innerHTML = '<div class="epic-doc">Could not load this document.</div>';
        });
    }
  });

  // Approve / reject / merge.
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
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
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
