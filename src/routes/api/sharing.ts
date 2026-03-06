import { Hono } from "hono";
import { requireAuth } from "../../auth/middleware.ts";
import { db } from "../../config/db.ts";
import { shareLinks } from "../../db/schema/sharing.ts";
import { eq, and, desc } from "drizzle-orm";
import { getProjectAccess } from "../../auth/project-access.ts";
import type { auth } from "../../auth/index.ts";

type AuthEnv = {
  Variables: {
    user: typeof auth.$Infer.Session.user;
    session: typeof auth.$Infer.Session.session;
  };
};

const sharingApi = new Hono<AuthEnv>();
sharingApi.use("*", requireAuth);

// ── POST /api/projects/:projectId/share-links — create share link ────
sharingApi.post("/:projectId/share-links", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();

  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  if (access.role !== "owner" && access.role !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const body = await c.req.json<{
    resourceType: "file" | "ticket";
    resourceId: string;
    expiresAt?: string;
  }>();

  if (!body.resourceType || !body.resourceId) {
    return c.json({ error: "resourceType and resourceId are required" }, 400);
  }

  // Generate URL-safe token
  const tokenBytes = new Uint8Array(24);
  crypto.getRandomValues(tokenBytes);
  const token = Buffer.from(tokenBytes).toString("base64url");

  const [link] = await db
    .insert(shareLinks)
    .values({
      token,
      projectId: access.project.id,
      resourceType: body.resourceType,
      resourceId: body.resourceId,
      createdById: user.id,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
    })
    .returning();

  return c.json({ shareLink: link, url: `/s/${token}` }, 201);
});

// ── GET /api/projects/:projectId/share-links — list links ────────────
sharingApi.get("/:projectId/share-links", async (c) => {
  const user = c.get("user");
  const { projectId } = c.req.param();

  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);

  const rows = await db
    .select()
    .from(shareLinks)
    .where(eq(shareLinks.projectId, access.project.id))
    .orderBy(desc(shareLinks.createdAt));

  return c.json({ shareLinks: rows });
});

// ── DELETE /api/projects/:projectId/share-links/:id — revoke ─────────
sharingApi.delete("/:projectId/share-links/:id", async (c) => {
  const user = c.get("user");
  const { projectId, id } = c.req.param();

  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  if (access.role !== "owner" && access.role !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }

  await db
    .delete(shareLinks)
    .where(
      and(
        eq(shareLinks.id, id!),
        eq(shareLinks.projectId, access.project.id)
      )
    );

  return c.json({ success: true });
});

// ── PATCH /api/projects/:projectId/share-links/:id — toggle active ───
sharingApi.patch("/:projectId/share-links/:id", async (c) => {
  const user = c.get("user");
  const { projectId, id } = c.req.param();

  const access = await getProjectAccess(projectId!, user.id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  if (access.role !== "owner" && access.role !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }

  const body = await c.req.json<{ isActive: boolean }>();

  const [updated] = await db
    .update(shareLinks)
    .set({ isActive: body.isActive })
    .where(
      and(
        eq(shareLinks.id, id!),
        eq(shareLinks.projectId, access.project.id)
      )
    )
    .returning();

  return c.json({ shareLink: updated });
});

export default sharingApi;
