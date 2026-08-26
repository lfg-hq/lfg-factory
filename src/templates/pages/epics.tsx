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

    /* ── Two panes: the list, and the epic you picked ─────────────────────── */
    .epics-body { flex: 1; min-height: 0; display: flex; align-items: stretch; }
    .epics-list { flex: 1; min-width: 0; overflow-y: auto; padding: 0.25rem 1.5rem 3rem; }
    /* The panel only exists once an epic is chosen. A permanently-mounted empty
       "Details" pane reads as something broken, which is exactly how it looked. */
    /* The panel GROWS into whatever the list doesn't take. Giving both a fixed basis
       (420px + 860px) left a dead strip on the right of any wide screen. */
    .epic-panel {
      flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column;
      border-left: 1px solid var(--border-color); background: var(--card-bg, var(--background-surface));
    }
    .epic-panel[hidden] { display: none; }
    .epics-body.has-panel .epics-list { flex: 0 0 min(420px, 38%); }
    @media (max-width: 900px) {
      /* No room for two panes — the panel takes over. */
      .epic-panel { position: fixed; inset: 0 0 0 auto; width: min(560px, 100%); z-index: 1200; box-shadow: -18px 0 50px rgba(0,0,0,.35); }
      .epics-body.has-panel .epics-list { width: auto; flex: 1; }
    }
    .epic-panel-head {
      display: flex; align-items: center; gap: 0.75rem; flex: none;
      padding: 0.85rem 1.2rem; border-bottom: 1px solid var(--border-color);
    }
    .epic-panel-title { flex: 1; min-width: 0; font-weight: 700; font-size: 0.95rem; color: var(--text-color); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .epic-panel-x, .epic-panel-back {
      background: none; border: none; color: var(--text-secondary); cursor: pointer; font-size: 0.85rem;
      display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.2rem 0.4rem; border-radius: 6px;
    }
    .epic-panel-x:hover, .epic-panel-back:hover { color: var(--text-color); background: color-mix(in srgb, var(--border-color) 30%, transparent); }
    .epic-panel-body { flex: 1; min-height: 0; overflow: auto; }
    .epic-panel-body > iframe { width: 100%; height: 100%; border: 0; display: block; }

    /* ── The list ─────────────────────────────────────────────────────────── */
    .epic-item { border-bottom: 1px solid var(--border-color); }
    /* The WHOLE block opens the epic — title, description and counts alike. Only the
       title row used to be clickable, so clicking the description did nothing. */
    .epic-summary {
      width: 100%; text-align: left; background: none; border: none; cursor: pointer;
      display: block; padding: 0.8rem 0.75rem; color: var(--text-color); border-radius: 8px;
    }
    .epic-summary-top { display: flex; align-items: center; gap: 0.6rem; }
    .epic-summary:hover { background: color-mix(in srgb, var(--border-color) 22%, transparent); }
    .epic-item.selected .epic-summary { background: color-mix(in srgb, var(--primary-color, #8b5cf6) 12%, transparent); }
    .epic-ident { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 0.5rem; }
    .epic-key { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.72rem; color: var(--text-secondary); flex: none; }
    .epic-name { font-weight: 650; font-size: 0.92rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .epic-pill { font-size: 0.66rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; padding: 2px 7px; border-radius: 5px; border: 1px solid; white-space: nowrap; flex: none; }
    /* Counts sit on their OWN line as one quiet run of text. Stacked against the title
       row they crowded the pill and the chevron into a jumble. */
    .epic-counts { display: flex; flex-wrap: wrap; gap: 0.55rem; margin-top: 0.5rem; font-size: 0.73rem; color: var(--text-secondary); }
    .epic-counts .sep { opacity: 0.4; }
    .epic-dim { color: var(--text-secondary); opacity: 0.75; }
    .epic-goal {
      margin: 0.35rem 0 0; font-size: 0.8rem; line-height: 1.55; color: var(--text-secondary);
      max-width: 62ch; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    }

    /* ── Detail, stacked one section under another ────────────────────────── */
    /* Cap the reading width. Now that the panel grows to fill the row, an unbounded
       detail stretched each ticket's name and its status to opposite edges. */
    .epic-detail { padding: 1.2rem 1.5rem 3rem; max-width: 900px; }
    .epic-detail-head { display: flex; align-items: center; gap: 0.7rem; flex-wrap: wrap; margin-bottom: 1.1rem; }
    .epic-branch-line { display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.78rem; color: var(--text-secondary); }
    .epic-branch { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.74rem; padding: 2px 7px; border-radius: 5px; background: color-mix(in srgb, var(--border-color) 40%, transparent); color: var(--text-color); }
    .epic-link { font-size: 0.78rem; color: var(--primary-color, #8b5cf6); text-decoration: none; display: inline-flex; align-items: center; gap: 0.3rem; }
    .epic-merged { font-size: 0.75rem; color: #22c55e; }
    .epic-btn { font-size: 0.76rem; font-weight: 600; padding: 0.32rem 0.7rem; border-radius: 6px; cursor: pointer; border: 1px solid; background: none; }
    .epic-btn-go { color: #10b981; border-color: #10b98155; }
    .epic-btn-no { color: #ef4444; border-color: #ef444455; }
    .epic-btn[disabled] { opacity: 0.5; cursor: default; }
    .epic-sec { margin-top: 1.5rem; }
    .epic-sec:first-of-type { margin-top: 0; }
    .epic-sec h4 { margin: 0 0 0.5rem; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-secondary); }
    .epic-sec h4 .epic-dim { font-weight: 600; letter-spacing: 0; }
    .epic-row {
      width: 100%; text-align: left; background: none; border: none; border-bottom: 1px solid var(--border-color);
      display: flex; align-items: center; gap: 0.55rem; padding: 0.5rem 0.2rem;
      font-size: 0.83rem; color: var(--text-color); text-decoration: none; cursor: pointer;
    }
    .epic-row:last-child { border-bottom: none; }
    button.epic-row:hover, a.epic-row:hover { color: #a78bfa; }
    .epic-row-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* Documents are MARKDOWN — rendered, not dumped. They used to land in one giant
       <pre>, which a global rule painted dark on a light page. */
    .epic-doc { padding: 1.2rem 1.5rem 3rem; font-size: 0.875rem; line-height: 1.7; color: var(--text-color); max-width: 78ch; }
    .epic-doc h1 { font-size: 1.35rem; margin: 0 0 0.8rem; }
    .epic-doc h2 { font-size: 1.08rem; margin: 1.7rem 0 0.6rem; padding-bottom: 0.3rem; border-bottom: 1px solid var(--border-color); }
    .epic-doc h3 { font-size: 0.95rem; margin: 1.3rem 0 0.45rem; }
    .epic-doc p { margin: 0 0 0.85rem; }
    .epic-doc ul, .epic-doc ol { margin: 0 0 0.9rem; padding-left: 1.35rem; }
    .epic-doc li { margin: 0.2rem 0; }
    .epic-doc code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.82em;
      padding: 1px 5px; border-radius: 4px; background: color-mix(in srgb, var(--border-color) 45%, transparent);
    }
    .epic-doc pre {
      background: color-mix(in srgb, var(--border-color) 28%, transparent);
      border: 1px solid var(--border-color); border-radius: 8px;
      padding: 0.8rem 0.95rem; overflow-x: auto; margin: 0 0 1rem;
    }
    .epic-doc pre code { background: none; padding: 0; font-size: 0.8rem; }
    .epic-doc table { border-collapse: collapse; width: 100%; margin: 0 0 1rem; font-size: 0.82rem; display: block; overflow-x: auto; }
    .epic-doc th, .epic-doc td { border: 1px solid var(--border-color); padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
    .epic-doc th { background: color-mix(in srgb, var(--border-color) 30%, transparent); font-weight: 650; }
    .epic-doc blockquote { margin: 0 0 1rem; padding-left: 0.9rem; border-left: 3px solid var(--border-color); color: var(--text-secondary); }
    .epic-doc a { color: var(--primary-color, #8b5cf6); }
    .epic-doc img { max-width: 100%; }
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

    <div class="epics-body" id="epics-body">
    <div class="epics-list">
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
          <div class="epic-item" data-epic-item="${e.id}">
            <button class="epic-summary" data-epic-open="${e.id}">
              <span class="epic-summary-top">
                <span class="epic-ident">
                  ${e.epicKey ? html`<span class="epic-key">${e.epicKey}</span>` : ""}
                  <span class="epic-name">${e.name}</span>
                </span>
                <span class="epic-pill" style="color:${color};border-color:${color}55;background:${color}1a;">${e.status.replace("_", " ")}</span>
                <i class="fas fa-chevron-right epic-dim" style="font-size:0.7rem;"></i>
              </span>
              ${e.goal ? html`<span class="epic-goal">${e.goal}</span>` : ""}
              <span class="epic-counts">
                <span>${ets.length} ${ets.length === 1 ? "ticket" : "tickets"}${ets.length ? html` <span class="epic-dim">(${done} done)</span>` : ""}</span>
                <span class="sep">·</span>
                <span>${eds.length} ${eds.length === 1 ? "doc" : "docs"}</span>
                <span class="sep">·</span>
                <span>${convIds.length} ${convIds.length === 1 ? "chat" : "chats"}</span>
              </span>
            </button>

            <!-- The panel's contents, rendered server-side and cloned in on click.
                 Sections run one UNDER another: the panel is tall and narrow, and the
                 four side-by-side columns this replaced were unreadable. -->
            <template data-epic-detail="${e.id}" data-epic-title="${(e.epicKey ? e.epicKey + " · " : "") + e.name}">
              <div class="epic-detail">
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
                  ${e.status === "in_review" ? html`
                    <button class="epic-btn epic-btn-go" data-epic="${e.id}" data-act="approve">Approve</button>
                    <button class="epic-btn epic-btn-no" data-epic="${e.id}" data-act="reject">Reject</button>` : ""}
                  ${e.status === "approved" ? html`
                    <button class="epic-btn epic-btn-go" data-epic="${e.id}" data-act="merge">Merge to main</button>` : ""}
                </div>

                ${e.goal ? html`<p style="margin:0 0 1.2rem;font-size:0.84rem;line-height:1.6;color:var(--text-secondary);">${e.goal}</p>` : ""}

                <section class="epic-sec">
                  <h4>Tickets <span class="epic-dim">${ets.length}</span></h4>
                  ${ets.length === 0 ? html`<p class="epic-dim" style="font-size:0.8rem;">None yet.</p>` : ets.map((t) => html`
                    <button class="epic-row" data-open-ticket="${t.id}" title="${t.name}">
                      ${t.ticketKey ? html`<span class="epic-key">${t.ticketKey}</span>` : ""}
                      <span class="epic-row-name">${t.name}</span>
                      <span class="epic-dim" style="color:${TICKET_STATUS_COLOR[t.status] ?? "#94a3b8"};">${t.status.replace("_", " ")}</span>
                    </button>`)}
                </section>

                <section class="epic-sec">
                  <h4>Documents <span class="epic-dim">${eds.length}</span></h4>
                  ${eds.length === 0 ? html`<p class="epic-dim" style="font-size:0.8rem;">None linked.</p>` : eds.map((d) => html`
                    <button class="epic-row" data-open-doc="${d.id}" data-doc-name="${d.name}" title="${d.name}">
                      <i class="fas fa-file-lines epic-dim"></i>
                      <span class="epic-row-name">${d.name}</span>
                      <span class="epic-dim">${d.owned ? "draft" : d.fileType}</span>
                    </button>`)}
                </section>

                <section class="epic-sec">
                  <h4>Conversations <span class="epic-dim">${convIds.length}</span></h4>
                  ${convIds.length === 0 ? html`<p class="epic-dim" style="font-size:0.8rem;">None linked.</p>` : convIds.map((cid, i) => html`
                    <a class="epic-row" href="/chat/project/${project.projectId}/conversation/${cid}">
                      <i class="fas fa-comments epic-dim"></i>
                      <span class="epic-row-name">${convById.get(cid)?.title || "Untitled chat"}</span>
                      ${i === 0 && e.conversationId === cid ? html`<span class="epic-dim">origin</span>` : ""}
                    </a>`)}
                </section>

                <section class="epic-sec">
                  <h4>Branches <span class="epic-dim">${branches.length + (e.branch ? 1 : 0)}</span></h4>
                  ${e.branch ? html`<div class="epic-row"><code class="epic-branch">${e.branch}</code><span class="epic-dim">epic</span></div>` : ""}
                  ${branches.map((b) => html`<div class="epic-row"><code class="epic-branch">${b}</code></div>`)}
                </section>
              </div>
            </template>
          </div>`;
      })}
    </div>

    <!-- Opens only when an epic is picked; a permanently-mounted empty "Details" pane
         reads as something broken, which is exactly how it looked. -->
    <aside class="epic-panel" id="epic-panel" hidden>
      <div class="epic-panel-head">
        <button class="epic-panel-back" id="epic-panel-back" hidden><i class="fas fa-arrow-left"></i> Epic</button>
        <span class="epic-panel-title" id="epic-panel-title"></span>
        <button class="epic-panel-x" id="epic-panel-close" title="Close"><i class="fas fa-xmark"></i></button>
      </div>
      <div class="epic-panel-body" id="epic-panel-body"></div>
    </aside>
    </div>
  </div>
  </div>

<script src="/public/js/marked.min.js"></script>
<script src="/public/js/markdown-config.js"></script>
<script src="/public/js/sidebar.js"></script>
<script>
  var PROJECT_ID = '${project.projectId}';

  var panel = document.getElementById('epic-panel');
  var panelBody = document.getElementById('epic-panel-body');
  var panelTitle = document.getElementById('epic-panel-title');
  var panelBack = document.getElementById('epic-panel-back');
  var epicsBody = document.getElementById('epics-body');
  var currentEpic = null;

  // Picking an epic fills the RIGHT PANEL with its whole trail — tickets, documents,
  // conversations, branches, stacked one under the other. The list stays a list.
  function openEpic(id) {
    var tpl = document.querySelector('[data-epic-detail="' + id + '"]');
    if (!tpl) return;
    currentEpic = id;
    panelBody.innerHTML = '';
    panelBody.appendChild(tpl.content.cloneNode(true));
    panelTitle.textContent = tpl.getAttribute('data-epic-title') || 'Epic';
    panelBack.hidden = true;
    panel.hidden = false;
    epicsBody.classList.add('has-panel');
    var items = document.querySelectorAll('[data-epic-item]');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('selected', items[i].getAttribute('data-epic-item') === id);
    }
    panelBody.scrollTop = 0;
  }

  function closePanel() {
    panel.hidden = true;
    epicsBody.classList.remove('has-panel');
    panelBody.innerHTML = '';
    currentEpic = null;
    var items = document.querySelectorAll('[data-epic-item]');
    for (var i = 0; i < items.length; i++) items[i].classList.remove('selected');
  }

  /** Show something else (a ticket, a document) in the panel, with a way back. */
  function pushIntoPanel(title, node) {
    panelBody.innerHTML = '';
    panelBody.appendChild(node);
    panelTitle.textContent = title;
    panelBack.hidden = false;
    panelBody.scrollTop = 0;
  }

  document.getElementById('epic-panel-close').addEventListener('click', closePanel);
  panelBack.addEventListener('click', function () { if (currentEpic) openEpic(currentEpic); });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || panel.hidden) return;
    if (!panelBack.hidden && currentEpic) openEpic(currentEpic); else closePanel();
  });

  document.addEventListener('click', function (ev) {
    var open = ev.target.closest ? ev.target.closest('[data-epic-open]') : null;
    if (open) { openEpic(open.getAttribute('data-epic-open')); return; }

    // A ticket opens IN the panel using the board's existing embed render, so you keep
    // your place instead of being thrown back to the tickets screen.
    var tk = ev.target.closest ? ev.target.closest('[data-open-ticket]') : null;
    if (tk) {
      var tid = tk.getAttribute('data-open-ticket');
      var nameEl = tk.querySelector('.epic-row-name');
      var frame = document.createElement('iframe');
      frame.src = '/projects/' + PROJECT_ID + '/tickets?embed=' + encodeURIComponent(tid);
      pushIntoPanel(nameEl ? nameEl.textContent : 'Ticket', frame);
      return;
    }

    var dc = ev.target.closest ? ev.target.closest('[data-open-doc]') : null;
    if (dc) {
      var fid = dc.getAttribute('data-open-doc');
      var dname = dc.getAttribute('data-doc-name') || 'Document';
      var wrap = document.createElement('div');
      wrap.className = 'epic-doc';
      wrap.textContent = 'Loading\u2026';
      pushIntoPanel(dname, wrap);
      fetch('/projects/' + PROJECT_ID + '/api/files/' + fid + '/content')
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var raw = (j && j.content) || '';
          if (!raw.trim()) { wrap.textContent = 'This document is empty.'; return; }
          if (typeof marked !== 'undefined') {
            wrap.innerHTML = marked.parse(raw);
          } else {
            // No renderer loaded — show the text readably rather than as one long line.
            var pre = document.createElement('pre');
            pre.textContent = raw;
            wrap.textContent = '';
            wrap.appendChild(pre);
          }
        })
        .catch(function () { wrap.textContent = 'Could not load this document.'; });
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
