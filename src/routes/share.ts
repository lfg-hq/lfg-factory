import { Hono } from "hono";
import { optionalAuth } from "../auth/middleware.ts";
import { db } from "../config/db.ts";
import { shareLinks } from "../db/schema/sharing.ts";
import { projectFiles } from "../db/schema/documents.ts";
import { projectTickets, projectTodoLists } from "../db/schema/tickets.ts";
import { projects } from "../db/schema/projects.ts";
import { eq, and, asc } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { getContent } from "../services/s3.ts";
import { SharedFilePage } from "../templates/pages/shared-file.tsx";
import { SharedTicketPage } from "../templates/pages/shared-ticket.tsx";
import type { auth } from "../auth/index.ts";

type OptionalAuthEnv = {
  Variables: {
    user: typeof auth.$Infer.Session.user | null;
    session: typeof auth.$Infer.Session.session | null;
  };
};

const shareRoutes = new Hono<OptionalAuthEnv>();

// ── GET /s/:token — resolve token and render public view ─────────────
shareRoutes.get("/s/:token", optionalAuth, async (c) => {
  const { token } = c.req.param();

  const [link] = await db
    .select()
    .from(shareLinks)
    .where(eq(shareLinks.token, token!));

  if (!link || !link.isActive) {
    return c.text("This link is not available", 404);
  }

  // Check expiry
  if (link.expiresAt && new Date(link.expiresAt) < new Date()) {
    return c.text("This link has expired", 410);
  }

  // Increment view count atomically
  await db
    .update(shareLinks)
    .set({ viewCount: sql`${shareLinks.viewCount} + 1` })
    .where(eq(shareLinks.id, link.id));

  // Get project info
  const [project] = await db
    .select({ name: projects.name, icon: projects.icon })
    .from(projects)
    .where(eq(projects.id, link.projectId));

  if (link.resourceType === "file") {
    const [file] = await db
      .select()
      .from(projectFiles)
      .where(eq(projectFiles.id, link.resourceId));

    if (!file) return c.text("File not found", 404);

    const content = await getContent(file.s3Key, file.content);

    return c.html(
      SharedFilePage({
        file: { name: file.name, type: file.fileType, content },
        project: { name: project?.name ?? "Project", icon: project?.icon ?? "📋" },
      })
    );
  }

  if (link.resourceType === "ticket") {
    const [ticket] = await db
      .select()
      .from(projectTickets)
      .where(eq(projectTickets.id, link.resourceId));

    if (!ticket) return c.text("Ticket not found", 404);

    const tasks = await db
      .select()
      .from(projectTodoLists)
      .where(eq(projectTodoLists.ticketId, ticket.id))
      .orderBy(asc(projectTodoLists.order));

    return c.html(
      SharedTicketPage({
        ticket: {
          name: ticket.name,
          description: ticket.description,
          status: ticket.status,
          priority: ticket.priority,
        },
        tasks: tasks.map((t) => ({
          description: t.description,
          status: t.status,
        })),
        project: { name: project?.name ?? "Project", icon: project?.icon ?? "📋" },
      })
    );
  }

  return c.text("Unknown resource type", 400);
});

export default shareRoutes;
