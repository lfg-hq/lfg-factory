/**
 * A build on someone's computer ends with a recorded walkthrough: the agent starts the app
 * and goes through the acceptance criteria in a browser LFG Desktop records. Desktop posts
 * the frames (concatenated JPEGs, 2 a second) and what the agent found; this turns them into
 * the same evidence a cloud build's feature test leaves: recording.mp4 and status.json under
 * /uploads/ticket-tests/<ticket>/<run>/, and a "Feature testing …" row in the ticket's log,
 * which the ticket's Feature testing step shows with the video and the checks.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../config/db.ts";
import { runnerJobs } from "../../db/schema/runners.ts";
import { projects } from "../../db/schema/projects.ts";
import { addLog } from "../ticket-logs.ts";

export interface WalkthroughCheck { label: string; status: "passed" | "failed" | "blocked"; expected?: string; actual?: string }
export interface WalkthroughReport { applicable: boolean; reason?: string; checks: WalkthroughCheck[] }

export const WALKTHROUGH_FPS = 2;

/** A "failed" check whose note says it couldn't be tried at all (older Desktop builds only knew passed or failed). */
export const COULD_NOT_CHECK = /^\s*(not verifiable|not verified|unverifiable|could ?n[o']?t (be )?(verif|check|test|tr[yi])|cannot (be )?(verif|check|test)|unable to (verif|check|test)|blocked\b)/i;
const MAX_FRAMES_BYTES = 300 * 1024 * 1024;

export function cleanReport(raw: unknown): WalkthroughReport {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const text = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : undefined);
  const checks = (Array.isArray(r.checks) ? r.checks : []).slice(0, 30).flatMap((c: any) => c && typeof c.label === "string" ? [{
    label: c.label.slice(0, 300),
    status: c.status === "passed" ? "passed" as const
      : c.status === "blocked" || (typeof c.actual === "string" && COULD_NOT_CHECK.test(c.actual)) ? "blocked" as const : "failed" as const,
    ...(text(c.expected, 600) ? { expected: text(c.expected, 600) } : {}),
    ...(text(c.actual, 600) ? { actual: text(c.actual, 600) } : {}),
  }] : []);
  return { applicable: r.applicable !== false, ...(text(r.reason, 300) ? { reason: text(r.reason, 300) } : {}), checks };
}

/** The ticket-log line for a walkthrough: the Feature testing step reads its first words. */
export function walkthroughMessage(report: WalkthroughReport, deviceName: string, url: string | null, video: boolean): string {
  if (!report.applicable) return `Feature testing not applicable: ${report.reason ?? "nothing in this ticket to check in a browser."}`;
  const n = report.checks.length;
  const passed = report.checks.filter(c => c.status === "passed").length;
  const blocked = report.checks.filter(c => c.status === "blocked");
  const outcome = walkthroughOutcome(report);
  const blockedNote = blocked.length ? `; ${blocked.length} couldn't be checked on this computer` : "";
  const head = outcome === "passed"
    ? `Feature testing passed on ${deviceName}: all ${n} acceptance checks confirmed in the browser.`
    : !n
      ? `Feature testing failed on ${deviceName}: ${report.reason ?? "no checks were reported."}`
      : outcome === "incomplete"
        ? `Feature testing incomplete on ${deviceName}: ${passed} of ${n} acceptance checks confirmed${blockedNote}; none failed.`
        : `Feature testing failed on ${deviceName}: ${passed} of ${n} acceptance checks confirmed${blockedNote}.`;
  const failed = report.checks.filter(c => c.status !== "passed")
    .map(c => `- ${c.status === "blocked" ? "Couldn't check: " : ""}${c.label}${c.actual ? `: ${c.actual}` : ""}`).join("\n");
  const link = url ? `\n\n[Watch recording](${url}/${video ? "recording.mp4" : "status.json"})` : "";
  return head + (failed ? `\n\n${failed}` : "") + link;
}

/** passed: every check confirmed. incomplete: none failed, but some couldn't be tried here. */
export function walkthroughOutcome(report: WalkthroughReport): "passed" | "failed" | "incomplete" {
  if (!report.checks.length || report.checks.some(c => c.status === "failed")) return "failed";
  return report.checks.some(c => c.status === "blocked") ? "incomplete" : "passed";
}

/** Concatenated JPEG frames → an MP4 a browser plays (H.264, even dimensions, fast start). */
export function encodeFrames(framesFile: string, out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "mjpeg", "-framerate", String(WALKTHROUGH_FPS), "-i", framesFile,
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out],
      { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", d => { err += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5 * 60_000);
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(0, 300)}`)); });
  });
}

/** POST /api/runner/jobs/:id/walkthrough, authenticated by the computer's own token. */
export async function handleWalkthroughUpload(req: Request, jobId: string, device: { id: string; name: string }): Promise<Response> {
  const [job] = await db.select().from(runnerJobs)
    .where(and(eq(runnerJobs.id, jobId), eq(runnerJobs.deviceId, device.id), inArray(runnerJobs.status, ["running", "succeeded"])))
    .limit(1);
  if (!job?.ticketId) return Response.json({ error: "Not found" }, { status: 404 });
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > MAX_FRAMES_BYTES + 1024 * 1024) return Response.json({ error: "Recording too large" }, { status: 413 });

  let form: Awaited<ReturnType<Request["formData"]>>;
  try { form = await req.formData(); } catch { return Response.json({ error: "Expected multipart form data" }, { status: 400 }); }
  let report: WalkthroughReport;
  try { report = cleanReport(JSON.parse(String(form.get("report") ?? "{}"))); } catch { return Response.json({ error: "Invalid report" }, { status: 400 }); }
  const frames = form.get("frames");

  const [project] = await db.select({ ownerId: projects.ownerId }).from(projects).where(eq(projects.id, job.projectId)).limit(1);
  const log = (text: string) => addLog(job.ticketId!, text, "agent_progress", project?.ownerId);

  if (!report.applicable) {
    await log(walkthroughMessage(report, device.name, null, false));
    return Response.json({ ok: true });
  }

  const key = `ticket-tests/${job.ticketId}/${crypto.randomUUID()}`;
  const url = `/uploads/${key}`;
  const { uploadBinary, uploadBinaryFile } = await import("../s3.ts");
  let video = false;
  const warnings: string[] = [];
  if (frames instanceof Blob && frames.size > 0) {
    const dir = await mkdtemp(join(tmpdir(), "lfg-walkthrough-"));
    try {
      await writeFile(join(dir, "frames.mjpeg"), Buffer.from(await frames.arrayBuffer()));
      await encodeFrames(join(dir, "frames.mjpeg"), join(dir, "recording.mp4"));
      if ((await stat(join(dir, "recording.mp4"))).size > 0) {
        await uploadBinaryFile(`${key}/recording.mp4`, join(dir, "recording.mp4"), "video/mp4");
        video = true;
      }
    } catch (error) {
      warnings.push(`The video couldn't be made: ${(error as Error).message.slice(0, 200)}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const outcome = walkthroughOutcome(report);
  const step = outcome === "passed" ? "All acceptance checks confirmed"
    : outcome === "incomplete" ? "Nothing failed, but some acceptance checks couldn't be tried on this computer"
    : report.reason ?? "Some acceptance checks failed";
  await uploadBinary(`${key}/status.json`, Buffer.from(JSON.stringify({
    status: outcome, attempt: 1, step,
    checks: report.checks.map(c => ({ label: c.label, status: c.status, expected: c.expected, actual: c.actual })),
    ...(warnings.length ? { warnings } : {}), updatedAt: Date.now(),
  })), "application/json");
  await log(walkthroughMessage(report, device.name, url, video));
  return Response.json({ ok: true, url, video });
}
