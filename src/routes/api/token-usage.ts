import { Hono } from "hono";
import { and, eq, gte, lt, sql, inArray } from "drizzle-orm";
import { requireAuth } from "../../auth/middleware.ts";
import { getProjectAccess } from "../../auth/project-access.ts";
import type { auth } from "../../auth/index.ts";
import { db } from "../../config/db.ts";
import { tokenUsage, tokenUsageDocuments, tokenUsageRuns, tokenUsageTickets } from "../../db/schema/tokens.ts";

const api = new Hono<{ Variables: { user: typeof auth.$Infer.Session.user } }>();
api.use("*", requireAuth as any);

// Personal usage by default. Project owners/admins can inspect actors in their
// project; other project members can only inspect their own spending.
api.get("/", async c => {
  const q = c.req.query();
  const userId = c.get("user").id;
  const scope = [];
  if (q.projectId) {
    const access = await getProjectAccess(q.projectId, userId);
    if (!access) return c.json({ error: "Project not found" }, 404);
    scope.push(eq(tokenUsage.projectId, access.project.id));
    if (!["owner", "admin"].includes(access.role)) {
      if (q.userId && q.userId !== userId) return c.json({ error: "Forbidden" }, 403);
      scope.push(eq(tokenUsage.userId, userId));
    } else if (q.userId) scope.push(eq(tokenUsage.userId, q.userId));
  } else {
    if (q.userId && q.userId !== userId) return c.json({ error: "A project with administrative access is required" }, 403);
    scope.push(eq(tokenUsage.userId, userId));
  }
  for (const [key, col] of Object.entries({ runId: tokenUsage.runId, model: tokenUsage.model, operation: tokenUsage.operation })) {
    if (q[key]) scope.push(eq(col, q[key]!));
  }
  if (q.ticketId) scope.push(inArray(tokenUsage.id, db.select({ id: tokenUsageTickets.usageId }).from(tokenUsageTickets).where(eq(tokenUsageTickets.ticketId, q.ticketId))));
  if (q.documentId) scope.push(inArray(tokenUsage.id, db.select({ id: tokenUsageDocuments.usageId }).from(tokenUsageDocuments).where(eq(tokenUsageDocuments.documentId, q.documentId))));
  const from = q.from ? new Date(q.from) : new Date(Date.now() - 30 * 86400000);
  const to = q.to ? new Date(q.to) : new Date(Math.floor(Date.now() / 1000) * 1000 + 1000);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) return c.json({ error: "Use a valid from/to date range (from inclusive, to exclusive)" }, 400);
  scope.push(gte(tokenUsage.timestamp, from), lt(tokenUsage.timestamp, to));
  const dimensions = { person: tokenUsage.userId, document: tokenUsageDocuments.documentId, ticket: tokenUsageTickets.ticketId,
    build: tokenUsage.runId, model: tokenUsage.model };
  const group = q.groupBy ?? "model";
  if (!(group in dimensions)) return c.json({ error: "groupBy must be person, document, ticket, build, or model" }, 400);
  if (group === "build") scope.push(inArray(tokenUsage.runId, db.select({ id: tokenUsageRuns.id }).from(tokenUsageRuns).where(eq(tokenUsageRuns.operation, "ticket_build"))));
  const dimension = dimensions[group as keyof typeof dimensions];
  const sums = {
    requests: sql<number>`count(*)`.mapWith(Number),
    inputTokens: sql<number>`coalesce(sum(${tokenUsage.inputTokens}), 0)`.mapWith(Number),
    outputTokens: sql<number>`coalesce(sum(${tokenUsage.outputTokens}), 0)`.mapWith(Number),
    totalTokens: sql<number>`coalesce(sum(${tokenUsage.totalTokens}), 0)`.mapWith(Number),
    cacheReadTokens: sql<number>`coalesce(sum(${tokenUsage.cacheReadTokens}), 0)`.mapWith(Number),
    cacheWriteTokens: sql<number>`coalesce(sum(${tokenUsage.cacheWriteTokens}), 0)`.mapWith(Number),
    knownCost: sql<number | null>`sum(${tokenUsage.cost})`,
    requestsWithoutCost: sql<number>`sum(case when ${tokenUsage.cost} is null then 1 else 0 end)`.mapWith(Number),
  };
  const [total] = await db.select(sums).from(tokenUsage).where(and(...scope));
  const query = db.select({ key: dimension, provider: tokenUsage.provider, model: tokenUsage.model, billingMode: tokenUsage.billingMode, ...sums }).from(tokenUsage).$dynamic();
  if (group === "document") query.innerJoin(tokenUsageDocuments, eq(tokenUsageDocuments.usageId, tokenUsage.id));
  if (group === "ticket") query.innerJoin(tokenUsageTickets, eq(tokenUsageTickets.usageId, tokenUsage.id));
  const rows = await query.where(and(...scope)).groupBy(dimension, tokenUsage.provider, tokenUsage.model, tokenUsage.billingMode);
  return c.json({ from: from.toISOString(), to: to.toISOString(), groupBy: group, total, rows,
    documentAttribution: "Associated requests; a request can involve multiple documents. Document rows are not additive. Overall totals count each request once.",
    ticketAttribution: "Associated requests; creating or discussing several tickets in one request does not multiply the overall total.",
    costBasis: "Provider-reported API cost where available; null means unknown or subscription billing." });
});
export default api;
