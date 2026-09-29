import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../config/db.ts';
import { projectFiles } from '../db/schema/documents.ts';
import { getContent } from './s3.ts';

/** Validate the entire batch before creating tickets; never silently omit a screen. */
export async function readApprovedDesigns(projectId: string, ids: string[]) {
  const uniqueIds = [...new Set(ids)];
  if (!uniqueIds.length) return [];
  const rows = await db.select().from(projectFiles).where(and(
    eq(projectFiles.projectId, projectId), inArray(projectFiles.id, uniqueIds),
  ));
  return Promise.all(uniqueIds.map(async (id) => {
    const row = rows.find((item) => item.id === id);
    if (!row || row.fileType !== 'page_preview') throw new Error(`Approved design ${id} is not a preview in this project.`);
    const content = await getContent(row.s3Key, row.content);
    if (!content?.trim() || content.length > 400_000) throw new Error(`Approved design ${id} is empty or too large. Refresh it before creating tickets.`);
    return { id, name: row.name, content };
  }));
}

export function approvedDesignReferences(designs: Array<{ id: string; name: string }>) {
  if (!designs.length) return '';
  return '\n\n## Accepted design files\n' + designs.map((design) =>
    `- Approved design preview: document ${design.id} (${JSON.stringify(design.name)}) — match this screen and its interactions.`
  ).join('\n');
}
