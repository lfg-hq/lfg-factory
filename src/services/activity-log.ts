/**
 * Activity Log Service
 *
 * Logs project activities (ticket events, git operations, orchestrator actions)
 * and broadcasts them to the project owner via WebSocket.
 */

import { db } from "../config/db.ts";
import { projectActivities } from "../db/schema/activities.ts";
import { projects } from "../db/schema/projects.ts";
import { eq, desc } from "drizzle-orm";
import { broadcastToUser } from "../ws/connection-manager.ts";

interface LogActivityParams {
  projectId: string;
  ticketId?: string;
  actorType?: "system" | "user" | "ai";
  activityType: string;
  title: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export async function logActivity(params: LogActivityParams): Promise<void> {
  const {
    projectId,
    ticketId,
    actorType = "system",
    activityType,
    title,
    description,
    metadata,
  } = params;

  try {
    const [activity] = await db
      .insert(projectActivities)
      .values({
        projectId,
        ticketId,
        actorType,
        activityType,
        title,
        description,
        metadata,
      })
      .returning();

    // Find project owner to broadcast to
    const [project] = await db
      .select({ ownerId: projects.ownerId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (project && activity) {
      broadcastToUser(project.ownerId, {
        type: "activity_update",
        activity: {
          id: activity.id,
          projectId: activity.projectId,
          ticketId: activity.ticketId,
          actorType: activity.actorType,
          activityType: activity.activityType,
          title: activity.title,
          description: activity.description,
          metadata: activity.metadata,
          createdAt: activity.createdAt,
        },
      });
    }
  } catch (err) {
    console.error(`[activity-log] Failed to log activity:`, err);
  }
}

export async function getProjectActivities(
  projectId: string,
  { limit = 50, offset = 0 }: { limit?: number; offset?: number } = {}
) {
  return db
    .select()
    .from(projectActivities)
    .where(eq(projectActivities.projectId, projectId))
    .orderBy(desc(projectActivities.createdAt))
    .limit(limit)
    .offset(offset);
}
