/**
 * Activity tools for the product agent.
 * Allows the agent to query recent project activity.
 */

import { tool, zodSchema } from "ai";
import { z } from "zod";
import { getProjectActivities } from "../../services/activity-log.ts";

export const getRecentActivities = tool({
  description:
    "Get recent project activity events (ticket builds, git operations, failures). Use this to understand what has happened in the project recently — especially after ticket executions.",
  inputSchema: zodSchema(z.object({
    projectId: z.string().describe("The internal project ID"),
    limit: z.number().optional().default(20).describe("Max number of activities to return (default 20)"),
  })),
  execute: async ({ projectId, limit }) => {
    const activities = await getProjectActivities(projectId, { limit });

    if (activities.length === 0) {
      return { activities: [], message: "No recent activity for this project." };
    }

    return {
      activities: activities.map((a) => ({
        type: a.activityType,
        title: a.title,
        description: a.description,
        ticketId: a.ticketId,
        createdAt: a.createdAt,
      })),
    };
  },
});
