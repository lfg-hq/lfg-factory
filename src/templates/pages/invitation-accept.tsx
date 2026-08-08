import { html } from "hono/html";

interface InvitationAcceptPageProps {
  user: { id: string; name: string; email?: string };
  invitation: {
    id: string;
    token: string;
    email: string;
    role: string;
  };
  project: {
    name: string;
    icon: string;
  };
  inviterName: string;
}

export function InvitationAcceptPage({
  user,
  invitation,
  project,
  inviterName,
}: InvitationAcceptPageProps) {
  const roleLabels: Record<string, string> = {
    viewer: "Viewer",
    member: "Member",
    guest: "Guest",
    admin: "Admin",
  };

  return html`<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/x-icon" href="/public/images/favicon.ico" />
  <title>Accept Invitation — LFG</title>
  <link rel="stylesheet" href="/public/css/theme-variables.css" />
  <link rel="stylesheet" href="/public/css/common.css" />
  <link rel="stylesheet" href="/public/css/auth.css" />
  <link rel="stylesheet" href="/public/css/polish.css" />
  <link rel="stylesheet" href="/public/css/light/light-mode.css" />
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css" />
  <script src="/public/js/theme-switcher.js"></script>
</head>
<body style="display:flex;align-items:center;justify-content:center;min-height:100vh;background:var(--bg-color);">
  <div style="max-width:420px;width:100%;padding:2rem;background:var(--card-bg);border:1px solid var(--border-color);border-radius:var(--radius-lg);text-align:center;">
    <div style="font-size:2.5rem;margin-bottom:1rem;">${project.icon}</div>
    <h1 style="font-size:1.25rem;font-weight:600;color:var(--text-color);margin:0 0 0.5rem;">You're invited!</h1>
    <p style="font-size:0.875rem;color:var(--text-secondary);margin:0 0 1.5rem;">
      <strong>${inviterName}</strong> has invited you to join
    </p>
    <div style="font-size:1.1rem;font-weight:600;color:var(--text-color);margin-bottom:0.5rem;">
      ${project.name}
    </div>
    <div style="margin-bottom:1.5rem;">
      <span style="font-size:0.75rem;padding:0.2rem 0.6rem;border-radius:10px;background:rgba(139,92,246,0.1);color:#a78bfa;font-weight:600;text-transform:uppercase;">
        ${roleLabels[invitation.role] ?? invitation.role}
      </span>
    </div>
    <p style="font-size:0.8125rem;color:var(--text-secondary);margin:0 0 2rem;">
      Signed in as <strong>${user.email ?? user.name}</strong>
    </p>
    <form method="POST" action="/invitations/accept/${invitation.token}">
      <button type="submit" class="btn btn-primary" style="width:100%;padding:0.75rem;font-size:0.9375rem;">
        <i class="fas fa-check"></i> Accept Invitation
      </button>
    </form>
    <a href="/projects" style="display:block;margin-top:1rem;font-size:0.8125rem;color:var(--text-secondary);text-decoration:none;">
      Decline and go to projects
    </a>
  </div>
</body>
</html>`;
}
