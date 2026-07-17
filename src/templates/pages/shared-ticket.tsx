import { html, raw } from "hono/html";

interface SharedTicketPageProps {
  ticket: {
    name: string;
    description: string | null;
    status: string | null;
    priority: string | null;
  };
  tasks: Array<{
    description: string;
    status: string | null;
  }>;
  project: {
    name: string;
    icon: string;
  };
}

export function SharedTicketPage({ ticket, tasks, project }: SharedTicketPageProps) {
  const priorityColors: Record<string, string> = {
    High: "#ef4444",
    Medium: "#f59e0b",
    Low: "#6b7280",
  };
  const priorityColor = priorityColors[ticket.priority ?? "Medium"] ?? "#6b7280";

  return html`<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${ticket.name} — ${project.name} — LFG</title>
  <link rel="stylesheet" href="/public/css/theme-variables.css" />
  <link rel="stylesheet" href="/public/css/common.css" />
  <link rel="stylesheet" href="/public/css/polish.css" />
  <link rel="stylesheet" href="/public/css/light/light-mode.css" />
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css" />
  <script src="/public/js/theme-switcher.js"></script>
  <script src="/public/js/marked.min.js"></script>
  <style>
    body { background: var(--bg-color); margin: 0; padding: 0; }
    .shared-container { max-width: 700px; margin: 0 auto; padding: 2rem 1.5rem; }
    .shared-header { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 1px solid var(--border-color); }
    .ticket-title { font-size: 1.25rem; font-weight: 600; color: var(--text-color); margin-bottom: 0.75rem; }
    .ticket-meta { display: flex; gap: 0.75rem; margin-bottom: 1.5rem; flex-wrap: wrap; }
    .ticket-badge { font-size: 0.7rem; padding: 0.15rem 0.5rem; border-radius: 10px; font-weight: 600; text-transform: uppercase; }
    .ticket-description { color: var(--text-color); line-height: 1.6; font-size: 0.9375rem; margin-bottom: 2rem; }
    .ticket-description p { margin: 0.5rem 0; }
    .task-list { margin-top: 1.5rem; }
    .task-list-title { font-size: 0.9375rem; font-weight: 600; color: var(--text-color); margin-bottom: 0.75rem; }
    .task-item { display: flex; align-items: flex-start; gap: 0.5rem; padding: 0.5rem 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .task-check { margin-top: 0.1rem; color: var(--text-secondary); font-size: 0.875rem; }
    .task-check.done { color: #22c55e; }
    .task-text { font-size: 0.875rem; color: var(--text-color); line-height: 1.5; }
    .task-text.done { text-decoration: line-through; color: var(--text-secondary); }
    .shared-branding { text-align: center; padding: 2rem 0; margin-top: 3rem; border-top: 1px solid var(--border-color); }
    .shared-branding a { font-size: 0.8125rem; color: var(--text-secondary); text-decoration: none; }
  </style>
</head>
<body>
  <div class="shared-container">
    <div class="shared-header">
      <span style="font-size:1.5rem;">${project.icon}</span>
      <div>
        <div style="font-size:0.8125rem;color:var(--text-secondary);">${project.name}</div>
      </div>
    </div>

    <div class="ticket-title">${ticket.name}</div>

    <div class="ticket-meta">
      ${ticket.status ? html`
        <span class="ticket-badge" style="background:rgba(59,130,246,0.1);color:#60a5fa;">${ticket.status}</span>
      ` : ""}
      ${ticket.priority ? html`
        <span class="ticket-badge" style="background:rgba(${priorityColor === "#ef4444" ? "239,68,68" : priorityColor === "#f59e0b" ? "245,158,11" : "107,114,128"},0.1);color:${priorityColor};">${ticket.priority}</span>
      ` : ""}
    </div>

    ${ticket.description ? html`
      <div class="ticket-description" id="ticket-desc"></div>
    ` : ""}

    ${tasks.length > 0 ? html`
      <div class="task-list">
        <div class="task-list-title">Tasks (${tasks.filter((t) => t.status === "completed").length}/${tasks.length})</div>
        ${tasks.map((t) => html`
          <div class="task-item">
            <i class="fas ${t.status === "completed" ? "fa-check-circle task-check done" : "fa-circle task-check"}" style="font-size:0.875rem;"></i>
            <span class="task-text ${t.status === "completed" ? "done" : ""}">${t.description}</span>
          </div>
        `)}
      </div>
    ` : ""}

    <div class="shared-branding">
      <a href="/">Built with LFG</a>
    </div>
  </div>
  ${ticket.description ? html`
    <script>
      var desc = ${raw(JSON.stringify(ticket.description).replace(/</g, "\\u003c"))};
      var el = document.getElementById('ticket-desc');
      if (el && typeof marked !== 'undefined') {
        el.innerHTML = marked.parse(desc);
      } else if (el) {
        el.textContent = desc;
      }
    </script>
  ` : ""}
</body>
</html>`;
}
