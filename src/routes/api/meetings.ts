/**
 * Meeting agent API: add LFG to a call, list calls, read a call's transcript, remove LFG,
 * and the public endpoint the bot service delivers the live transcript to.
 */
import { Hono } from "hono";
import { requireAuth } from "../../auth/middleware.ts";
import { getProjectAccess } from "../../auth/project-access.ts";
import {
  MeetingError, handleMeetingEvent, leaveMeeting, listMeetings, listSegments, meetingByToken, meetingForUser,
  meetingSetupProblem, refreshActiveMeetings, rememberScreenShare, startMeeting, type Meeting,
} from "../../services/meetings/meeting-agent.ts";
import { parseRealtimeEvent, verifySignature } from "../../services/meetings/recall.ts";
import type { auth } from "../../auth/index.ts";

type AuthEnv = { Variables: { user: typeof auth.$Infer.Session.user; session: typeof auth.$Infer.Session.session } };
const meetingsApi = new Hono<AuthEnv>();

const view = (m: Meeting) => ({
  id: m.id, title: m.title, status: m.status, statusDetail: m.statusDetail, platform: m.platform, meetingUrl: m.meetingUrl,
  conversationId: m.conversationId, projectId: m.projectId, createdAt: m.createdAt, startedAt: m.startedAt, endedAt: m.endedAt,
});

// Public: live transcript and meeting-chat events. The per-meeting token in the URL is the
// credential; when a signing secret is configured the delivery must also be signed.
meetingsApi.post("/webhook/:token", async (c) => {
  const meeting = await meetingByToken(c.req.param("token") ?? "");
  if (!meeting) return c.json({ error: "Unknown meeting" }, 404);
  const body = await c.req.text();
  if (!verifySignature(c.req.raw.headers, body)) return c.json({ error: "Bad signature" }, 401);
  let payload: unknown = null;
  try { payload = JSON.parse(body); } catch { return c.json({ error: "Invalid JSON" }, 400); }
  const event = parseRealtimeEvent(payload);
  // Answer straight away: the work an event starts (an agent turn) can take minutes.
  if (event) void handleMeetingEvent(meeting, event).catch((error) => console.error("[meetings] event failed:", (error as Error).message));
  return c.json({ ok: true });
});

meetingsApi.get("/", requireAuth, async (c) => {
  const projectId = c.req.query("projectId") || null;
  if (projectId && !(await getProjectAccess(projectId, c.get("user").id))) return c.json({ error: "Project not found" }, 404);
  if (c.req.query("refresh") === "1") await refreshActiveMeetings().catch(() => {});
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

/** A frame from the bot service's video socket. Only screen-share frames are kept, and only the latest. */
export function meetingVideoFrame(meetingId: string, data: string | Buffer): void {
  try {
    const event = parseRealtimeEvent(JSON.parse(typeof data === "string" ? data : data.toString("utf8")));
    if (event?.kind !== "frame" || !event.screenshare) return;
    rememberScreenShare(meetingId, event);
  } catch { /* not a frame */ }
}

export default meetingsApi;
