import { Hono } from "hono";
import { and, desc, eq, isNull } from "drizzle-orm";
import { requireAuth } from "../auth/middleware.ts";
import { db } from "../config/db.ts";
import { projects } from "../db/schema/projects.ts";
import { modelSelections, agentRoles } from "../db/schema/chat.ts";
import { instantApps } from "../db/schema/instant.ts";
import { listModels, DEFAULT_MODEL_KEY } from "../ai/provider.ts";
import { InstantPage } from "../templates/pages/instant.tsx";
import { normalizeMagsAppUrl } from "../services/mags.ts";
import type { auth } from "../auth/index.ts";

type AuthEnv = {
  Variables: {
    user: typeof auth.$Infer.Session.user;
    session: typeof auth.$Infer.Session.session;
  };
};

const instant = new Hono<AuthEnv>();
instant.use("*", requireAuth);

// Strip trailing slashes to avoid 404s (e.g. /instant/project/xxx/ → /instant/project/xxx)
instant.use("*", async (c, next) => {
  const path = c.req.path;
  if (path !== "/instant" && path !== "/instant/" && path.endsWith("/")) {
    return c.redirect(path.slice(0, -1), 301);
  }
  return next();
});

type InstantAppRow = typeof instantApps.$inferSelect;

async function getUserChatSettings(userId: string) {
  const [modelSel, roleRow] = await Promise.all([
    db.select().from(modelSelections).where(eq(modelSelections.userId, userId)).then((rows) => rows[0]),
    db.select().from(agentRoles).where(eq(agentRoles.userId, userId)).then((rows) => rows[0]),
  ]);
  return {
    modelKey: modelSel?.selectedModel ?? DEFAULT_MODEL_KEY,
    roleKey: roleRow?.name ?? "product_analyst",
  };
}

async function getProjectForUser(userId: string, publicProjectId: string) {
  const [project] = await db
    .select({ id: projects.id, projectId: projects.projectId, name: projects.name })
    .from(projects)
    .where(and(eq(projects.projectId, publicProjectId), eq(projects.ownerId, userId)))
    .limit(1);
  return project ?? null;
}

function toPageApp(app: InstantAppRow) {
  const meta = (app.metadata as Record<string, any> | null) ?? {};
  // Prefer the APPLIED (built) design; fall back to the proposal preview tokens for
  // apps that have been proposed but not yet built. (proposalTokens never overwrites
  // the running app's design — that's why they're separate keys.)
  const t = meta.designTokens ?? meta.proposalTokens;
  const spec = meta.spec ?? {};
  const proposal = meta.proposal ?? {};
  const design = t
    ? {
        palette: t.meta?.paletteName ?? meta.paletteId ?? "",
        style: t.meta?.styleProfileName ?? meta.styleProfileId ?? "",
        headingFont: t.typography?.headingFont ?? "",
        bodyFont: t.typography?.bodyFont ?? "",
        colors: {
          primary: t.colors?.primary,
          secondary: t.colors?.secondary,
          accent: t.colors?.accent,
          background: t.colors?.background,
          text: t.colors?.text,
          border: t.colors?.border,
        },
        summary: spec.summary ?? proposal.summary ?? "",
        sections: (spec.sections ?? proposal.sections ?? []) as Array<{ title: string; description: string }>,
        projectType: (meta.projectType ?? proposal.projectType ?? spec.projectType) as string | undefined,
      }
    : null;
  return {
    appId: app.appId,
    name: app.name,
    status: app.status,
    previewUrl: normalizeMagsAppUrl(app.previewUrl),
    conversationId: app.conversationId,
    design,
    githubRepoUrl: (meta.githubRepoUrl as string | undefined) ?? null,
    testReport: (meta.testReport as Record<string, unknown> | undefined) ?? null,
  };
}

instant.get("/instant", async (c) => {
  const user = c.get("user");
  const settings = await getUserChatSettings(user.id);
  const apps = await db
    .select()
    .from(instantApps)
    .where(and(eq(instantApps.userId, user.id), isNull(instantApps.projectId)))
    .orderBy(desc(instantApps.createdAt));

  return c.html(
    InstantPage({
      user: { id: user.id, name: user.name, email: user.email ?? "" },
      standaloneMode: true,
      modelKey: settings.modelKey,
      roleKey: settings.roleKey,
      models: listModels().map((model) => ({
        key: model.key,
        label: model.label,
        providerLabel: model.providerLabel,
        requiresPro: model.requiresPro,
      })),
      currentApp: null,
      instantApps: apps.map(toPageApp),
    })
  );
});

instant.get("/instant/app/:appId", async (c) => {
  const user = c.get("user");
  const { appId } = c.req.param();
  console.log("[instant] GET /instant/app/:appId - appId:", appId, "userId:", user.id);
  const settings = await getUserChatSettings(user.id);

  // Look up the app by owner+appId REGARDLESS of project. An app created inside a project
  // used to 404 here because of an isNull(projectId) filter — the standalone URL simply
  // couldn't see project-scoped apps. If it belongs to a project, redirect to its
  // canonical project-scoped URL (which carries the project context the page needs).
  // Look up by appId REGARDLESS of owner. A PROJECT-scoped app is redirected to its
  // project URL, where access is granted to any project member (owner OR guest) — so a
  // guest with project access no longer 404s here. Standalone apps stay owner-only.
  const [anyApp] = await db
    .select({ id: instantApps.id, appId: instantApps.appId, projectId: instantApps.projectId, conversationId: instantApps.conversationId, userId: instantApps.userId })
    .from(instantApps)
    .where(eq(instantApps.appId, appId))
    .limit(1);

  if (anyApp?.projectId) {
    const [proj] = await db
      .select({ pub: projects.projectId })
      .from(projects)
      .where(eq(projects.id, anyApp.projectId))
      .limit(1);
    if (proj?.pub) return c.redirect(`/instant/project/${proj.pub}/app/${appId}`);
  }

  // Standalone (no project) → owner-only.
  const ownedApp = anyApp && anyApp.userId === user.id ? anyApp : null;
  console.log("[instant] currentApp found:", !!ownedApp, "conversationId:", ownedApp?.conversationId);
  if (!ownedApp) return c.text("Instant app not found", 404);

  const [currentApp, apps] = await Promise.all([
    db
      .select()
      .from(instantApps)
      .where(and(eq(instantApps.userId, user.id), eq(instantApps.appId, appId), isNull(instantApps.projectId)))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select()
      .from(instantApps)
      .where(and(eq(instantApps.userId, user.id), isNull(instantApps.projectId)))
      .orderBy(desc(instantApps.createdAt)),
  ]);

  if (!currentApp) return c.text("Instant app not found", 404);

  return c.html(
    InstantPage({
      user: { id: user.id, name: user.name, email: user.email ?? "" },
      standaloneMode: true,
      modelKey: settings.modelKey,
      roleKey: settings.roleKey,
      models: listModels().map((model) => ({
        key: model.key,
        label: model.label,
        providerLabel: model.providerLabel,
        requiresPro: model.requiresPro,
      })),
      currentApp: toPageApp(currentApp),
      instantApps: apps.map(toPageApp),
    })
  );
});

instant.get("/instant/project/:projectId", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();
  const project = await getProjectForUser(user.id, projectId);
  if (!project) return c.text("Project not found", 404);

  const settings = await getUserChatSettings(user.id);
  // Scope by PROJECT (access already granted by getProjectForUser) — NOT by creator, so
  // guests/collaborators see the project's instant apps too.
  const apps = await db
    .select()
    .from(instantApps)
    .where(eq(instantApps.projectId, project.id))
    .orderBy(desc(instantApps.createdAt));

  return c.html(
    InstantPage({
      user: { id: user.id, name: user.name, email: user.email ?? "" },
      standaloneMode: false,
      projectId: project.projectId,
      projectName: project.name,
      modelKey: settings.modelKey,
      roleKey: settings.roleKey,
      models: listModels().map((model) => ({
        key: model.key,
        label: model.label,
        providerLabel: model.providerLabel,
        requiresPro: model.requiresPro,
      })),
      currentApp: null,
      instantApps: apps.map(toPageApp),
    })
  );
});

instant.get("/instant/project/:projectId/app/:appId", async (c) => {
  const user = c.get("user");
  const { projectId, appId } = c.req.param();
  const project = await getProjectForUser(user.id, projectId);
  if (!project) return c.text("Project not found", 404);

  const settings = await getUserChatSettings(user.id);
  // Scope by PROJECT (access already granted by getProjectForUser), NOT by creator — so a
  // guest with project access can open the project's instant apps instead of 404ing.
  const [currentApp, apps] = await Promise.all([
    db
      .select()
      .from(instantApps)
      .where(and(eq(instantApps.projectId, project.id), eq(instantApps.appId, appId)))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select()
      .from(instantApps)
      .where(eq(instantApps.projectId, project.id))
      .orderBy(desc(instantApps.createdAt)),
  ]);

  if (!currentApp) return c.text("Instant app not found", 404);

  return c.html(
    InstantPage({
      user: { id: user.id, name: user.name, email: user.email ?? "" },
      standaloneMode: false,
      projectId: project.projectId,
      projectName: project.name,
      modelKey: settings.modelKey,
      roleKey: settings.roleKey,
      models: listModels().map((model) => ({
        key: model.key,
        label: model.label,
        providerLabel: model.providerLabel,
        requiresPro: model.requiresPro,
      })),
      currentApp: toPageApp(currentApp),
      instantApps: apps.map(toPageApp),
    })
  );
});

export default instant;
