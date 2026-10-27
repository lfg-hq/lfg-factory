import { desc, eq, inArray } from 'drizzle-orm';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { db } from '../config/db.ts';
import { chatFiles, messages } from '../db/schema/chat.ts';
import { projectTicketAttachments } from '../db/schema/tickets.ts';
import { execOnWorkspace } from './mags.ts';
import { shellQuote } from './ticket-code.ts';

/**
 * Screenshots reach the ticket agent. The user's chat images are attached to the ticket the
 * main agent creates or sends work to, and before a build or follow-up they are copied into
 * the sandbox as files (outside the repository) that the coding agent opens. A link to
 * /api/files is useless there: it needs the user's login.
 */
const chatFileId = (filePath: string) => filePath.match(/^\/api\/files\/([\w-]+)$/)?.[1] ?? null;
const isImage = (type?: string | null) => !type || type.startsWith('image/');

/** Image ids the user attached to this chat turn (their message). */
export async function turnImageIds(turnId?: string | null): Promise<string[]> {
  if (!turnId) return [];
  const [row] = await db.select({ files: messages.contentIfFile }).from(messages).where(eq(messages.id, turnId)).catch(() => []);
  const files = Array.isArray(row?.files) ? row.files as { id?: string; type?: string }[] : [];
  return files.filter(f => f?.id && String(f.type ?? '').startsWith('image/')).map(f => String(f.id));
}

/** Attach chat images to a ticket, skipping ones already attached. Returns how many were added. */
export async function attachImagesToTicket(ticketId: string, imageIds: string[]): Promise<number> {
  const ids = [...new Set(imageIds.filter(Boolean))];
  if (!ids.length) return 0;
  const files = await db.select().from(chatFiles).where(inArray(chatFiles.id, ids));
  const existing = new Set((await db.select({ filePath: projectTicketAttachments.filePath }).from(projectTicketAttachments)
    .where(eq(projectTicketAttachments.ticketId, ticketId))).map(r => r.filePath));
  const rows = files.filter(f => isImage(f.fileType) && !existing.has(`/api/files/${f.id}`)).map(f => ({
    ticketId, filePath: `/api/files/${f.id}`, originalFilename: f.originalFilename ?? 'image', fileType: f.fileType ?? '', fileSize: f.fileSize ?? 0,
  }));
  if (rows.length) await db.insert(projectTicketAttachments).values(rows);
  return rows.length;
}

/** Attach the images from this chat turn to a ticket; never fails the caller. */
export async function attachTurnImages(ticketId: string, turnId?: string | null): Promise<number> {
  try { return await attachImagesToTicket(ticketId, await turnImageIds(turnId)); }
  catch (error) {
    console.warn('[ticket-images] attach failed', (error as Error).message?.slice(0, 120));
    return 0;
  }
}

const safeName = (name: string, index: number) => {
  const base = name.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'image';
  return `${String(index + 1).padStart(2, '0')}-${/\.(png|jpe?g|gif|webp)$/i.test(base) ? base : base + '.png'}`;
};

/** Put one stored chat image into the sandbox: a short-lived signed download in production, chunks locally. */
async function copyIntoSandbox(workspaceId: string, fileId: string, target: string): Promise<boolean> {
  const [file] = await db.select().from(chatFiles).where(eq(chatFiles.id, fileId));
  if (!file?.filePath) return false;
  if (file.filePath.startsWith('s3:')) {
    const { getPresignedGetUrl } = await import('./s3.ts');
    const url = await getPresignedGetUrl(file.filePath.slice(3), 600);
    const r = await execOnWorkspace(workspaceId, `curl -fsSL --max-time 60 -o ${shellQuote(target)} ${shellQuote(url)} && test -s ${shellQuote(target)}`, { timeout: 75_000 });
    return r.exitCode === 0;
  }
  const bytes = await fs.readFile(path.resolve(file.filePath)).catch(() => null);
  if (!bytes) return false;
  const b64 = bytes.toString('base64'), temp = target + '.b64';
  await execOnWorkspace(workspaceId, `: > ${shellQuote(temp)}`, { timeout: 15_000 });
  for (let i = 0; i < b64.length; i += 100_000) {
    const r = await execOnWorkspace(workspaceId, `printf %s ${shellQuote(b64.slice(i, i + 100_000))} >> ${shellQuote(temp)}`, { timeout: 30_000 });
    if (r.exitCode !== 0) return false;
  }
  const r = await execOnWorkspace(workspaceId, `base64 -d ${shellQuote(temp)} > ${shellQuote(target)} && rm -f ${shellQuote(temp)}`, { timeout: 30_000 });
  return r.exitCode === 0;
}

/**
 * Copy the ticket's newest screenshots into the sandbox and return the prompt section that
 * tells the agent to open them ('' when there are none or copying failed).
 */
export async function ticketImagesBlock(ticketId: string, workspaceId: string, limit = 6): Promise<string> {
  try {
    const rows = (await db.select().from(projectTicketAttachments).where(eq(projectTicketAttachments.ticketId, ticketId))
      .orderBy(desc(projectTicketAttachments.uploadedAt)).limit(20)).filter(r => isImage(r.fileType)).slice(0, limit);
    if (!rows.length) return '';
    const dir = `/data/lfg-attachments/${ticketId.slice(0, 12)}`;
    await execOnWorkspace(workspaceId, `mkdir -p ${shellQuote(dir)}`, { timeout: 15_000 });
    const lines: string[] = [];
    for (const [index, row] of rows.entries()) {
      const id = chatFileId(row.filePath);
      const target = `${dir}/${safeName(row.originalFilename || 'image', index)}`;
      const copied = id ? await copyIntoSandbox(workspaceId, id, target).catch(() => false)
        : /^https?:\/\//.test(row.filePath) ? (await execOnWorkspace(workspaceId, `curl -fsSL --max-time 60 -o ${shellQuote(target)} ${shellQuote(row.filePath)}`, { timeout: 75_000 }).catch(() => null))?.exitCode === 0 : false;
      if (copied) lines.push(`- ${target} (added ${row.uploadedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC)`);
    }
    if (!lines.length) return '';
    return `\n## Screenshots from the user\nThe user attached these screenshots to this ticket, newest first. Open each image file and look at it before changing anything: it shows what the user actually sees. They are outside the repository; never commit them.\n${lines.join('\n')}\n`;
  } catch (error) {
    console.warn('[ticket-images] could not copy screenshots', (error as Error).message?.slice(0, 120));
    return '';
  }
}

export const __test = { chatFileId, safeName };
