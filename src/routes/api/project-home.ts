/**
 * Combined Home payload — one request instead of 5 (activities + notifications
 * + members + pins). Cuts round-trips on the project Home page.
 */
import { Hono } from "hono";
import { requireAuth } from "../../auth/middleware.ts";
import { db } from "../../config/db.ts";
import { notifications } from "../../db/schema/notifications.ts";
import { users } from "../../db/schema/users.ts";
import { projectMembers } from "../../db/schema/projects.ts";
import { projectPins } from "../../db/schema/pins.ts";
import { projectFiles } from "../../db/schema/documents.ts";
import { epics } from "../../db/schema/epics.ts";
import { projectTickets } from "../../db/schema/tickets.ts";
import { and, eq, desc, asc, isNull, inArray } from "drizzle-orm";
import { getProjectAccess } from "../../auth/project-access.ts";
import { getProjectActivities } from "../../services/activity-log.ts";
import { projectHome } from "../../services/project-home.ts";
import { gitContext } from "../../services/git-context.ts";
import { GitProviderError } from "../../services/git-provider.ts";
import { getEpic, epicBaseBranch } from "../../services/epics.ts";
import type { auth } from "../../auth/index.ts";

type Env = { Variables: { user: typeof auth.$Infer.Session.user } };
const homeApi = new Hono<Env>();
homeApi.use("*", requireAuth as any);

homeApi.get("/:projectId/home", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();
  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  const p = access.project;
  const canManagePins = access.role === "owner" || access.role === "admin";

  const [activities, notifs, memberRows, owner, pinRows, workTickets, latestEpics] = await Promise.all([
    getProjectActivities(p.id, { limit: 6 }),
    db
      .select({
        id: notifications.id,
        type: notifications.type,
        message: notifications.message,
        link: notifications.link,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
        actorName: users.name,
      })
      .from(notifications)
      .leftJoin(users, eq(notifications.actorId, users.id))
      .where(and(eq(notifications.userId, user.id), eq(notifications.projectId, p.projectId)))
      .orderBy(desc(notifications.createdAt))
      .limit(50),
    db
      .select({ userId: projectMembers.userId, role: projectMembers.role, userName: users.name, userEmail: users.email })
      .from(projectMembers)
      .innerJoin(users, eq(projectMembers.userId, users.id))
      .where(and(eq(projectMembers.projectId, p.id), eq(projectMembers.status, "active"))),
    db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.id, p.ownerId)).then((r) => r[0]),
    db.select().from(projectPins).where(eq(projectPins.projectId, p.id)).orderBy(asc(projectPins.order), asc(projectPins.createdAt)),
    db.select({ id: projectTickets.id, name: projectTickets.name, ticketKey: projectTickets.ticketKey,
      status: projectTickets.status, queueStatus: projectTickets.queueStatus,
      epicId: projectTickets.epicId, conversationId: projectTickets.conversationId, updatedAt: projectTickets.updatedAt })
      .from(projectTickets).where(eq(projectTickets.projectId, p.id)).orderBy(desc(projectTickets.updatedAt)),
    db.select({ id:epics.id, name:epics.name, epicKey:epics.epicKey, status:epics.status, previewUrl:epics.previewUrl, createdAt:epics.createdAt })
      .from(epics).where(eq(epics.projectId, p.id)).orderBy(desc(epics.createdAt), desc(epics.id)).limit(4),
  ]);

  // Resolve pin names/links (docs/tickets can be renamed).
  const docIds = pinRows.filter((r) => r.targetType === "document" && r.targetId).map((r) => r.targetId!);
  const ticketIds = pinRows.filter((r) => r.targetType === "ticket" && r.targetId).map((r) => r.targetId!);
  const docNames = new Map<string, string>();
  const ticketNames = new Map<string, string>();
  if (docIds.length) (await db.select({ id: projectFiles.id, name: projectFiles.name }).from(projectFiles).where(inArray(projectFiles.id, docIds))).forEach((d) => docNames.set(d.id, d.name));
  if (ticketIds.length) (await db.select({ id: projectTickets.id, name: projectTickets.name }).from(projectTickets).where(inArray(projectTickets.id, ticketIds))).forEach((t) => ticketNames.set(t.id, t.name));
  const pins = pinRows.map((r) => {
    let href = r.url ?? "#";
    let label = r.label;
    if (r.targetType === "document" && r.targetId) {
      label = docNames.get(r.targetId) ?? r.label;
      href = `/projects/${projectId}?tab=documents&doc=${encodeURIComponent(r.targetId)}&docName=${encodeURIComponent(label)}`;
    } else if (r.targetType === "ticket" && r.targetId) {
      label = ticketNames.get(r.targetId) ?? r.label;
      href = `/projects/${projectId}?tab=tickets`;
    }
    return { id: r.id, targetType: r.targetType, label, href };
  });

  const unreadCount = notifs.filter((n) => !n.readAt).length;
  const dash = await projectHome(p, user.id);

  return c.json({
    dash,
    activities,
    workTickets,
    epics: latestEpics,
    notifications: notifs,
    unreadCount,
    members: {
      owner: owner ? { id: owner.id, name: owner.name, email: owner.email, role: "owner" } : null,
      members: memberRows,
    },
    pins,
    canManagePins,
  });
});

// ── Changed lines for a review panel ──────────────────────────────────
// Read straight from the git provider, so a review never has to boot a workspace.
const DIFF_ERRORS: Record<string, string> = {
  GIT_DISCONNECTED: "Connect your Git account to see the changed lines here.",
  NO_REPOSITORY: "This project has no repository connected yet.",
  DIFF_TOO_LARGE: "This change is too large to show here. Open the full diff.",
  DIFF_INCOMPLETE: "This change is too large to show here. Open the full diff.",
};
const MAX_PATCH_LINES = 60;

async function changedLines(project: unknown, userId: string, base: string, head: string) {
  try {
    const provider = await gitContext(project, userId);
    const sha = (ref: string) => (/^[a-f0-9]{40,64}$/.test(ref) ? Promise.resolve(ref) : provider.ref(ref));
    const [baseSha, headSha] = await Promise.all([sha(base), sha(head)]);
    const result = await provider.reviewChanges(baseSha, headSha, { context: false });
    return {
      files: result.files.map((f) => {
        const lines = f.patch.split("\n");
        return {
          file: f.file,
          additions: lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length,
          deletions: lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length,
          patch: lines.slice(0, MAX_PATCH_LINES).join("\n"),
          truncated: lines.length > MAX_PATCH_LINES,
        };
      }),
      hidden: result.excluded.length,
    };
  } catch (error) {
    const code = error instanceof GitProviderError ? error.code : "UNAVAILABLE";
    return { files: [], hidden: 0, unavailable: DIFF_ERRORS[code] ?? "The changed lines could not be loaded. Open the full diff." };
  }
}

homeApi.get("/:projectId/epics/:epicId/changes", async (c) => {
  const access = await getProjectAccess(c.req.param("projectId")!, c.get("user").id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  const epic = await getEpic(c.req.param("epicId")!);
  if (!epic || epic.projectId !== access.project.id) return c.json({ error: "Epic not found" }, 404);
  if (!epic.branch) return c.json({ files: [], hidden: 0, unavailable: "Nothing has been built for this epic yet." });
  return c.json(await changedLines(access.project, c.get("user").id, epic.baseSha || epicBaseBranch(epic), epic.branch));
});

export default homeApi;
