/**
 * Fine-grained Git access sharing.
 *
 * Decides WHOSE connected Git (GitHub/GitLab) token a project action should use,
 * honoring the per-project `shareGitAccess` toggle:
 *
 *  - The OWNER always acts with their own token.
 *  - A COLLABORATOR acts with the OWNER's token ONLY when the owner has turned
 *    `shareGitAccess` ON (explicit opt-in, scoped to this project's repo).
 *  - Otherwise a collaborator acts with their OWN connected token — and if they have
 *    none (or it can't reach this repo) the caller BLOCKS with a clear message, so the
 *    owner's credentials are never used without opt-in.
 *
 * Pure (no DB): pass the loaded project row + the acting userId.
 */
export function resolveGitActor(
  project: { ownerId: string; shareGitAccess?: boolean | null },
  actingUserId: string | null | undefined,
): { gitUserId: string; usingOwnCollaboratorToken: boolean } {
  const ownerId = project.ownerId;
  const actor = actingUserId || ownerId;
  // Owner acting, OR sharing explicitly enabled → the owner's token is the one to use.
  if (actor === ownerId || project.shareGitAccess) {
    return { gitUserId: ownerId, usingOwnCollaboratorToken: false };
  }
  // Sharing OFF + a collaborator → they must use their OWN connected Git.
  return { gitUserId: actor, usingOwnCollaboratorToken: true };
}

/** Shown when sharing is OFF and the acting collaborator has no usable Git of their own. */
export const NO_SHARED_GIT_MESSAGE =
  "This project doesn't share the owner's Git access, and your own GitHub/GitLab isn't connected (or it can't access this repo). Connect your Git under Settings → Integrations, or ask the project owner to turn on “Share Git access” in the project's Settings.";
