import type { ConfigPatch } from './app-profile.ts';

/** Replace the entire recipe, never append a repair behind an obsolete patch. */
export async function replaceVerifiedPatches(patches: ConfigPatch[], io: {
  verifyClean: (patches:ConfigPatch[])=>Promise<void>;
  verifyCurrent: (patches:ConfigPatch[])=>Promise<void>;
  save: (patches:ConfigPatch[])=>Promise<void>;
}) {
  const files=new Set<string>();
  for (const patch of patches) {
    if (files.has(patch.file)) throw new Error('Consolidate replacements into one patch per file: '+patch.file);
    files.add(patch.file);
    if (!patch.replace) throw new Error('Deletion-only patches need surrounding unchanged text in both find and replace so replay can verify them.');
  }
  await io.verifyClean(patches);
  await io.verifyCurrent(patches);
  await io.save(patches);
}
