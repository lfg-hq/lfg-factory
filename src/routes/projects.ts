import { Hono } from "hono";
import { requireAuth } from "../auth/middleware.ts";
import { db } from "../config/db.ts";
import {
  projects,
  projectMembers,
  projectEnvironmentVariables,
  projectInvitations,
} from "../db/schema/projects.ts";
import { llmApiKeys, profiles, users } from "../db/schema/users.ts";
import { projectFiles, projectFileVersions } from "../db/schema/documents.ts";
import { conversations } from "../db/schema/chat.ts";
import { ticketStages, projectTickets, projectTicketAttachments } from "../db/schema/tickets.ts";
import { cleanupTicketWorktree } from "../workers/ticket-executor.ts";
import { applicationState, githubTokens, gitlabTokens } from "../db/schema/users.ts";
import { instantApps } from "../db/schema/instant.ts";
import { env } from "../config/env.ts";
import { agents } from "../db/schema/agents.ts";
import { notifications } from "../db/schema/notifications.ts";
import { eq, and, desc, asc, notExists, or, sql, inArray, isNull, ne } from "drizzle-orm";
import { listModels } from "../ai/provider.ts";
import { saveContent, getContent, deleteContent } from "../services/s3.ts";
import { getProjectActivities } from "../services/activity-log.ts";
import { ProjectListPage } from "../templates/pages/project-list.tsx";
import { ProjectDetailPage } from "../templates/pages/project-detail.tsx";
import { TicketsListPage } from "../templates/pages/tickets-list.tsx";
import { epics } from "../db/schema/epics.ts";
import { getProjectAccess, requirePermission, PermissionError } from "../auth/project-access.ts";
import type { auth } from "../auth/index.ts";

// Parse a GitHub or GitLab repo URL into { provider, owner, name }.
// GitLab namespaces can be nested (group/subgroup/project), so owner is the
// full namespace path and name is the final project segment.
function parseRepoUrl(
  raw: string
): { provider: "github" | "gitlab"; owner: string; name: string } | null {
  const url = raw.trim().replace(/\.git$/, "").replace(/\/+$/, "");

  const gh = url.match(/github\.com[/:]([^/]+)\/([^/]+)/);
  if (gh) return { provider: "github", owner: gh[1]!, name: gh[2]! };

  let gitlabHost = "gitlab.com";
  try {
    gitlabHost = new URL(env.GITLAB_BASE_URL || "https://gitlab.com").host;
  } catch {
    /* keep default */
  }
  const escaped = gitlabHost.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const gl = url.match(new RegExp(`(?:${escaped}|gitlab\\.com)[/:](.+)$`));
  if (gl) {
    const segs = gl[1]!.replace(/^\/+/, "").split("/").filter(Boolean);
    if (segs.length >= 2) {
      const name = segs.pop()!;
      return { provider: "gitlab", owner: segs.join("/"), name };
    }
  }
  return null;
}

type AuthEnv = {
  Variables: {
    user: typeof auth.$Infer.Session.user;
    session: typeof auth.$Infer.Session.session;
  };
};

const DEFAULT_STAGES = [
  { name: "Backlog", color: "#6b7280", order: 0, isDefault: true, isCompleted: false },
  { name: "Todo", color: "#3b82f6", order: 1, isDefault: false, isCompleted: false },
  { name: "In Progress", color: "#f59e0b", order: 2, isDefault: false, isCompleted: false },
  { name: "In Review", color: "#8b5cf6", order: 3, isDefault: false, isCompleted: false },
  { name: "Failed / Blocked", color: "#ef4444", order: 4, isDefault: false, isCompleted: false },
  { name: "Done", color: "#22c55e", order: 5, isDefault: false, isCompleted: true },
  { name: "Archive", color: "#64748b", order: 6, isDefault: false, isCompleted: true },
];

async function createDefaultStages(projectId: string) {
  await db.insert(ticketStages).values(
    DEFAULT_STAGES.map((s) => ({ ...s, projectId }))
  );
}

/**
 * Backfill workflow stages for projects created before a stage was introduced.
 * Keeping this idempotent lets existing projects gain new lanes without a data
 * migration, while also normalizing the canonical lane order.
 */
async function ensureDefaultStages(projectId: string) {
  const existing = await db.select().from(ticketStages).where(eq(ticketStages.projectId, projectId));
  const byName = new Map(existing.map((stage) => [stage.name, stage]));
  const missing = DEFAULT_STAGES.filter((stage) => !byName.has(stage.name));

  if (missing.length) {
    await db.insert(ticketStages)
      .values(missing.map((stage) => ({ ...stage, projectId })))
      .onConflictDoNothing();
  }

  await Promise.all(DEFAULT_STAGES.flatMap((stage) => {
    const row = byName.get(stage.name);
    if (!row) return [];
    if (
      row.order === stage.order &&
      row.color === stage.color &&
      row.isDefault === stage.isDefault &&
      row.isCompleted === stage.isCompleted
    ) return [];
    return [db.update(ticketStages).set({
      order: stage.order,
      color: stage.color,
      isDefault: stage.isDefault,
      isCompleted: stage.isCompleted,
      updatedAt: new Date(),
    }).where(eq(ticketStages.id, row.id))];
  }));
}

/** Move durable outcome statuses into their matching board lanes. */
async function syncOutcomeTicketStages(projectId: string) {
  const rows = await db.select({ id: ticketStages.id, name: ticketStages.name })
    .from(ticketStages)
    .where(eq(ticketStages.projectId, projectId));
  const failureStageId = rows.find((stage) => stage.name === "Failed / Blocked")?.id;
  const archiveStageId = rows.find((stage) => stage.name === "Archive")?.id;

  if (failureStageId) {
    await db.update(projectTickets).set({ stageId: failureStageId, updatedAt: new Date() }).where(and(
      eq(projectTickets.projectId, projectId),
      or(eq(projectTickets.status, "failed"), eq(projectTickets.status, "blocked")),
      or(isNull(projectTickets.stageId), ne(projectTickets.stageId, failureStageId)),
    ));
  }
  if (archiveStageId) {
    await db.update(projectTickets).set({ stageId: archiveStageId, updatedAt: new Date() }).where(and(
      eq(projectTickets.projectId, projectId),
      eq(projectTickets.status, "archived"),
      or(isNull(projectTickets.stageId), ne(projectTickets.stageId, archiveStageId)),
    ));
  }
}

const projectsRouter = new Hono<AuthEnv>();
projectsRouter.use("*", requireAuth);

// ── GET /projects — project list ────────────────────────────────────
projectsRouter.get("/projects", async (c) => {
  const user = c.get("user");
  const tab = c.req.query("tab") ?? "projects";

  // Owned projects
  const ownedRows = await db
    .select()
    .from(projects)
    .where(eq(projects.ownerId, user.id))
    .orderBy(desc(projects.createdAt));

  // Projects where user is a member
  const memberRows = await db
    .select({ project: projects })
    .from(projectMembers)
    .innerJoin(projects, eq(projectMembers.projectId, projects.id))
    .where(and(eq(projectMembers.userId, user.id), eq(projectMembers.status, "active")));

  const ownedIds = new Set(ownedRows.map((r) => r.id));
  const rows = [
    ...ownedRows,
    ...memberRows.map((r) => r.project).filter((p) => !ownedIds.has(p.id)),
  ];

  // Per-project stats for the cards: chats, tickets, docs, and pending items
  // for the current user. (conversations + notifications key off the PUBLIC id.)
  const projInternalIds = rows.map((r) => r.id);
  const projPublicIds = rows.map((r) => r.projectId);
  const toMap = (arr: { pid: string | null; n: number }[]) => {
    const m: Record<string, number> = {};
    for (const r of arr) if (r.pid) m[r.pid] = Number(r.n);
    return m;
  };
  const [convAgg, ticketAgg, docAgg, pendingAgg] = projInternalIds.length
    ? await Promise.all([
        db.select({ pid: conversations.projectId, n: sql<number>`count(*)` }).from(conversations).where(inArray(conversations.projectId, projPublicIds)).groupBy(conversations.projectId),
        db.select({ pid: projectTickets.projectId, n: sql<number>`count(*)` }).from(projectTickets).where(inArray(projectTickets.projectId, projInternalIds)).groupBy(projectTickets.projectId),
        db.select({ pid: projectFiles.projectId, n: sql<number>`count(*)` }).from(projectFiles).where(inArray(projectFiles.projectId, projInternalIds)).groupBy(projectFiles.projectId),
        db.select({ pid: notifications.projectId, n: sql<number>`count(*)` }).from(notifications).where(and(eq(notifications.userId, user.id), inArray(notifications.projectId, projPublicIds), isNull(notifications.readAt))).groupBy(notifications.projectId),
      ])
    : [[], [], [], []];
  const convByPub = toMap(convAgg);
  const ticketByInt = toMap(ticketAgg);
  const docByInt = toMap(docAgg);
  const pendingByPub = toMap(pendingAgg);
  const projectStats: Record<string, { conversations: number; tickets: number; docs: number; pending: number }> = {};
  for (const p of rows) {
    projectStats[p.id] = {
      conversations: convByPub[p.projectId] ?? 0,
      tickets: ticketByInt[p.id] ?? 0,
      docs: docByInt[p.id] ?? 0,
      pending: pendingByPub[p.projectId] ?? 0,
    };
  }

  // Fetch all instant apps for the user (across all projects + standalone)
  const appRows = await db
    .select({
      appId: instantApps.appId,
      name: instantApps.name,
      status: instantApps.status,
      description: instantApps.description,
      previewUrl: instantApps.previewUrl,
      createdAt: instantApps.createdAt,
      projectId: instantApps.projectId,
      projectPublicId: projects.projectId,
      projectName: projects.name,
    })
    .from(instantApps)
    .leftJoin(projects, eq(instantApps.projectId, projects.id))
    // The user's OWN apps + every app in a project they have access to (so guests/
    // collaborators see the project's instant apps, not just ones they created).
    .where(
      projInternalIds.length
        ? or(eq(instantApps.userId, user.id), inArray(instantApps.projectId, projInternalIds))
        : eq(instantApps.userId, user.id),
    )
    .orderBy(desc(instantApps.createdAt));

  // Fetch agents for the user
  const agentRows = await db
    .select()
    .from(agents)
    .where(eq(agents.userId, user.id))
    .orderBy(desc(agents.createdAt));

  // Pending invitations addressed to this user's email (robust fallback so an
  // invited user always sees & can accept, even if the invite link's redirect
  // got lost during login/registration).
  const memberProjectIds = new Set(rows.map((r) => r.id));
  const inviteRows = await db
    .select({
      token: projectInvitations.token,
      role: projectInvitations.role,
      projectId: projectInvitations.projectId,
      projectName: projects.name,
      projectIcon: projects.icon,
      inviterName: users.name,
    })
    .from(projectInvitations)
    .innerJoin(projects, eq(projectInvitations.projectId, projects.id))
    .leftJoin(users, eq(projectInvitations.inviterId, users.id))
    .where(and(eq(projectInvitations.email, user.email), eq(projectInvitations.status, "pending")));
  const pendingInvites = inviteRows
    .filter((i) => !memberProjectIds.has(i.projectId)) // hide ones already accepted
    .map((i) => ({
      token: i.token,
      role: i.role,
      projectName: i.projectName ?? "a project",
      projectIcon: i.projectIcon ?? "📋",
      inviterName: i.inviterName ?? "Someone",
    }));

  return c.html(ProjectListPage({
    user: { id: user.id, name: user.name, email: user.email },
    projects: rows,
    projectStats,
    instantApps: appRows,
    pendingInvites,
    agents: agentRows.map((a) => ({
      agentId: a.agentId,
      name: a.name,
      status: a.status,
      personality: a.personality,
      sandboxUrl: a.sandboxUrl,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    })),
    activeTab: tab,
  }));
});

// ── POST /projects/create — create project ──────────────────────────
projectsRouter.post("/projects/create", async (c) => {
  const user = c.get("user");
  const body = await c.req.parseBody();

  const name = (body["name"] as string | undefined)?.trim();
  const description = (body["description"] as string | undefined)?.trim() || null;
  const icon = (body["icon"] as string | undefined) ?? "📋";

  if (!name) {
    const rows = await db.select().from(projects).where(eq(projects.ownerId, user.id)).orderBy(desc(projects.createdAt));
    return c.html(
      ProjectListPage({ user: { id: user.id, name: user.name, email: user.email }, projects: rows, error: "Project name is required" }),
      422
    );
  }

  const [project] = await db
    .insert(projects)
    .values({ name, description: description ?? undefined, icon, ownerId: user.id })
    .returning();

  if (!project) return c.text("Failed to create project", 500);

  // Create default ticket stages
  await createDefaultStages(project.id);

  return c.redirect(`/projects/${project.projectId}?showConnect=true`);
});

// ── GET /projects/:projectId — project detail ───────────────────────
projectsRouter.get("/projects/:projectId", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();
  if (!projectId) return c.text("Missing projectId", 400);

  const tab = c.req.query("tab") ?? "home";

  const access = await getProjectAccess(projectId, user.id);
  if (!access) return c.text("Project not found", 404);
  const project = access.project;

  await ensureDefaultStages(project.id);

  const [convRows, stageRows, envRows, instantAppRows] = await Promise.all([
    db.select().from(conversations)
      .where(
        and(
          // conversations.projectId stores the PUBLIC projectId (URL id), not the
          // internal primary key — match how every other query reads it.
          eq(conversations.projectId, project.projectId),
          notExists(
            db.select({ id: instantApps.id }).from(instantApps)
              .where(eq(instantApps.conversationId, conversations.id))
          )
        )
      )
      .orderBy(desc(conversations.updatedAt))
      .limit(50),
    db.select().from(ticketStages)
      .where(eq(ticketStages.projectId, project.id))
      .orderBy(asc(ticketStages.order)),
    db.select().from(projectEnvironmentVariables)
      .where(eq(projectEnvironmentVariables.projectId, project.id))
      .orderBy(asc(projectEnvironmentVariables.key)),
    // Scope by PROJECT (the user already has access to this project), NOT by creator —
    // so guests/collaborators see the project's instant apps too.
    db.select().from(instantApps)
      .where(eq(instantApps.projectId, project.id))
      .orderBy(desc(instantApps.createdAt)),
  ]);

  // Count tickets per stage
  const ticketRows = await db
    .select({ stageId: projectTickets.stageId })
    .from(projectTickets)
    .where(eq(projectTickets.projectId, project.id));

  const ticketCounts: Record<string, number> = {};
  for (const row of ticketRows) {
    if (row.stageId) ticketCounts[row.stageId] = (ticketCounts[row.stageId] ?? 0) + 1;
  }

  // Counts for the Home summary strip.
  const [docCountRow, memberCountRow] = await Promise.all([
    db.select({ n: sql<number>`count(*)` }).from(projectFiles).where(eq(projectFiles.projectId, project.id)),
    db
      .select({ n: sql<number>`count(*)` })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.status, "active"))),
  ]);
  const docsCount = Number(docCountRow[0]?.n ?? 0);
  const memberCount = Number(memberCountRow[0]?.n ?? 0) + 1; // + owner
  const openTicketCount = ticketRows.length;

  // Has the user connected GitHub / GitLab? Used to gate the Link Repository flow —
  // without a token, linking a URL would silently fail later at clone/query time.
  const [ghTok] = await db
    .select({ userId: githubTokens.userId })
    .from(githubTokens)
    .where(eq(githubTokens.userId, user.id))
    .limit(1);
  const githubConnected = !!ghTok;
  const [glTok] = await db
    .select({ userId: gitlabTokens.userId })
    .from(gitlabTokens)
    .where(eq(gitlabTokens.userId, user.id))
    .limit(1);
  const gitlabConnected = !!glTok;

  return c.html(
    ProjectDetailPage({
      user: { id: user.id, name: user.name, email: user.email },
      project: {
        id: project.id,
        projectId: project.projectId,
        name: project.name,
        icon: project.icon,
        status: project.status,
        description: project.description ?? null,
        stack: project.stack ?? null,
        repoUrl: project.repoUrl ?? null,
        repoOwner: project.repoOwner ?? null,
        repoName: project.repoName ?? null,
        repoProvider: (project.repoProvider as string) ?? "github",
      },
      githubConnected,
      gitlabConnected,
      role: access.role,
      isOwner: access.role === "owner",
      conversations: convRows,
      stages: stageRows,
      ticketCounts,
      docsCount,
      memberCount,
      openTicketCount,
      envVars: envRows.map((e) => ({
        id: e.id,
        key: e.key,
        isSecret: e.isSecret,
        hasValue: e.hasValue,
        description: e.description ?? null,
      })),
      instantApps: instantAppRows.map((a) => ({
        appId: a.appId,
        name: a.name,
        status: a.status,
        description: a.description ?? null,
        previewUrl: a.previewUrl ?? null,
        createdAt: a.createdAt,
      })),
      activeTab: tab,
    })
  );
});

// ── POST /projects/:projectId/update — update project ───────────────
projectsRouter.post("/projects/:projectId/update", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();
  if (!projectId) return c.text("Missing projectId", 400);

  const body = await c.req.parseBody();
  const name = (body["name"] as string | undefined)?.trim();
  const description = (body["description"] as string | undefined)?.trim() || null;
  const stack = (body["stack"] as string | undefined)?.trim() || null;

  if (!name) return c.redirect(`/projects/${projectId}?tab=settings&error=Name+required`);

  const access = await getProjectAccess(projectId, user.id);
  if (!access) return c.text("Project not found", 404);
  if (access.role !== "owner" && access.role !== "admin") return c.text("Forbidden", 403);

  await db
    .update(projects)
    .set({ name, description: description ?? undefined, stack: stack ?? undefined, updatedAt: new Date() })
    .where(eq(projects.id, access.project.id));

  return c.redirect(`/projects/${projectId}?tab=settings`);
});

// ── POST /projects/:projectId/connect-repo — connect GitHub repo ────
projectsRouter.post("/projects/:projectId/connect-repo", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();
  if (!projectId) return c.text("Missing projectId", 400);

  const body = await c.req.parseBody();
  const repoUrl = ((body["repo_url"] as string | undefined) ?? "").trim();

  const access = await getProjectAccess(projectId, user.id);
  if (!access) return c.text("Project not found", 404);
  if (access.role !== "owner" && access.role !== "admin") return c.text("Forbidden", 403);
  const project = access.project;

  if (!repoUrl) {
    // Disconnect
    await db.update(projects).set({
      repoUrl: null, repoOwner: null, repoName: null, repoProvider: "github", updatedAt: new Date(),
    }).where(eq(projects.id, project.id));
    return c.redirect(`/projects/${projectId}`);
  }

  const parsed = parseRepoUrl(repoUrl);
  if (!parsed) return c.redirect(`/projects/${projectId}?error=Invalid+GitHub+or+GitLab+URL`);

  await db.update(projects).set({
    repoUrl,
    repoOwner: parsed.owner,
    repoName: parsed.name,
    repoProvider: parsed.provider,
    updatedAt: new Date(),
  }).where(eq(projects.id, project.id));

  return c.redirect(`/projects/${projectId}`);
});

// ── POST /projects/:projectId/delete — delete project ───────────────
projectsRouter.post("/projects/:projectId/delete", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();
  if (!projectId) return c.text("Missing projectId", 400);

  const access = await getProjectAccess(projectId, user.id);
  if (!access) return c.text("Project not found", 404);
  if (access.role !== "owner") return c.text("Forbidden", 403);

  await db.delete(projects).where(eq(projects.id, access.project.id));
  return c.redirect("/projects");
});

// ── GET /projects/:projectId/tickets — tickets kanban ───────────────
projectsRouter.get("/projects/:projectId/tickets", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();
  if (!projectId) return c.text("Missing projectId", 400);

  const access = await getProjectAccess(projectId, user.id);
  if (!access) return c.text("Project not found", 404);
  const project = access.project;

  await ensureDefaultStages(project.id);
  await syncOutcomeTicketStages(project.id);

  const [stageRows, ticketRows, appStateRows, profileRows, llmKeyRows] = await Promise.all([
    db.select().from(ticketStages)
      .where(eq(ticketStages.projectId, project.id))
      .orderBy(asc(ticketStages.order)),
    db.select({
      id: projectTickets.id,
      ticketKey: projectTickets.ticketKey,
      name: projectTickets.name,
      status: projectTickets.status,
      priority: projectTickets.priority,
      stageId: projectTickets.stageId,
      complexity: projectTickets.complexity,
      queueStatus: projectTickets.queueStatus,
      description: projectTickets.description,
    }).from(projectTickets)
      .where(eq(projectTickets.projectId, project.id))
      .orderBy(asc(projectTickets.createdAt)),
    db.select().from(applicationState)
      .where(eq(applicationState.userId, user.id))
      .limit(1),
    db.select({
      openAICodexConnected: profiles.openaiCodexAuthenticated,
      claudeCodeConnected: profiles.claudeCodeAuthenticated,
    }).from(profiles)
      .where(eq(profiles.userId, user.id))
      .limit(1),
    db.select({
      openai: llmApiKeys.openaiApiKey,
      anthropic: llmApiKeys.anthropicApiKey,
      google: llmApiKeys.googleApiKey,
      kimi: llmApiKeys.kimiApiKey,
      deepseek: llmApiKeys.deepseekApiKey,
      glm: llmApiKeys.glmApiKey,
    }).from(llmApiKeys)
      .where(eq(llmApiKeys.userId, user.id))
      .limit(1),
  ]);

  const appState = appStateRows[0];
  const profile = profileRows[0];
  const llmKeys = llmKeyRows[0];

  return c.html(
    TicketsListPage({
      user: { id: user.id, name: user.name, email: user.email },
      project: {
        id: project.id,
        projectId: project.projectId,
        name: project.name,
        icon: project.icon,
        ticketBuildIsolation: (project as { ticketBuildIsolation?: string }).ticketBuildIsolation ?? "isolated",
        previewBranchMode: (project as { previewBranchMode?: string }).previewBranchMode ?? "worktree",
      },
      stages: stageRows,
      tickets: ticketRows,
      // Drawer-only render for the chat's ticket sidebar (?embed=<ticketId>): skips the
      // nav + kanban so the grid never flashes before the ticket details.
      embed: c.req.query("embed") ?? undefined,
      executionMode: {
        claudeCodeEnabled: appState?.claudeCodeEnabled ?? true,
        builderModelKey: appState?.builderModelKey ?? "claude_4.5_sonnet",
        builderAuthMode: appState?.builderAuthMode === "api_key" ? "api_key" : "subscription",
        models: listModels().map(m => ({ key: m.key, label: `${m.providerLabel} · ${m.label}`, provider: m.provider })),
        openAICodexConnected: profile?.openAICodexConnected ?? false,
        claudeCodeConnected: profile?.claudeCodeConnected ?? false,
        apiKeyProviders: {
          openai: !!llmKeys?.openai,
          anthropic: !!llmKeys?.anthropic,
          google: !!llmKeys?.google,
          kimi: !!llmKeys?.kimi,
          deepseek: !!llmKeys?.deepseek,
          glm: !!llmKeys?.glm,
        },
      },
    })
  );
});

// ── DELETE /projects/:projectId/api/checklist/:ticketId/delete ───────
projectsRouter.delete("/projects/:projectId/api/checklist/:ticketId/delete", async (c) => {
  const user = c.get("user");
  const { projectId, ticketId } = c.req.param();

  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  try { requirePermission(access, "canManageTickets"); } catch { return c.json({ error: "Forbidden" }, 403); }
  const project = access.project;

  const result = await db.delete(projectTickets).where(
    and(eq(projectTickets.id, ticketId!), eq(projectTickets.projectId, project.id))
  );

  return c.json({ success: true, deleted: 1 });
});

// ── PATCH /projects/:projectId/api/checklist/:ticketId/stage — move ticket between stages
projectsRouter.patch("/projects/:projectId/api/checklist/:ticketId/stage", async (c) => {
  const user = c.get("user");
  const { projectId, ticketId } = c.req.param();
  const { stageId } = await c.req.json();

  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  try { requirePermission(access, "canManageTickets"); } catch { return c.json({ error: "Forbidden" }, 403); }
  const project = access.project;

  const [[stage], [ticket]] = await Promise.all([
    db.select({ id: ticketStages.id, name: ticketStages.name, isCompleted: ticketStages.isCompleted })
      .from(ticketStages)
      .where(and(eq(ticketStages.id, stageId), eq(ticketStages.projectId, project.id)))
      .limit(1),
    db.select({ status: projectTickets.status })
      .from(projectTickets)
      .where(and(eq(projectTickets.id, ticketId!), eq(projectTickets.projectId, project.id)))
      .limit(1),
  ]);
  if (!stage || !ticket) return c.json({ error: "Ticket or stage not found" }, 404);

  const stageStatus: Record<string, string> = {
    "Backlog": "open",
    "Todo": "open",
    "In Progress": "in_progress",
    "In Review": "review",
    "Done": "done",
    "Archive": "archived",
  };
  const status = stage.name === "Failed / Blocked"
    ? (ticket.status === "failed" ? "failed" : "blocked")
    : stageStatus[stage.name] ?? ticket.status;

  await db.update(projectTickets).set({ stageId, status, updatedAt: new Date() }).where(
    and(eq(projectTickets.id, ticketId!), eq(projectTickets.projectId, project.id))
  );

  // Moving into a COMPLETED stage (Done) = the user approved the ticket → reclaim
  // its build worktree + sandbox row (kept alive through In-Review so the branch
  // could be previewed/tested).
  try {
    if (stage?.isCompleted || /^done$/i.test(stage?.name ?? "")) {
      await cleanupTicketWorktree(ticketId!).catch(() => {});
    }
  } catch { /* best-effort cleanup */ }

  return c.json({ success: true, status });
});

// ── GET /projects/:projectId/api/checklist/:ticketId — get single ticket
projectsRouter.get("/projects/:projectId/api/checklist/:ticketId", async (c) => {
  const user = c.get("user");
  const { projectId, ticketId } = c.req.param();

  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  const project = access.project;

  const [ticket] = await db.select().from(projectTickets).where(
    and(eq(projectTickets.id, ticketId!), eq(projectTickets.projectId, project.id))
  );

  if (!ticket) return c.json({ error: "Ticket not found" }, 404);

  return c.json({ ticket });
});

// ── Compat: GET /projects/:projectId/api/checklist ──────────────────
// artifacts-loader.js (Django-era) fetches this URL for the Task List tab.
// We return project tickets in a compatible format.
projectsRouter.get("/projects/:projectId/api/checklist", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();

  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ tickets: [] });
  const project = access.project;

  const [stageRows, ticketRows, epicRows] = await Promise.all([
    db.select().from(ticketStages).where(eq(ticketStages.projectId, project.id)).orderBy(asc(ticketStages.order)),
    db.select().from(projectTickets).where(eq(projectTickets.projectId, project.id)).orderBy(asc(projectTickets.createdAt)),
    db.select().from(epics).where(eq(epics.projectId, project.id)),
  ]);

  const stageMap = Object.fromEntries(stageRows.map((s) => [s.id, s.name]));
  // Epic per ticket, so the list can group by delivery unit instead of by date.
  const epicMap = Object.fromEntries(epicRows.map((e) => [e.id, e]));

  // Attachments (screenshots the AI attached to a ticket) — grouped by ticket for rendering.
  const ticketIds = ticketRows.map((t) => t.id);
  const attRows = ticketIds.length
    ? await db.select().from(projectTicketAttachments).where(inArray(projectTicketAttachments.ticketId, ticketIds)).catch(() => [])
    : [];
  const attByTicket: Record<string, Array<{ url: string; name: string; type: string }>> = {};
  for (const a of attRows) {
    (attByTicket[a.ticketId] ||= []).push({ url: a.filePath, name: a.originalFilename ?? "attachment", type: a.fileType ?? "" });
  }

  const tickets = ticketRows.map((t) => {
    const epic = t.epicId ? epicMap[t.epicId] : null;
    return {
    id: t.id,
    ticket_key: t.ticketKey,
    name: t.name,
    description: t.description,
    status: t.status ?? "open",
    priority: t.priority ?? "Medium",
    complexity: t.complexity ?? "medium",
    stage: stageMap[t.stageId ?? ""] ?? "Backlog",
    stage_id: t.stageId,
    queue_status: t.queueStatus,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
    attachments: attByTicket[t.id] ?? [],
    conversation_id: t.conversationId ?? null,
    epic_id: t.epicId ?? null,
    epic_key: epic?.epicKey ?? null,
    epic_name: epic?.name ?? null,
    epic_status: epic?.status ?? null,
    };
  });

  return c.json({ tickets });
});

// ── GET /projects/:projectId/api/files/mentions/ ── @file autocomplete ──
// Returns files matching a search query for the chat @file mention feature.
projectsRouter.get("/projects/:projectId/api/files/mentions/", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();
  const q = (c.req.query("q") ?? "").toLowerCase();

  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ files: [], count: 0 });
  const project = access.project;

  let fileRows = await db
    .select()
    .from(projectFiles)
    .where(eq(projectFiles.projectId, project.id))
    .orderBy(desc(projectFiles.updatedAt))
    .limit(20);

  // Filter by query if provided
  if (q) {
    fileRows = fileRows.filter(
      (f) => f.name.toLowerCase().includes(q) || f.fileType.toLowerCase().includes(q)
    );
  }

  const TYPE_LABELS: Record<string, string> = {
    prd: "Product Requirements",
    implementation: "Implementation Plan",
    design: "Design Document",
    test: "Test Plan",
    other: "Document",
  };

  const files = fileRows.map((f) => ({
    id: f.id,
    name: f.name,
    type: f.fileType,
    label: `${f.name} (${TYPE_LABELS[f.fileType] ?? f.fileType})`,
    updated_at: f.updatedAt
      ? new Date(f.updatedAt as unknown as number * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : "",
  }));

  return c.json({ files, count: files.length });
});

// Without trailing slash variant — same handler (no redirect to avoid loops)
projectsRouter.get("/projects/:projectId/api/files/mentions", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();
  const q = (c.req.query("q") ?? "").toLowerCase();

  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ files: [], count: 0 });
  const project = access.project;

  let fileRows = await db
    .select()
    .from(projectFiles)
    .where(eq(projectFiles.projectId, project.id))
    .orderBy(desc(projectFiles.updatedAt))
    .limit(20);

  if (q) {
    fileRows = fileRows.filter(
      (f) => f.name.toLowerCase().includes(q) || f.fileType.toLowerCase().includes(q)
    );
  }

  const TYPE_LABELS: Record<string, string> = {
    prd: "Product Requirements",
    implementation: "Implementation Plan",
    design: "Design Document",
    test: "Test Plan",
    other: "Document",
  };

  const files = fileRows.map((f) => ({
    id: f.id,
    name: f.name,
    type: f.fileType,
    label: `${f.name} (${TYPE_LABELS[f.fileType] ?? f.fileType})`,
    updated_at: f.updatedAt
      ? new Date(f.updatedAt as unknown as number * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : "",
  }));

  return c.json({ files, count: files.length });
});

// ── Compat: GET /projects/:projectId/api/files/browser ──────────────
// artifacts-loader.js (Django-era) fetches this URL for the Docs tab file list.
projectsRouter.get("/projects/:projectId/api/files/browser", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();

  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ files: [], total: 0, pages: 1 });
  const project = access.project;

  const fileRows = await db
    .select()
    .from(projectFiles)
    .where(eq(projectFiles.projectId, project.id))
    .orderBy(desc(projectFiles.updatedAt));

  const files = fileRows.map((f) => ({
    id: f.id,
    name: f.name,
    type: f.fileType,
    updated_at: f.updatedAt,
    created_at: f.createdAt,
  }));

  return c.json({ files, total: files.length, pages: 1, filters: { types: [...new Set(files.map((f) => f.type))] } });
});

// ── Compat: GET /projects/:projectId/api/files/:fileId/content ───────
// artifacts-loader.js viewFileContent() fetches this to display file in viewer.
projectsRouter.get("/projects/:projectId/api/files/:fileId/content", async (c) => {
  const { fileId } = c.req.param();

  const [file] = await db.select().from(projectFiles).where(eq(projectFiles.id, fileId!));
  if (!file) return c.json({ error: "File not found" }, 404);

  const content = await getContent(file.s3Key, file.content);
  return c.json({ id: file.id, name: file.name, type: file.fileType, content });
});

// Trailing slash variant for chat.js compatibility
projectsRouter.get("/projects/:projectId/api/files/:fileId/content/", async (c) => {
  const { fileId } = c.req.param();

  const [file] = await db.select().from(projectFiles).where(eq(projectFiles.id, fileId!));
  if (!file) return c.json({ error: "File not found" }, 404);

  const content = await getContent(file.s3Key, file.content);
  return c.json({ id: file.id, name: file.name, type: file.fileType, content });
});

// ── Helper: save a version snapshot before overwriting content ────────
async function saveVersion(fileId: string, content: string, userId: string) {
  // Get max version number for this file
  const existing = await db
    .select({ versionNumber: projectFileVersions.versionNumber })
    .from(projectFileVersions)
    .where(eq(projectFileVersions.fileId, fileId))
    .orderBy(desc(projectFileVersions.versionNumber))
    .limit(1);
  const nextVersion = (existing[0]?.versionNumber ?? 0) + 1;
  await db.insert(projectFileVersions).values({
    fileId,
    versionNumber: nextVersion,
    content,
    createdById: userId,
    changeDescription: "Manual save",
  });
}

// ── POST /projects/:projectId/api/files — update file content ─────────
// artifacts-loader.js saveFileContent() calls this for non-prd/impl types.
// Also handles prd/implementation via type query param for uniformity.
projectsRouter.post("/projects/:projectId/api/files", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();

  const access = await getProjectAccess(projectId, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  try { requirePermission(access, "canEditFiles"); } catch { return c.json({ error: "Forbidden" }, 403); }
  const project = access.project;

  const type = c.req.query("type") ?? "";
  const name = c.req.query("name") ?? "";
  const body = await c.req.json() as { content?: string };
  const content = body.content ?? "";

  const [file] = await db
    .select()
    .from(projectFiles)
    .where(and(eq(projectFiles.projectId, project.id), eq(projectFiles.fileType, type), eq(projectFiles.name, name)));

  if (!file) return c.json({ error: "File not found" }, 404);

  const currentContent = await getContent(file.s3Key, file.content);
  await saveVersion(file.id, currentContent, user.id);

  const { s3Key, dbContent } = await saveContent(project.id, type, name, content);
  const [updated] = await db
    .update(projectFiles)
    .set({ content: dbContent, s3Key, updatedAt: new Date() })
    .where(eq(projectFiles.id, file.id))
    .returning();

  return c.json({ success: true, id: updated!.id, name: updated!.name, type: updated!.fileType });
});

// ── POST /projects/:projectId/api/prd — compat save for PRD files ─────
projectsRouter.post("/projects/:projectId/api/prd", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();

  const access = await getProjectAccess(projectId, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  try { requirePermission(access, "canEditFiles"); } catch { return c.json({ error: "Forbidden" }, 403); }
  const project = access.project;

  const prdName = c.req.query("prd_name") ?? "Main PRD";
  const body = await c.req.json() as { content?: string };
  const content = body.content ?? "";

  const [file] = await db
    .select()
    .from(projectFiles)
    .where(and(eq(projectFiles.projectId, project.id), eq(projectFiles.fileType, "prd"), eq(projectFiles.name, prdName)));

  if (!file) return c.json({ error: "PRD not found" }, 404);

  const currentContent = await getContent(file.s3Key, file.content);
  await saveVersion(file.id, currentContent, user.id);

  const { s3Key, dbContent } = await saveContent(project.id, "prd", prdName, content);
  await db.update(projectFiles).set({ content: dbContent, s3Key, updatedAt: new Date() }).where(eq(projectFiles.id, file.id));

  return c.json({ success: true, id: file.id, name: prdName, type: "prd" });
});

// ── POST /projects/:projectId/api/implementation — compat save ────────
projectsRouter.post("/projects/:projectId/api/implementation", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();

  const access = await getProjectAccess(projectId, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  try { requirePermission(access, "canEditFiles"); } catch { return c.json({ error: "Forbidden" }, 403); }
  const project = access.project;

  const body = await c.req.json() as { content?: string };
  const content = body.content ?? "";

  const [file] = await db
    .select()
    .from(projectFiles)
    .where(and(eq(projectFiles.projectId, project.id), eq(projectFiles.fileType, "implementation")))
    .orderBy(desc(projectFiles.updatedAt))
    .limit(1);

  if (!file) return c.json({ error: "Implementation not found" }, 404);

  const currentContent = await getContent(file.s3Key, file.content);
  await saveVersion(file.id, currentContent, user.id);

  const { s3Key, dbContent } = await saveContent(project.id, "implementation", file.name, content);
  await db.update(projectFiles).set({ content: dbContent, s3Key, updatedAt: new Date() }).where(eq(projectFiles.id, file.id));

  return c.json({ success: true, id: file.id, name: file.name, type: "implementation" });
});

// ── DELETE /projects/:projectId/api/files — delete by type+name ──────
// artifacts-loader.js deleteFile() calls this.
projectsRouter.delete("/projects/:projectId/api/files", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();

  const access = await getProjectAccess(projectId, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  try { requirePermission(access, "canEditFiles"); } catch { return c.json({ error: "Forbidden" }, 403); }
  const project = access.project;

  const type = c.req.query("type") ?? "";
  const name = c.req.query("name") ?? "";

  const [file] = await db
    .select()
    .from(projectFiles)
    .where(and(eq(projectFiles.projectId, project.id), eq(projectFiles.fileType, type), eq(projectFiles.name, name)));

  if (!file) return c.json({ error: "File not found" }, 404);

  await deleteContent(file.s3Key);
  await db.delete(projectFiles).where(eq(projectFiles.id, file.id));

  return c.json({ success: true });
});

// ── GET /projects/:projectId/api/files/:fileId/versions — list versions
projectsRouter.get("/projects/:projectId/api/files/:fileId/versions", async (c) => {
  const { fileId } = c.req.param();

  const versions = await db
    .select()
    .from(projectFileVersions)
    .where(eq(projectFileVersions.fileId, fileId!))
    .orderBy(desc(projectFileVersions.versionNumber));

  return c.json({ versions });
});

// ── GET /projects/:projectId/api/files/:fileId/versions/:versionNumber — fetch single version content
projectsRouter.get("/projects/:projectId/api/files/:fileId/versions/:versionNumber", async (c) => {
  const { fileId, versionNumber } = c.req.param();

  const [version] = await db
    .select()
    .from(projectFileVersions)
    .where(and(eq(projectFileVersions.fileId, fileId!), eq(projectFileVersions.versionNumber, Number(versionNumber))));

  if (!version) return c.json({ success: false, error: "Version not found" }, 404);

  const content = await getContent(null, version.content);
  return c.json({ success: true, version: { ...version, content } });
});

// ── POST /projects/:projectId/api/files/:fileId/versions/:versionId/restore
projectsRouter.post("/projects/:projectId/api/files/:fileId/versions/:versionNumber/restore", async (c) => {
  const user = c.get("user");
  const { fileId, versionNumber } = c.req.param();

  const [version] = await db
    .select()
    .from(projectFileVersions)
    .where(and(eq(projectFileVersions.fileId, fileId!), eq(projectFileVersions.versionNumber, Number(versionNumber))));

  if (!version) return c.json({ error: "Version not found" }, 404);

  const [file] = await db.select().from(projectFiles).where(eq(projectFiles.id, fileId!));
  if (!file) return c.json({ error: "File not found" }, 404);

  // Snapshot current content before restoring
  const currentContent = await getContent(file.s3Key, file.content);
  await saveVersion(fileId!, currentContent, user.id);

  // Save restored content (respects S3 if enabled)
  const { s3Key: newKey, dbContent: newContent } = await saveContent(file.projectId, file.fileType, file.name, version.content ?? "");
  await db.update(projectFiles).set({ content: newContent, s3Key: newKey, updatedAt: new Date() }).where(eq(projectFiles.id, fileId!));

  return c.json({ success: true, restoredVersion: version.versionNumber, message: `Restored to version ${version.versionNumber}` });
});

// ── GET /projects/:projectId/api/activities — event timeline ─────────
projectsRouter.get("/projects/:projectId/api/activities", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();

  const access = await getProjectAccess(projectId, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  const project = access.project;

  const limit = Math.min(Number(c.req.query("limit") ?? 50), 100);
  const offset = Number(c.req.query("offset") ?? 0);

  const activities = await getProjectActivities(project.id, { limit, offset });
  return c.json({ activities });
});

export default projectsRouter;
