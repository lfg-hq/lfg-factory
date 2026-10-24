/**
 * Documentation sync: publishes a project's documents into the knowledge bases
 * a user has connected through Composio (Notion, Google Docs, Confluence, …).
 *
 * Each provider knows how to create a remote copy and how to update it later.
 * document_sync_link remembers the remote copy, so a re-sync overwrites it
 * rather than creating a duplicate. Sync is one-way: LFG → knowledge base.
 */
import { and, eq, inArray, or } from "drizzle-orm";
import { createHash } from "node:crypto";
import { marked } from "marked";
import { db } from "../config/db.ts";
import { documentSyncLinks, documentSyncTargets } from "../db/schema/document-sync.ts";
import { projectFiles } from "../db/schema/documents.ts";
import { projects } from "../db/schema/projects.ts";
import { getContent } from "./s3.ts";
import { getComposioInstance, isComposioConfigured } from "./composio-manager.ts";

type Exec = (slug: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
interface PushInput { exec: Exec; title: string; fileName: string; markdown: string; destination: string; remoteId: string | null }
interface PushResult { remoteId: string; remoteUrl?: string | null; remoteVersion?: number | null }

export interface SyncProvider {
  key: string;
  name: string;
  toolkit: string; // Composio toolkit slug
  icon: string; // Font Awesome class
  color: string;
  description: string;
  destinationLabel: string;
  destinationPlaceholder: string;
  destinationRequired: boolean;
  push(input: PushInput): Promise<PushResult>;
}

// ── Response helpers ─────────────────────────────────────────────────

/** First string value found under any of `keys`, searching breadth-first. */
function pick(value: unknown, keys: string[]): string | undefined {
  const queue: unknown[] = [value];
  for (let seen = 0; queue.length && seen < 200; seen++) {
    const node = queue.shift();
    if (!node || typeof node !== "object") continue;
    const obj = node as Record<string, unknown>;
    for (const key of keys) {
      const v = obj[key];
      if (typeof v === "string" && v) return v;
      if (typeof v === "number") return String(v);
    }
    queue.push(...Object.values(obj).filter((v) => v && typeof v === "object"));
  }
  return undefined;
}

const httpUrl = (value: string | undefined) => (value && /^https?:\/\//i.test(value) ? value : null);

/** Accepts a bare ID or the URL a user copies from the app's address bar. */
function notionId(value: string) {
  const hex = value.replace(/-/g, "").match(/[0-9a-f]{32}(?=[^0-9a-f]*$)/i)?.[0];
  return hex ?? value.trim();
}
const driveFolderId = (value: string) => value.match(/\/folders\/([\w-]+)/)?.[1] ?? value.trim();
const codaDocId = (value: string) => value.match(/coda\.io\/d\/[^/?#]*_d([\w-]+)/)?.[1] ?? value.trim();

/** Confluence storage format is XHTML: void elements must self-close. */
function confluenceStorage(markdown: string) {
  const html = marked.parse(markdown, { async: false }) as string;
  return html.replace(/<(br|hr|img|input)([^>]*?)\s*\/?>/gi, "<$1$2 />");
}

// ── Providers ────────────────────────────────────────────────────────

export const SYNC_PROVIDERS: SyncProvider[] = [
  {
    key: "NOTION", name: "Notion", toolkit: "notion", icon: "fas fa-book", color: "#787774",
    description: "Each document becomes a page under a parent page you choose.",
    destinationLabel: "Parent page", destinationPlaceholder: "Notion page URL or ID", destinationRequired: true,
    async push({ exec, title, markdown, destination, remoteId }) {
      if (remoteId) {
        await exec("NOTION_UPDATE_PAGE_MARKDOWN", { page_id: remoteId, type: "replace_content", replace_content: { new_str: markdown } });
        return { remoteId };
      }
      const data = await exec("NOTION_CREATE_NOTION_PAGE", { parent_id: notionId(destination), title, markdown });
      const id = pick(data, ["id", "page_id"]);
      if (!id) throw new Error("Notion did not return the new page");
      return { remoteId: id, remoteUrl: httpUrl(pick(data, ["url", "public_url"])) ?? `https://www.notion.so/${id.replace(/-/g, "")}` };
    },
  },
  {
    key: "GOOGLEDOCS", name: "Google Docs", toolkit: "googledocs", icon: "fas fa-file-lines", color: "#4285f4",
    description: "Each document becomes a formatted Google Doc in your Drive.",
    destinationLabel: "", destinationPlaceholder: "", destinationRequired: false,
    async push({ exec, title, markdown, remoteId }) {
      if (remoteId) {
        await exec("GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN", { id: remoteId, markdown });
        return { remoteId, remoteUrl: `https://docs.google.com/document/d/${remoteId}/edit` };
      }
      const data = await exec("GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN", { title, markdown_text: markdown });
      const id = pick(data, ["documentId", "document_id", "id"]);
      if (!id) throw new Error("Google Docs did not return the new document");
      return { remoteId: id, remoteUrl: `https://docs.google.com/document/d/${id}/edit` };
    },
  },
  {
    key: "GOOGLEDRIVE", name: "Google Drive", toolkit: "googledrive", icon: "fab fa-google-drive", color: "#0f9d58",
    description: "Each document is saved as a Markdown file in a Drive folder.",
    destinationLabel: "Folder", destinationPlaceholder: "Folder URL or ID (optional — My Drive by default)", destinationRequired: false,
    async push({ exec, fileName, markdown, destination, remoteId }) {
      if (remoteId) {
        await exec("GOOGLEDRIVE_EDIT_FILE", { file_id: remoteId, content: markdown, mime_type: "text/markdown" });
        return { remoteId, remoteUrl: `https://drive.google.com/file/d/${remoteId}/view` };
      }
      const data = await exec("GOOGLEDRIVE_CREATE_FILE_FROM_TEXT", {
        file_name: fileName, text_content: markdown, mime_type: "text/markdown",
        ...(destination ? { parent_id: driveFolderId(destination) } : {}),
      });
      const id = pick(data, ["id", "fileId", "file_id"]);
      if (!id) throw new Error("Google Drive did not return the new file");
      return { remoteId: id, remoteUrl: httpUrl(pick(data, ["webViewLink"])) ?? `https://drive.google.com/file/d/${id}/view` };
    },
  },
  {
    key: "CONFLUENCE", name: "Confluence", toolkit: "confluence", icon: "fab fa-confluence", color: "#1868db",
    description: "Each document becomes a page in a Confluence space.",
    destinationLabel: "Space", destinationPlaceholder: "Space key, e.g. ENG", destinationRequired: true,
    async push({ exec, title, markdown, destination, remoteId }) {
      const value = confluenceStorage(markdown);
      if (remoteId) {
        // Confluence auto-detects the next version number when it is omitted.
        const data = await exec("CONFLUENCE_UPDATE_PAGE", { id: remoteId, title, body: { value, representation: "storage" }, version: { message: "Synced from LFG" } });
        return { remoteId, remoteVersion: Number(pick(data, ["number"])) || null };
      }
      const data = await exec("CONFLUENCE_CREATE_PAGE", { spaceId: destination.trim(), title, body: { storage: { value, representation: "storage" } } });
      const id = pick(data, ["id"]);
      if (!id) throw new Error("Confluence did not return the new page");
      const base = pick(data, ["base"]), webui = pick(data, ["webui"]);
      return { remoteId: id, remoteUrl: base && webui ? base + webui : null, remoteVersion: Number(pick(data, ["number"])) || 1 };
    },
  },
  {
    key: "SHARE_POINT", name: "SharePoint", toolkit: "share_point", icon: "fab fa-microsoft", color: "#038387",
    description: "Each document is saved as a Markdown file in a document library folder.",
    destinationLabel: "Folder", destinationPlaceholder: "/Shared Documents/Product", destinationRequired: true,
    async push({ exec, fileName, markdown, destination }) {
      // Uploading by name with overwrite is already idempotent.
      const data = await exec("SHARE_POINT_UPLOAD_FILE", { folder_relative_url: destination.trim(), file_name: fileName, content_text: markdown, overwrite: true });
      return { remoteId: pick(data, ["UniqueId", "id"]) ?? fileName, remoteUrl: httpUrl(pick(data, ["LinkingUrl", "webUrl"])) };
    },
  },
  {
    key: "ONE_DRIVE", name: "OneDrive", toolkit: "one_drive", icon: "fas fa-cloud", color: "#0078d4",
    description: "Each document is saved as a Markdown file in a OneDrive folder.",
    destinationLabel: "Folder", destinationPlaceholder: "/Documents/LFG (optional — root by default)", destinationRequired: false,
    async push({ exec, fileName, markdown, destination }) {
      const data = await exec("ONE_DRIVE_ONEDRIVE_CREATE_TEXT_FILE", { name: fileName, content: markdown, folder: destination.trim() || "/", conflict_behavior: "replace" });
      return { remoteId: pick(data, ["id"]) ?? fileName, remoteUrl: httpUrl(pick(data, ["webUrl"])) };
    },
  },
  {
    key: "CODA", name: "Coda", toolkit: "coda", icon: "fas fa-table-cells", color: "#f46a54",
    description: "Each document becomes a page in a Coda doc.",
    destinationLabel: "Doc", destinationPlaceholder: "Coda doc URL or ID", destinationRequired: true,
    async push({ exec, title, markdown, destination, remoteId }) {
      const docId = codaDocId(destination);
      const canvasContent = { format: "markdown", content: markdown };
      if (remoteId) {
        await exec("CODA_UPDATE_A_PAGE", { docId, pageIdOrName: remoteId, contentUpdate: { insertionMode: "replace", canvasContent } });
        return { remoteId };
      }
      const data = await exec("CODA_CREATE_A_PAGE", { docId, name: title, pageContent: { type: "canvas", canvasContent } });
      const id = pick(data, ["id"]);
      if (!id) throw new Error("Coda did not return the new page");
      return { remoteId: id, remoteUrl: httpUrl(pick(data, ["browserLink"])) };
    },
  },
];

export const syncProvider = (key: string) => SYNC_PROVIDERS.find((p) => p.key === key.toUpperCase());

// ── Connection state ─────────────────────────────────────────────────

const connectedCache = new Map<string, { at: number; value: Promise<Set<string>> }>();

/** Composio toolkit slugs (lowercase) the user has a live connection for. */
export function connectedToolkits(userId: string, fresh = false): Promise<Set<string>> {
  const cached = connectedCache.get(userId);
  if (!fresh && cached && Date.now() - cached.at < 60_000) return cached.value;
  const composio = getComposioInstance();
  const value = (async () => {
    if (!composio) return new Set<string>();
    const result: any = await composio.connectedAccounts.list({
      userIds: [userId], statuses: ["ACTIVE"], toolkitSlugs: SYNC_PROVIDERS.map((p) => p.toolkit), limit: 50,
    });
    return new Set<string>((result?.items ?? []).map((a: any) => String(a.toolkit?.slug ?? "").toLowerCase()).filter(Boolean));
  })().catch((err) => {
    console.warn("[document-sync] connection lookup failed", (err as Error).message);
    return new Set<string>();
  });
  connectedCache.set(userId, { at: Date.now(), value });
  return value;
}

export async function syncTargetsFor(userId: string) {
  const [targets, connected] = await Promise.all([
    db.select().from(documentSyncTargets).where(eq(documentSyncTargets.userId, userId)),
    isComposioConfigured() ? connectedToolkits(userId) : Promise.resolve(new Set<string>()),
  ]);
  return SYNC_PROVIDERS.map((p) => {
    const target = targets.find((t) => t.provider === p.key);
    const isConnected = connected.has(p.toolkit);
    return {
      key: p.key, name: p.name, icon: p.icon, color: p.color, description: p.description,
      destinationLabel: p.destinationLabel, destinationPlaceholder: p.destinationPlaceholder, destinationRequired: p.destinationRequired,
      connected: isConnected,
      destination: target?.destination ?? "",
      autoSync: !!target?.autoSync,
      lastSyncedAt: target?.lastSyncedAt ?? null,
      lastError: target?.lastError ?? null,
      // Ready = a manual sync would actually go somewhere.
      ready: isConnected && (!p.destinationRequired || !!target?.destination?.trim()),
    };
  });
}

export async function saveSyncTarget(userId: string, providerKey: string, input: { destination?: string; autoSync?: boolean }) {
  const provider = syncProvider(providerKey);
  if (!provider) throw new Error("Unknown provider");
  const set: Record<string, unknown> = {};
  if (input.destination !== undefined) set.destination = input.destination.trim().slice(0, 500);
  if (input.autoSync !== undefined) set.autoSync = input.autoSync;
  await db.insert(documentSyncTargets).values({ userId, provider: provider.key, destination: "", autoSync: false, ...set })
    .onConflictDoUpdate({ target: [documentSyncTargets.userId, documentSyncTargets.provider], set });
  // A new destination means new remote copies; old links point somewhere else.
  if (input.destination !== undefined) {
    await db.update(documentSyncLinks).set({ remoteId: null, remoteUrl: null, remoteVersion: null, contentHash: null, syncedAt: null })
      .where(and(eq(documentSyncLinks.userId, userId), eq(documentSyncLinks.provider, provider.key)));
  }
}

// ── Syncing ──────────────────────────────────────────────────────────

const SKIPPED_TYPES = ["design_baseline", "page_preview"];
const running = new Set<string>();

async function executor(userId: string): Promise<Exec> {
  const composio = getComposioInstance();
  if (!composio) throw new Error("Composio is not configured");
  const session: any = await composio.create(userId, { manageConnections: true });
  return async (slug, args) => {
    const result = await session.execute(slug, args);
    const data = (result?.data ?? {}) as Record<string, unknown>;
    if (result?.error || data.successful === false || (data.error && typeof data.error === "string")) {
      throw new Error(String(result?.error || data.error || "The provider rejected the request").slice(0, 300));
    }
    // Some tools nest their payload one level down under data.
    return (data.data && typeof data.data === "object" ? data.data : data) as Record<string, unknown>;
  };
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|#%]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 150) || "Untitled";

export interface SyncOutcome { provider: string; synced: number; unchanged: number; failed: number; errors: string[] }

/**
 * Push a project's documents to each requested provider. Unchanged documents
 * (same content hash as the last push) are skipped unless `force` is set.
 */
export async function syncProjectDocuments(
  userId: string,
  project: typeof projects.$inferSelect,
  options: { providers?: string[]; fileIds?: string[]; force?: boolean; onlyStale?: boolean } = {},
): Promise<SyncOutcome[]> {
  const lock = `${userId}:${project.id}`;
  if (running.has(lock)) throw new Error("A sync for this project is already running");
  running.add(lock);
  try {
    const targets = (await syncTargetsFor(userId)).filter((t) => t.ready && (!options.providers || options.providers.includes(t.key)));
    if (!targets.length) return [];
    const files = (await db.select().from(projectFiles).where(and(
      eq(projectFiles.projectId, project.id), eq(projectFiles.isActive, true),
      ...(options.fileIds?.length ? [inArray(projectFiles.id, options.fileIds)] : []),
    ))).filter((f) => !SKIPPED_TYPES.includes(f.fileType));
    if (!files.length) return targets.map((t) => ({ provider: t.key, synced: 0, unchanged: 0, failed: 0, errors: [] }));

    const links = await db.select().from(documentSyncLinks).where(and(
      eq(documentSyncLinks.userId, userId), inArray(documentSyncLinks.fileId, files.map((f) => f.id)),
    ));
    const exec = await executor(userId);
    const contents = new Map<string, Promise<string>>();
    const read = (f: typeof files[number]) => {
      if (!contents.has(f.id)) contents.set(f.id, getContent(f.s3Key, f.content));
      return contents.get(f.id)!;
    };

    const outcomes: SyncOutcome[] = [];
    for (const target of targets) {
      const provider = syncProvider(target.key)!;
      const outcome: SyncOutcome = { provider: provider.key, synced: 0, unchanged: 0, failed: 0, errors: [] };
      for (const file of files) {
        const link = links.find((l) => l.provider === provider.key && l.fileId === file.id);
        if (options.onlyStale && link?.syncedAt && link.remoteId && new Date(file.updatedAt).getTime() <= link.syncedAt) { outcome.unchanged++; continue; }
        const markdown = await read(file);
        if (!markdown.trim()) { outcome.unchanged++; continue; }
        const hash = createHash("sha256").update(file.name + "\0" + markdown).digest("hex");
        if (!options.force && link?.remoteId && link.contentHash === hash) { outcome.unchanged++; continue; }
        const title = safeName(`${project.name} — ${file.name}`);
        try {
          const result = await provider.push({ exec, title, fileName: `${title}.md`, markdown, destination: target.destination, remoteId: link?.remoteId ?? null });
          const fields = { remoteId: result.remoteId, remoteUrl: result.remoteUrl ?? link?.remoteUrl ?? null, remoteVersion: result.remoteVersion ?? null, contentHash: hash, syncedAt: Date.now(), error: null };
          await db.insert(documentSyncLinks).values({ userId, provider: provider.key, fileId: file.id, ...fields })
            .onConflictDoUpdate({ target: [documentSyncLinks.userId, documentSyncLinks.provider, documentSyncLinks.fileId], set: fields });
          outcome.synced++;
        } catch (err) {
          const message = (err as Error).message || "Sync failed";
          outcome.failed++;
          if (outcome.errors.length < 3) outcome.errors.push(`${file.name}: ${message}`);
          await db.insert(documentSyncLinks).values({ userId, provider: provider.key, fileId: file.id, error: message })
            .onConflictDoUpdate({ target: [documentSyncLinks.userId, documentSyncLinks.provider, documentSyncLinks.fileId], set: { error: message } });
        }
      }
      await db.update(documentSyncTargets).set({ lastSyncedAt: Date.now(), lastError: outcome.errors[0] ?? null })
        .where(and(eq(documentSyncTargets.userId, userId), eq(documentSyncTargets.provider, provider.key)));
      outcomes.push(outcome);
    }
    return outcomes;
  } finally {
    running.delete(lock);
  }
}

/** Per-document sync state for a project, for the Documents panel. */
export async function projectSyncStatus(userId: string, project: typeof projects.$inferSelect) {
  const [targets, files] = await Promise.all([
    syncTargetsFor(userId),
    db.select({ id: projectFiles.id, name: projectFiles.name, fileType: projectFiles.fileType, updatedAt: projectFiles.updatedAt })
      .from(projectFiles).where(and(eq(projectFiles.projectId, project.id), eq(projectFiles.isActive, true))),
  ]);
  const docs = files.filter((f) => !SKIPPED_TYPES.includes(f.fileType));
  const links = docs.length ? await db.select().from(documentSyncLinks).where(and(
    eq(documentSyncLinks.userId, userId), inArray(documentSyncLinks.fileId, docs.map((f) => f.id)),
  )) : [];
  return {
    configured: isComposioConfigured(),
    providers: targets.map((t) => {
      const mine = links.filter((l) => l.provider === t.key);
      const synced = docs.filter((d) => mine.some((l) => l.fileId === d.id && l.remoteId && l.syncedAt && l.syncedAt >= new Date(d.updatedAt).getTime()));
      return {
        key: t.key, name: t.name, icon: t.icon, color: t.color, connected: t.connected, ready: t.ready, autoSync: t.autoSync,
        destination: t.destination, destinationLabel: t.destinationLabel,
        total: docs.length, upToDate: synced.length,
        lastSyncedAt: mine.reduce((max, l) => Math.max(max, l.syncedAt ?? 0), 0) || null,
        errors: mine.filter((l) => l.error).slice(0, 3).map((l) => ({ name: docs.find((d) => d.id === l.fileId)?.name ?? "Document", error: l.error })),
        documents: mine.filter((l) => l.remoteUrl).map((l) => ({ fileId: l.fileId, url: l.remoteUrl })),
      };
    }),
  };
}

// ── Auto sync worker ─────────────────────────────────────────────────

let ticking = false;
export async function runAutoSync() {
  if (ticking || !isComposioConfigured()) return;
  ticking = true;
  try {
    const targets = await db.select().from(documentSyncTargets).where(eq(documentSyncTargets.autoSync, true));
    for (const userId of new Set(targets.map((t) => t.userId))) {
      const providers = targets.filter((t) => t.userId === userId).map((t) => t.provider);
      // Projects the user owns, plus any shared project they have already synced.
      const linked = await db.selectDistinct({ projectId: projectFiles.projectId }).from(documentSyncLinks)
        .innerJoin(projectFiles, eq(documentSyncLinks.fileId, projectFiles.id)).where(eq(documentSyncLinks.userId, userId));
      const rows = await db.select().from(projects).where(or(
        eq(projects.ownerId, userId),
        ...(linked.length ? [inArray(projects.id, linked.map((l) => l.projectId))] : []),
      ));
      for (const project of rows) {
        try { await syncProjectDocuments(userId, project, { providers, onlyStale: true }); }
        catch (err) { console.warn("[document-sync] auto sync skipped", project.id, (err as Error).message); }
      }
    }
  } finally {
    ticking = false;
  }
}

let started = false;
export function registerDocumentSyncWorker() {
  if (started) return;
  started = true;
  const tick = () => void runAutoSync().catch((e) => console.warn("[document-sync] worker unavailable", (e as Error).message));
  setInterval(tick, 5 * 60_000).unref();
  setTimeout(tick, 30_000).unref();
}
