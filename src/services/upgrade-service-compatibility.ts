import type { AppProfile } from './app-profile.ts';
type Mapping = AppProfile['databases'][number];
const target = (d: Mapping) => `${d.engine}/${d.databaseName ?? 'app'} (${d.connectionFormat})`;

/** Candidate services must still support every baseline connection; additions are safe. */
export function upgradeServiceConflicts(baseline: Mapping[], candidate: Mapping[]): string[] {
  const conflicts: string[] = [];
  for (const [label, mappings] of [['baseline', baseline], ['candidate', candidate]] as const) {
    const keys = new Set<string>();
    for (const mapping of mappings) {
      if (keys.has(mapping.connectionEnvVar)) conflicts.push(`${label} has duplicate connection key ${mapping.connectionEnvVar}`);
      keys.add(mapping.connectionEnvVar);
    }
  }
  for (const previous of baseline) {
    const next = candidate.find(d => d.connectionEnvVar === previous.connectionEnvVar);
    if (!next) conflicts.push(`${previous.connectionEnvVar}: baseline requires ${target(previous)}, but candidate omits this connection`);
    else if (target(previous) !== target(next)) conflicts.push(`${previous.connectionEnvVar}: baseline requires ${target(previous)}, candidate provides ${target(next)}`);
  }
  return conflicts;
}
