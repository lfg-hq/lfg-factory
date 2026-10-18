export type BuildStageSettings = { validationEnabled?: boolean; featureTestingEnabled?: boolean };

/** Missing values preserve the existing workflow. Read once per run. */
export async function loadBuildStageSettings(projectId: string): Promise<BuildStageSettings> {
  const [{db}, {projects}, {eq}] = await Promise.all([
    import('../config/db.ts'), import('../db/schema/projects.ts'), import('drizzle-orm'),
  ]);
  const [project] = await db.select({
    validationEnabled: projects.validationEnabled,
    featureTestingEnabled: projects.featureTestingEnabled,
  }).from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) throw new Error('Project not found while loading build checks');
  return project;
}
