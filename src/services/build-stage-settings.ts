export type BuildStageSettings = { validationEnabled?: boolean; featureTestingEnabled?: boolean };
export type TicketChecksMode = 'on' | 'off' | 'project';

/** A ticket's own choice wins over the project's: 'on'/'off' set both checks, 'project' inherits. */
export function ticketChecksMode(details: unknown): TicketChecksMode {
  const mode = (details as { checks?: unknown } | null)?.checks;
  return mode === 'on' || mode === 'off' ? mode : 'project';
}
export function applyTicketChecks(settings: BuildStageSettings, mode: TicketChecksMode): BuildStageSettings {
  return mode === 'project' ? settings : { validationEnabled: mode === 'on', featureTestingEnabled: mode === 'on' };
}

/** Missing values preserve the existing workflow. Read once per run. */
export async function loadBuildStageSettings(projectId: string, ticketId?: string): Promise<BuildStageSettings> {
  const [{db}, {projects}, {eq}] = await Promise.all([
    import('../config/db.ts'), import('../db/schema/projects.ts'), import('drizzle-orm'),
  ]);
  const [project] = await db.select({
    validationEnabled: projects.validationEnabled,
    featureTestingEnabled: projects.featureTestingEnabled,
  }).from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) throw new Error('Project not found while loading build checks');
  if (!ticketId) return project;
  const { projectTickets } = await import('../db/schema/tickets.ts');
  const [ticket] = await db.select({ details: projectTickets.details }).from(projectTickets).where(eq(projectTickets.id, ticketId)).limit(1);
  return applyTicketChecks(project, ticketChecksMode(ticket?.details));
}
