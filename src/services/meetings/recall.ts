/**
 * Recall.ai: the service that puts the LFG bot into a Google Meet, Zoom or Teams call.
 * This file is the only place that knows Recall's API, so the join method can change
 * without touching the meeting agent.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.ts";

/** A short silent clip. Recall only lets a bot speak later if it was created with an audio output. */
const SILENT_MP3 = "SUQzBAAAAAAAIlRTU0UAAAAOAAADTGF2ZjYyLjMuMTAwAAAAAAAAAAAAAAD/81jAAAAAAAAAAAAASW5mbwAAAA8AAAALAAADzABCQkJCQkJCQkJVVVVVVVVVVVVoaGhoaGhoaGh7e3t7e3t7e3uOjo6Ojo6Ojo6hoaGhoaGhoaG0tLS0tLS0tLTHx8fHx8fHx8fa2tra2tra2trt7e3t7e3t7e3///////////8AAAAATGF2YzYyLjExAAAAAAAAAAAAAAAAJAPAAAAAAAAAA8wwWcSAAAAAAAAAAAAAAAD/8yjEAAAAA0gAAAAATEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjEOwAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjEdgAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjEsQAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=";

export const recallConfigured = () => !!env.RECALL_API_KEY;

export type MeetingStatus = "joining" | "waiting_room" | "in_call" | "ended" | "failed";

async function recall(path: string, init: { method?: string; body?: unknown } = {}, request: typeof fetch = fetch): Promise<any> {
  const response = await request(`https://${env.RECALL_REGION}.recall.ai/api/v1${path}`, {
    method: init.method ?? "GET",
    headers: { Authorization: `Token ${env.RECALL_API_KEY}`, "Content-Type": "application/json", Accept: "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) throw Object.assign(new Error(`Recall ${init.method ?? "GET"} ${path} failed (${response.status}): ${text.slice(0, 300)}`), { statusCode: response.status });
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}

/** The request body for a bot that streams its transcript, meeting chat and screen share to us. */
export function createBotBody(opts: { meetingUrl: string; botName: string; webhookUrl: string; videoSocketUrl: string | null; greeting: string; meetingId: string }) {
  const endpoints: Array<{ type: string; url: string; events: string[] }> = [
    { type: "webhook", url: opts.webhookUrl, events: ["transcript.data", "participant_events.chat_message"] },
  ];
  if (opts.videoSocketUrl) endpoints.push({ type: "websocket", url: opts.videoSocketUrl, events: ["video_separate_png.data"] });
  return {
    meeting_url: opts.meetingUrl,
    bot_name: opts.botName,
    metadata: { lfg_meeting_id: opts.meetingId },
    recording_config: {
      transcript: { provider: { recallai_streaming: { mode: "prioritize_low_latency", language_code: "en" } }, diarization: { use_separate_streams_when_available: true } },
      realtime_endpoints: endpoints,
      // Separate per-participant frames (needed to see a screen share) require this layout.
      ...(opts.videoSocketUrl ? { video_mixed_layout: "gallery_view_v2", video_separate_png: {} } : {}),
    },
    automatic_audio_output: { in_call_recording: { data: { kind: "mp3", b64_data: SILENT_MP3 } } },
    chat: { on_bot_join: { send_to: "everyone", message: opts.greeting } },
  };
}

export async function createBot(opts: Parameters<typeof createBotBody>[0], request?: typeof fetch): Promise<{ id: string }> {
  const bot = await recall("/bot/", { method: "POST", body: createBotBody(opts) }, request);
  if (!bot?.id) throw new Error("Recall did not return a bot id.");
  return { id: String(bot.id) };
}

export const leaveCall = (botId: string, request?: typeof fetch) => recall(`/bot/${botId}/leave_call/`, { method: "POST" }, request);

export const sendChat = (botId: string, message: string, request?: typeof fetch) =>
  recall(`/bot/${botId}/send_chat_message/`, { method: "POST", body: { to: "everyone", message } }, request);

export const speak = (botId: string, mp3: ArrayBuffer, request?: typeof fetch) =>
  recall(`/bot/${botId}/output_audio/`, { method: "POST", body: { kind: "mp3", b64_data: Buffer.from(mp3).toString("base64") } }, request);

/** Recall's status code ("in_call_recording", "bot.done", ...) as one of ours; null when it is not a state change we track. */
export function mapStatus(code: string | null | undefined): MeetingStatus | null {
  switch ((code ?? "").replace(/^bot\./, "")) {
    case "joining_call": return "joining";
    case "in_waiting_room": return "waiting_room";
    case "in_call_not_recording": case "in_call_recording": case "recording_permission_allowed": case "recording_permission_denied": return "in_call";
    case "call_ended": case "done": case "analysis_done": case "media_expired": return "ended";
    case "fatal": return "failed";
    default: return null;
  }
}

export async function getBotStatus(botId: string, request?: typeof fetch): Promise<{ status: MeetingStatus | null; detail: string | null }> {
  const bot = await recall(`/bot/${botId}/`, {}, request);
  const changes = Array.isArray(bot?.status_changes) ? bot.status_changes : [];
  const latest = changes[changes.length - 1] ?? bot?.status ?? null;
  return { status: mapStatus(latest?.code), detail: latest?.sub_code ?? latest?.message ?? null };
}

/**
 * Check a delivery's signature (webhook-id / webhook-timestamp / webhook-signature, HMAC-SHA256
 * over "id.timestamp.body" with the base64 key after "whsec_"). Websocket upgrades sign an empty body.
 */
export function verifySignature(headers: Headers, body: string, secret = env.RECALL_WEBHOOK_SECRET): boolean {
  if (!secret) return true;
  const id = headers.get("webhook-id") ?? headers.get("svix-id");
  const timestamp = headers.get("webhook-timestamp") ?? headers.get("svix-timestamp");
  const signatures = headers.get("webhook-signature") ?? headers.get("svix-signature");
  if (!id || !timestamp || !signatures || !secret.startsWith("whsec_")) return false;
  const expected = createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${timestamp}.${body}`).digest();
  return signatures.split(" ").some((entry) => {
    const [version, value] = entry.split(",");
    if (version !== "v1" || !value) return false;
    const given = Buffer.from(value, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

export type RecallEvent =
  | { kind: "speech"; speaker: string; text: string; offsetSeconds: number | null }
  | { kind: "chat"; speaker: string; text: string; offsetSeconds: number | null }
  | { kind: "frame"; screenshare: boolean; speaker: string; pngBase64: string };

/** One real-time delivery from Recall as an event the meeting agent understands; null for anything else. */
export function parseRealtimeEvent(payload: any): RecallEvent | null {
  const inner = payload?.data?.data;
  if (!inner || typeof payload.event !== "string") return null;
  const speaker = String(inner.participant?.name || "Someone").slice(0, 80);
  if (payload.event === "transcript.data") {
    const words = Array.isArray(inner.words) ? inner.words : [];
    const text = words.map((w: any) => String(w?.text ?? "")).join(" ").replace(/\s+/g, " ").trim();
    const offset = words[0]?.start_timestamp?.relative;
    return text ? { kind: "speech", speaker, text, offsetSeconds: typeof offset === "number" ? offset : null } : null;
  }
  if (payload.event === "participant_events.chat_message") {
    const text = String(inner.data?.text ?? "").trim();
    const offset = inner.timestamp?.relative;
    return text ? { kind: "chat", speaker, text, offsetSeconds: typeof offset === "number" ? offset : null } : null;
  }
  if (payload.event === "video_separate_png.data" && typeof inner.buffer === "string") {
    return { kind: "frame", screenshare: inner.type === "screenshare", speaker, pngBase64: inner.buffer };
  }
  return null;
}
