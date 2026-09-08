# Team roles and LLM access

App Settings → People & access manages the current team. The owner retains permanent admin access. Admins manage provider tokens, enable API tokens or personal ChatGPT subscriptions, and invite collaborators/viewers. Only the owner can appoint or change admins. Team invitations produce a link to share; acceptance requires signing in with the invited email address.

Project Settings → Team adds Admin, Collaborator, Viewer, and Guest roles. Each invitation/member has independent permissions for team API tokens and personal ChatGPT subscriptions. New grants default off. Team policy takes precedence over project grants. A project role does not grant access to the team's token administration screen. Removing someone from the team revokes their project access even if their project membership still exists.

ChatGPT credentials remain encrypted in each person's existing profile. Subscription runs never borrow the project owner's login. Subscription-only members see ChatGPT models and a personal connection option, not other providers or token forms. API runs resolve the team's keys on the server. Collaborator builds use isolated sandboxes. Existing personal Claude subscription sharing is not used by these team execution paths; use an Anthropic API token for Claude models.

## Existing installations

Back up the database, stop application workers, then run from this branch with the installation's normal database environment:

```sh
bun run db:push
bun run db:migrate-teams
```

Restart the app after migration. Both SQLite and PostgreSQL schema definitions include the new fields. The data migration is idempotent and has been exercised twice against a fresh SQLite fixture; PostgreSQL schema generation is checked separately, and the additive schema changes and team migration have also been applied to the local development PostgreSQL database.

Migration rules:

- Each existing project owner gets a team named after them. Projects keep their IDs, owner, content, and project memberships.
- The existing owner's API-key row becomes that team's credential source. Keys are neither copied nor deleted.
- Existing collaborators join the corresponding teams as Collaborators. Existing project roles and API-token grants are preserved. An existing project admin does not automatically become a team admin.
- Old owner-subscription grants become permission to use a personal ChatGPT subscription. No subscription credentials are copied. People without their own connection must connect it before subscription runs work.
- Users who own projects initially use their own team. Other users initially use a team they belong to. Users with neither get a personal team. An existing current-team selection is retained.
- Users can belong to multiple teams and switch in App Settings. Projects stay attached to their team independently of that selection.

Existing teams default to both API tokens and personal ChatGPT subscriptions enabled to preserve usable access. Admins can disable either option. Stored credentials alone never override a disabled policy.

The migration does not send emails, merge accounts, or change credentials. Other installations must run the migration before starting the updated app so existing project collaborators have their team memberships. Review schema changes before applying them; decline any unrelated destructive changes proposed by schema push.

## Validation

```sh
bun run test:rbac
bun run typecheck
bun run check:scripts
```

RBAC tests use a generated schema, temporary SQLite database, fake credentials, and a test-only authentication middleware. They cover role escalation, token-write endpoints, disabled subscriptions, per-project grants, model visibility, actor-specific build credentials, revocation, and migration reruns. No live provider calls or sandbox builds are made.

### Existing accounts and multiple workspaces

Projects and Settings expose a workspace selector with each workspace's role and pending organization invitations for the signed-in email. Accepting an invitation selects the joined workspace and preserves personal/other memberships. Switching never grants access to an unrelated workspace. Project invitations are still required separately; organization membership does not expose all projects. The Projects list continues to include the user's explicitly shared projects across workspaces; the selected workspace controls settings and new project creation.
