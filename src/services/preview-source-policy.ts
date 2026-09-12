/** Preview repairs are an overlay on Git, never a publication operation. */
export const PREVIEW_SOURCE_POLICY = `Source repairs are allowed in BOTH the default preview checkout and ticket previews, including .NET/Linux asset casing fixes. Keep repairs minimal. Persist every source/config edit with persistConfigPatch and its reason; use addDirective for the general rule that must be remembered. Saved branch-scoped patches are the durable replay overlay: reload fetches Git then reapplies and verifies them. Do not rely on a local git stash, and never commit, push, merge, tag or update Git refs from preview recovery. Do not switch branches. After repairing asset references, verify the URLs actually used by the repaired HTML and remove obsolete wrong-case asset URLs from verificationPaths while preserving real feature routes. Never create duplicate case aliases. Rebuild and verify before reporting success. Normal ticket implementation commits are a separate workflow.`;

// Workflow guard for direct shell publication commands, including git -C and -c.
// Existing shell access is not a security sandbox; policy also forbids indirect publication.
export function previewPublicationBlocked(command: string): boolean {
  return /\bgit\b[^\n;&|]*\b(commit|push|merge|tag|update-ref|commit-tree)\b/i.test(command);
}
