import { html } from "hono/html";

type Person = { id: string; name: string; email: string; role: string };
const roleLabel = (role: string) => ({ owner: "Owner", admin: "Admin", member: "Collaborator", viewer: "Viewer" }[role] ?? role);
const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(n => n[0]).join("").toUpperCase();
const iconPaths: Record<string, string> = {
  "shield-alt": "M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z M9 12l2 2 4-4",
  key: "M15 14a5 5 0 1 0-5-5L3 16v5h5v-3h3l4-4Z M16 7h.01",
  "sliders-h": "M3 7h4m4 0h10M3 17h10m4 0h4 M7 4v6m10 4v6",
  plus: "M12 5v14M5 12h14",
  crown: "m3 6 4 4 5-6 5 6 4-4-2 13H5L3 6Z",
  lock: "M7 10V7a5 5 0 0 1 10 0v3 M5 10h14v11H5V10Z",
  times: "m6 6 12 12M6 18 18 6",
  link: "m10 13 4-4 M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0 M16 8l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0",
};
const icon = (name: string) => html`<svg class="tm-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${iconPaths[name] ?? iconPaths.plus}" /></svg>`;

export function TeamSettingsContent({ team, role, isAdmin, availableTeams, owner, members, invitations, baseUrl }: {
  team: { id: string; name: string; tokensEnabled: boolean; subscriptionsEnabled: boolean };
  role: string; isAdmin: boolean; availableTeams: Array<{ id: string; name: string }>;
  owner?: { name: string; email: string }; members: Person[];
  invitations: Array<{ id: string; email: string; role: string; token: string }>;
  baseUrl: string;
}) {
  const people = members.filter(m => m.email !== owner?.email);
  const options = (selected = "member") => ["admin", "member", "viewer"].filter(r => role === "owner" || r !== "admin").map(r => html`<option value="${r}" ${r === selected ? "selected" : ""}>${roleLabel(r)}</option>`);
  return html`
  <header class="tm-heading">
    <div><div class="tm-eyebrow">WORKSPACE SETTINGS</div><h1>People &amp; access</h1><p>Manage your team and how they use AI.</p></div>
    <span class="tm-badge">${icon("shield-alt")} ${roleLabel(role)} access</span>
  </header>
  ${isAdmin ? html`<form method="post" action="/settings/team/policy" data-team-form="policy" class="tm-policy">` : html`<div class="tm-policy">`}
    <section class="tm-card tm-general">
      <div class="tm-workspace-icon">${initials(team.name)}</div>
      <div class="tm-general-label"><h2>Workspace</h2><p>Your team’s shared space.</p></div>
      <div class="tm-name-field"><label for="tm-name">Team name</label><input id="tm-name" name="name" value="${team.name}" required maxlength="100" ${!isAdmin ? "readonly" : ""}></div>
    </section>
    <section class="tm-card">
      <div class="tm-card-heading"><div><h2>Model access</h2><p>Choose how your team connects to AI.</p></div><span class="tm-caption">Applies across projects</span></div>
      <div class="tm-access-row">
        <div class="tm-provider-icon tm-token-icon">${icon("key")}</div>
        <div class="tm-access-copy"><h3>Team API tokens</h3><p>Members use the API keys managed by your admins.</p>${isAdmin ? html`<a href="/settings">Manage API keys <span aria-hidden="true">↗</span></a>` : ""}</div>
        <label class="tm-toggle"><input type="checkbox" role="switch" aria-label="Enable team API tokens" name="tokensEnabled" ${team.tokensEnabled ? "checked" : ""} ${!isAdmin ? "disabled" : ""}><span class="tm-toggle-track"></span></label>
      </div>
      <div class="tm-access-row">
        <div class="tm-provider-icon"><img src="/public/images/models/openai.svg" alt="" /></div>
        <div class="tm-access-copy"><h3>Personal ChatGPT subscriptions</h3><p>Members connect their own ChatGPT account.</p><a href="/settings/integrations">Manage your connection <span aria-hidden="true">↗</span></a></div>
        <label class="tm-toggle"><input type="checkbox" role="switch" aria-label="Allow personal ChatGPT subscriptions" name="subscriptionsEnabled" ${team.subscriptionsEnabled ? "checked" : ""} ${!isAdmin ? "disabled" : ""}><span class="tm-toggle-track"></span></label>
      </div>
      <footer class="tm-card-footer"><span>${icon("sliders-h")} Fine-tune access for each member in Project Settings.</span>${isAdmin ? html`<button type="submit" class="tm-button tm-primary">Save changes</button>` : html`<span class="tm-caption">Managed by your admins</span>`}</footer>
    </section>
  ${isAdmin ? html`</form>` : html`</div>`}
  <section class="tm-card tm-people">
    <div class="tm-card-heading"><div class="tm-member-heading"><h2>Members</h2><span class="tm-count">${people.length + Number(!!owner)}</span></div>${isAdmin ? html`<button type="button" class="tm-button tm-primary" id="tm-invite-toggle" aria-expanded="false" aria-controls="tm-invite-panel">${icon("plus")} Invite member</button>` : ""}</div>
    ${isAdmin ? html`<div id="tm-invite-panel" class="tm-invite-panel" hidden><form method="post" action="/settings/team/invite" data-team-form="invite"><div class="tm-invite-email"><label for="tm-email">Email address</label><input id="tm-email" type="email" name="email" placeholder="name@company.com" required></div><div><label for="tm-invite-role">Role</label><select id="tm-invite-role" name="role">${options()}</select></div><button class="tm-button tm-primary">Create invite link</button></form><p>Share the generated link to invite someone to your team.</p></div>` : ""}
    <div class="tm-table-head"><span>Member</span><span>Role</span><span></span></div>
    ${owner ? html`<div class="tm-person"><div class="tm-identity"><span class="tm-avatar tm-avatar-owner">${initials(owner.name)}</span><div><div class="tm-person-name">${owner.name} <span class="tm-you">${role === "owner" ? "You" : ""}</span></div><div class="tm-email">${owner.email}</div></div></div><div class="tm-role-static">${icon("crown")} Owner</div><span class="tm-lock" title="The owner always retains access">${icon("lock")}</span></div>` : ""}
    ${people.map((m, index) => html`<div class="tm-person"><div class="tm-identity"><span class="tm-avatar tm-avatar-${index % 3}">${initials(m.name)}</span><div><div class="tm-person-name">${m.name}</div><div class="tm-email">${m.email}</div></div></div>${isAdmin && (role === "owner" || m.role !== "admin") ? html`<form method="post" action="/settings/team/member" data-team-form="member" class="tm-member-actions"><input type="hidden" name="id" value="${m.id}"><label class="tm-sr-only" for="tm-role-${m.id}">Role for ${m.name}</label><select id="tm-role-${m.id}" name="role" onchange="this.form.requestSubmit(this.form.querySelector('[value=update]'))">${options(m.role)}</select><button type="submit" name="action" value="update" hidden>Save role</button><button class="tm-remove" type="submit" name="action" value="remove" aria-label="Remove ${m.name}" title="Remove member">${icon("times")}</button></form>` : html`<span class="tm-role-static">${roleLabel(m.role)}</span><span></span>`}</div>`)}
    <footer class="tm-member-footer">${icon("shield-alt")} Only the owner can appoint admins.</footer>
  </section>
  ${invitations.length ? html`<section class="tm-card"><div class="tm-card-heading"><div class="tm-member-heading"><h2>Pending invitations</h2><span class="tm-count">${invitations.length}</span></div></div>${invitations.map(i => html`<div class="tm-invitation"><div><div class="tm-person-name">${i.email}</div><span class="tm-email">${roleLabel(i.role)} · Awaiting acceptance</span></div><button type="button" class="tm-button" data-copy-invite="${new URL(`/settings/team/accept/${i.token}`, baseUrl).href}">${icon("link")} Copy link</button><form method="post" action="/settings/team/revoke" data-team-form="revoke"><input type="hidden" name="id" value="${i.id}"><button class="tm-remove" aria-label="Revoke invitation for ${i.email}" title="Revoke invitation">${icon("times")}</button></form></div>`)}</section>` : ""}
  <div class="tm-toast" role="status" aria-live="polite" hidden></div>
  <script src="/public/js/team-settings.js"></script>
  `;
}
