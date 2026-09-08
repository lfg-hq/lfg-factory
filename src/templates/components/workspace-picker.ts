import { html } from 'hono/html';
import type { workspaceContext } from '../../services/team-access.ts';
export type WorkspaceContext = Awaited<ReturnType<typeof workspaceContext>>;
export function WorkspacePicker(context?: WorkspaceContext, returnTo = '/settings/team') {
  if (!context) return '';
  const label = (role: string) => role === 'member' ? 'Collaborator' : role.charAt(0).toUpperCase() + role.slice(1);
  const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(n => n.charAt(0)).join('').toUpperCase();
  const current = context.teams.find(t => t.id === context.currentId);
  if (!current) return '';
  return html`<div class="workspace-picker"><details class="ws-dropdown"><summary aria-label="Switch workspace, current workspace ${current.name}"><span class="ws-avatar">${initials(current.name)}</span><span class="ws-current-name">${current.name}</span><span class="ws-role">${label(current.role)}</span><svg class="ws-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m5 6 3-3 3 3M5 10l3 3 3-3"/></svg></summary><div class="ws-panel"><div class="ws-panel-label">SWITCH WORKSPACE</div><form method="post" action="/settings/team/switch"><input type="hidden" name="returnTo" value="${returnTo}">${context.teams.map(t => html`<button type="submit" name="teamId" value="${t.id}" class="ws-option" ${t.id === current.id ? 'aria-current=true' : ''}><span class="ws-avatar">${initials(t.name)}</span><span class="ws-option-copy"><strong>${t.name}</strong><span>${label(t.role)}</span></span>${t.id === current.id ? html`<span class="ws-check" aria-hidden="true">✓</span>` : ''}</button>`)}</form><a class="ws-manage" href="/settings/team">Manage people &amp; access <span aria-hidden="true">↗</span></a></div></details>${context.invitations.map(i => html`<div class="workspace-invite"><span>You’re invited to <strong>${i.name}</strong> as ${label(i.role)}.</span><a href="/settings/team/accept/${i.token}">Review invitation →</a></div>`)}</div><script src="/public/js/workspace-picker.js" defer></script>`;
}
