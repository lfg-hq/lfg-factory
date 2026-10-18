/** Preview prepares runtime configuration; application repairs belong to tickets. */
export const PREVIEW_SOURCE_POLICY = `The canonical environment file is .env. Seed and persist settings only there; never create .env.local or alternate environment-file copies or aliases. Web and worker processes must share that resolved environment. If a repository command requires another filename, report it for ticket correction without deleting existing user files. Preview owns runtime preparation: environment, required services, dependency installation from the repository lockfile, build and process startup. Application source, UI, authentication, dependency declarations, scripts and database schema changes belong to ticket execution. Do not implement or persist source repairs in a preview, even on a ticket branch. Runtime configuration overrides may be persisted only for supported configuration files; prefer environment settings. Never save account creation, password resets, test scripts or browser tests as recurring startup work. Never commit, push, merge, tag or update Git refs from preview recovery, and never switch branches. If code prevents startup, return the exact error, selected revision and affected files for a focused ticket repair. An HTTP response proves reachability only, not login or feature success.`;

export function assertPreviewRuntimePatches(patches: Array<{file:string}> = []): void {
  for (const patch of patches) {
    const path = patch.file.replace(/\\/g, '/');
    const name = path.split('/').pop() || '';
    const runtimeConfig = /^(appsettings(?:\.[\w-]+)?\.json|application(?:-[\w-]+)?\.(?:yml|yaml|properties))$/i.test(name);
    if (path.startsWith('/') || path.split('/').includes('..') || !runtimeConfig) {
      throw new Error(`Preview source patch requires a ticket repair: ${patch.file}. Preserve this saved patch for recovery, integrate the required change through its ticket, then retire the preview patch. It was not replayed.`);
    }
  }
}

// Workflow guard for direct shell publication commands, including git -C and -c.
// Existing shell access is not a security sandbox; policy also forbids indirect publication.
export function previewPublicationBlocked(command: string): boolean {
  return /\bgit\b[^\n;&|]*\b(commit|push|merge|tag|update-ref|commit-tree)\b/i.test(command);
}
