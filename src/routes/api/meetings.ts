/** Meeting agent API: add LFG to a call, list calls, read a call's transcript, remove LFG. */
import { Hono } from "hono";
import { requireAuth } from "../../auth/middleware.ts";
import { getProjectAccess } from "../../auth/project-access.ts";
import {
  MeetingError, leaveMeeting, listMeetings, listSegments, meetingForUser, meetingSetupProblem, startMeeting, type Meeting,
} from "../../services/meetings/meeting-agent.ts";
import type { auth } from "../../auth/index.ts";

type AuthEnv = { Variables: { user: typeof auth.$Infer.Session.user; session: typeof auth.$Infer.Session.session } };
const meetingsApi = new Hono<AuthEnv>();

const view = (m: Meeting) => ({
  id: m.id, title: m.title, status: m.status, statusDetail: m.statusDetail, platform: m.platform, meetingUrl: m.meetingUrl,
  conversationId: m.conversationId, projectId: m.projectId, createdAt: m.createdAt, startedAt: m.startedAt, endedAt: m.endedAt,
});

meetingsApi.get("/", requireAuth, async (c) => {
  const projectId = c.req.query("projectId") || null;
  if (projectId && !(await getProjectAccess(projectId, c.get("user").id))) return c.json({ error: "Project not found" }, 404);
  return c.json({ meetings: (await listMeetings(c.get("user").id, projectId)).map(view), setupProblem: meetingSetupProblem() });
});

meetingsApi.post("/", requireAuth, async (c) => {
  const body = await c.req.json<{ projectId?: string; meetingUrl?: string; title?: string }>().catch(() => ({}) as Record<string, never>);
  if (!body.projectId) return c.json({ error: "Choose a project for this meeting." }, 400);
  const access = await getProjectAccess(body.projectId, c.get("user").id);
  if (!access) return c.json({ error: "Project not found" }, 404);
  if (access.role !== "owner" && !access.permissions.canChat) return c.json({ error: "You can't use the agent in this project." }, 403);
  try {
    const meeting = await startMeeting({
      userId: c.get("user").id, projectId: access.project.projectId, projectName: access.project.name,
      meetingUrl: String(body.meetingUrl ?? ""), title: body.title,
    });
    return c.json({ meeting: view(meeting) });
  } catch (error) {
    if (error instanceof MeetingError) return c.json({ error: error.message }, 400);
    console.error("[meetings] start failed:", error);
    return c.json({ error: "LFG could not join that call." }, 500);
  }
});

meetingsApi.get("/:id", requireAuth, async (c) => {
  const meeting = await meetingForUser(c.req.param("id")!, c.get("user").id);
  if (!meeting) return c.json({ error: "Meeting not found" }, 404);
  const after = Number(c.req.query("after") ?? 0) || 0;
  const segments = await listSegments(meeting.id, after);
  return c.json({ meeting: view(meeting), segments: segments.map((s) => ({ seq: s.seq, kind: s.kind, speaker: s.speaker, text: s.text, offsetSeconds: s.offsetSeconds, createdAt: s.createdAt })) });
});

meetingsApi.post("/:id/leave", requireAuth, async (c) => {
  const meeting = await meetingForUser(c.req.param("id")!, c.get("user").id);
  if (!meeting) return c.json({ error: "Meeting not found" }, 404);
  await leaveMeeting(meeting);
  return c.json({ ok: true });
});

export default meetingsApi;
