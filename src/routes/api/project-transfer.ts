/**
 * Project export / import — move a single project between environments
 * (e.g. localhost → production). Owner/admin only.
 *
 * Export: GET  /api/projects/:projectId/export  → downloadable JSON bundle.
 * Import: POST /api/projects/import             → recreates the project from a
 *         bundle. DESTRUCTIVE: if a project with the same public id already
 *         exists and is owned by the importer, its data is wiped and replaced
 *         (no merge). Other projects are untouched.
 *
 * Not included: env-var VALUES (encrypted per-server — re-enter on the target),
 * server-specific ticket build state (git branches/PRs), and auth/passwords.
 */
import { Hono } from "hono";
import { requireAuth } from "../../auth/middleware.ts";
import { db } from "../../config/db.ts";
import { projects, projectMembers, projectEnvironmentVariables } from "../../db/schema/projects.ts";
import { ticketStages, projectTickets } from "../../db/schema/tickets.ts";
import { projectFiles } from "../../db/schema/documents.ts";
import { projectPins } from "../../db/schema/pins.ts";
import { conversations, messages } from "../../db/schema/chat.ts";
import { projectActivities } from "../../db/schema/activities.ts";
import { users } from "../../db/schema/users.ts";
import { and, eq, inArray } from "drizzle-orm";
import { getProjectAccess } from "../../auth/project-access.ts";
import { saveContent, getContent } from "../../services/s3.ts";
import type { auth } from "../../auth/index.ts";

type Env = { Variables: { user: typeof auth.$Infer.Session.user } };
const transferApi = new Hono<Env>();
transferApi.use("*", requireAuth as any);

const EXPORT_VERSION = 1;

// ── GET /api/projects/:projectId/export ──────────────────────────────
transferApi.get("/:projectId/export", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();
  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  if (access.role !== "owner" && access.role !== "admin") {
    return c.json({ error: "Only the owner or an admin can export" }, 403);
  }
  const p = access.project;

  const [stages, tickets, files, pins, envVars, convs, acts, members] = await Promise.all([
    db.select().from(ticketStages).where(eq(ticketStages.projectId, p.id)),
    db.select().from(projectTickets).where(eq(projectTickets.projectId, p.id)),
    db.select().from(projectFiles).where(eq(projectFiles.projectId, p.id)),
    db.select().from(projectPins).where(eq(projectPins.projectId, p.id)),
    db.select().from(projectEnvironmentVariables).where(eq(projectEnvironmentVariables.projectId, p.id)),
    db.select().from(conversations).where(eq(conversations.projectId, p.projectId)),
    db.select().from(projectActivities).where(eq(projectActivities.projectId, p.id)),
    db
      .select({ email: users.email, role: projectMembers.role, canEditFiles: projectMembers.canEditFiles, canManageTickets: projectMembers.canManageTickets, canChat: projectMembers.canChat, canInviteMembers: projectMembers.canInviteMembers })
      .from(projectMembers)
      .innerJoin(users, eq(projectMembers.userId, users.id))
      .where(and(eq(projectMembers.projectId, p.id), eq(projectMembers.status, "active"))),
  ]);

  // Messages for all conversations
  const convIds = convs.map((x) => x.id);
  const msgs = convIds.length
    ? await db.select().from(messages).where(inArray(messages.conversationId, convIds))
    : [];

  // Resolve doc content (inline or from S3)
  const documents = await Promise.all(
    files.map(async (f) => ({
      docKey: f.id,
      name: f.name,
      fileType: f.fileType,
      isActive: f.isActive,
      content: await getContent(f.s3Key, f.content),
    }))
  );

  const bundle = {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    project: {
      projectId: p.projectId,
      name: p.name,
      providedName: p.providedName ?? null,
      description: p.description ?? null,
      status: p.status,
      icon: p.icon,
      repoUrl: p.repoUrl ?? null,
      repoOwner: p.repoOwner ?? null,
      repoName: p.repoName ?? null,
      repoProvider: p.repoProvider ?? "github",
      stack: p.stack ?? null,
      ticketCounter: p.ticketCounter ?? 0,
    },
    stages: stages.map((s) => ({ stageKey: s.id, name: s.name, color: s.color, order: s.order, isDefault: s.isDefault, isCompleted: s.isCompleted })),
    tickets: tickets.map((t) => ({
      ticketKey: t.id, stageKey: t.stageId, ticketNumber: t.ticketKey, name: t.name, status: t.status,
      description: t.description, priority: t.priority, role: t.role, details: t.details, uiRequirements: t.uiRequirements,
      componentSpecs: t.componentSpecs, acceptanceCriteria: t.acceptanceCriteria, dependencies: t.dependencies,
      notes: t.notes, executionOrder: t.executionOrder, complexity: t.complexity, requiresWorktree: t.requiresWorktree,
    })),
    documents,
    pins: pins.map((pn) => ({
      targetType: pn.targetType, label: pn.label, order: pn.order, url: pn.url,
      docKey: pn.targetType === "document" ? pn.targetId : null,
      ticketKey: pn.targetType === "ticket" ? pn.targetId : null,
    })),
    conversations: convs.map((cv) => ({ convKey: cv.id, title: cv.title, createdAt: cv.createdAt, updatedAt: cv.updatedAt })),
    messages: msgs.map((mm) => ({ convKey: mm.conversationId, role: mm.role, content: mm.content, contentIfFile: mm.contentIfFile, userRole: mm.userRole, isPartial: mm.isPartial, toolSteps: mm.toolSteps, createdAt: mm.createdAt })),
    activities: acts.map((a) => ({ activityType: a.activityType, title: a.title, description: a.description, metadata: a.metadata, actorType: a.actorType, ticketKey: a.ticketId, createdAt: a.createdAt })),
    members,
    envVars: envVars.map((e) => ({ key: e.key, isSecret: e.isSecret, isRequired: e.isRequired, description: e.description })),
  };

  const safeName = (p.name || "project").replace(/[^a-z0-9-_]+/gi, "-").toLowerCase();
  c.header("Content-Type", "application/json");
  c.header("Content-Disposition", `attachment; filename="lfg-project-${safeName}.json"`);
  return c.body(JSON.stringify(bundle, null, 2));
});

// ── POST /api/projects/import ────────────────────────────────────────
transferApi.post("/import", async (c) => {
  const user = c.get("user");
  const bundle = await c.req.json<any>().catch(() => null);
  if (!bundle?.project?.projectId || !bundle.version) {
    return c.json({ error: "Invalid export file" }, 400);
  }
  const targetPublicId: string = bundle.project.projectId;

  // If a project with this public id already exists, only its owner may
  // wipe & replace it. Otherwise a fresh project is created.
  const [existing] = await db.select().from(projects).where(eq(projects.projectId, targetPublicId));
  if (existing) {
    if (existing.ownerId !== user.id) {
      return c.json({ error: "A project with this id exists and is owned by someone else." }, 403);
    }
    // Wipe: conversations aren't FK'd to projects (they store the public id),
    // so delete them explicitly (messages cascade). The rest cascades on the
    // project delete.
    await db.delete(conversations).where(eq(conversations.projectId, targetPublicId));
    await db.delete(projects).where(eq(projects.id, existing.id));
  }

  // Create the project (same public id → preserves URLs & conversation links)
  const [proj] = await db
    .insert(projects)
    .values({
      projectId: targetPublicId,
      ownerId: user.id,
      name: bundle.project.name ?? "Imported project",
      providedName: bundle.project.providedName ?? undefined,
      description: bundle.project.description ?? undefined,
      status: bundle.project.status ?? "active",
      icon: bundle.project.icon ?? "📋",
      repoUrl: bundle.project.repoUrl ?? undefined,
      repoOwner: bundle.project.repoOwner ?? undefined,
      repoName: bundle.project.repoName ?? undefined,
      repoProvider: bundle.project.repoProvider ?? "github",
      stack: bundle.project.stack ?? undefined,
      ticketCounter: bundle.project.ticketCounter ?? 0,
    })
    .returning();
  if (!proj) return c.json({ error: "Failed to create project" }, 500);

  // Stages
  const stageMap = new Map<string, string>();
  for (const s of bundle.stages ?? []) {
    const [row] = await db.insert(ticketStages).values({ projectId: proj.id, name: s.name, color: s.color, order: s.order, isDefault: s.isDefault, isCompleted: s.isCompleted }).returning();
    if (row) stageMap.set(s.stageKey, row.id);
  }

  // Tickets
  const ticketMap = new Map<string, string>();
  for (const t of bundle.tickets ?? []) {
    const [row] = await db
      .insert(projectTickets)
      .values({
        projectId: proj.id, stageId: t.stageKey ? stageMap.get(t.stageKey) ?? null : null, ticketKey: t.ticketNumber ?? null,
        name: t.name, status: t.status ?? "open", description: t.description ?? "", priority: t.priority ?? "Medium",
        role: t.role ?? "user", details: t.details ?? {}, uiRequirements: t.uiRequirements ?? {}, componentSpecs: t.componentSpecs ?? {},
        acceptanceCriteria: t.acceptanceCriteria ?? [], dependencies: t.dependencies ?? [], notes: t.notes ?? "",
        executionOrder: t.executionOrder ?? 0, complexity: t.complexity ?? "medium", requiresWorktree: t.requiresWorktree ?? true,
      })
      .returning();
    if (row) ticketMap.set(t.ticketKey, row.id);
  }

  // Documents (re-store content via saveContent)
  const docMap = new Map<string, string>();
  for (const d of bundle.documents ?? []) {
    const { s3Key, dbContent } = await saveContent(proj.id, d.fileType, d.name, d.content ?? "");
    const [row] = await db.insert(projectFiles).values({ projectId: proj.id, name: d.name, fileType: d.fileType, content: dbContent, s3Key, isActive: d.isActive ?? true }).returning();
    if (row) docMap.set(d.docKey, row.id);
  }

  // Pins (remap targets)
  for (const pn of bundle.pins ?? []) {
    let targetId: string | null = null;
    if (pn.targetType === "document") targetId = pn.docKey ? docMap.get(pn.docKey) ?? null : null;
    else if (pn.targetType === "ticket") targetId = pn.ticketKey ? ticketMap.get(pn.ticketKey) ?? null : null;
    if (pn.targetType !== "link" && !targetId) continue; // referenced item didn't import
    await db.insert(projectPins).values({ projectId: proj.id, targetType: pn.targetType, targetId, url: pn.url ?? null, label: pn.label, order: pn.order ?? 0, createdBy: user.id });
  }

  // Conversations + messages
  const convMap = new Map<string, string>();
  for (const cv of bundle.conversations ?? []) {
    const [row] = await db
      .insert(conversations)
      .values({ userId: user.id, projectId: targetPublicId, title: cv.title ?? null, createdAt: cv.createdAt ? new Date(cv.createdAt) : undefined, updatedAt: cv.updatedAt ? new Date(cv.updatedAt) : undefined })
      .returning();
    if (row) convMap.set(cv.convKey, row.id);
  }
  for (const mm of bundle.messages ?? []) {
    const convId = convMap.get(mm.convKey);
    if (!convId) continue;
    await db.insert(messages).values({ conversationId: convId, role: mm.role, content: mm.content ?? "", contentIfFile: mm.contentIfFile ?? [], userRole: mm.userRole ?? "default", isPartial: mm.isPartial ?? false, toolSteps: mm.toolSteps ?? null, createdAt: mm.createdAt ? new Date(mm.createdAt) : undefined });
  }

  // Activities
  for (const a of bundle.activities ?? []) {
    await db.insert(projectActivities).values({ projectId: proj.id, ticketId: a.ticketKey ? ticketMap.get(a.ticketKey) ?? null : null, activityType: a.activityType, title: a.title, description: a.description ?? null, metadata: a.metadata ?? null, actorType: a.actorType ?? "system", createdAt: a.createdAt ? new Date(a.createdAt) : undefined });
  }

  // Members (re-link by email if the user exists on this server)
  let membersLinked = 0;
  for (const m of bundle.members ?? []) {
    if (!m.email) continue;
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, m.email));
    if (!u || u.id === user.id) continue;
    await db.insert(projectMembers).values({ projectId: proj.id, userId: u.id, role: m.role ?? "member", status: "active", canEditFiles: m.canEditFiles ?? true, canManageTickets: m.canManageTickets ?? true, canChat: m.canChat ?? true, canInviteMembers: m.canInviteMembers ?? false, invitedById: user.id });
    membersLinked++;
  }

  // Env vars (metadata only — values must be re-entered)
  for (const e of bundle.envVars ?? []) {
    await db.insert(projectEnvironmentVariables).values({ projectId: proj.id, key: e.key, encryptedValue: "", isSecret: e.isSecret ?? true, isRequired: e.isRequired ?? false, hasValue: false, description: e.description ?? "", createdById: user.id });
  }

  return c.json({
    ok: true,
    projectId: targetPublicId,
    replaced: !!existing,
    counts: {
      stages: stageMap.size, tickets: ticketMap.size, documents: docMap.size,
      conversations: convMap.size, membersLinked, envVars: (bundle.envVars ?? []).length,
    },
  });
});

export default transferApi;
