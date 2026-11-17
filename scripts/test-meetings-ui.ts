/**
 * Meetings page in a real browser: bun run test:meetings-ui
 *
 * Serves the real page template, script and stylesheets with a stand-in for /api/meetings,
 * then drives it: add the agent to a call, watch status and transcript update, remove it.
 * Pass --serve to keep the stand-in server running (PORT, default 8765) for a look by hand.
 */
import { chromium } from "playwright-core";
import { MeetingsPage } from "../src/templates/pages/meetings.tsx";

type Row = { id: string; title: string; status: string; statusDetail: string | null; platform: string; meetingUrl: string; conversationId: string; projectId: string; createdAt: string };
const meetings: Row[] = [{ id: "m-old", title: "Meeting · Nov 12, 4:00 PM", status: "ended", statusDetail: null, platform: "google_meet", meetingUrl: "https://meet.google.com/old-call-xyz", conversationId: "conv-old", projectId: "pub", createdAt: "2026-11-12T16:00:00Z" }];
const segments: Record<string, Array<{ seq: number; kind: string; speaker: string; text: string }>> = { "m-old": [{ seq: 1, kind: "speech", speaker: "Sam", text: "Let's wrap up." }] };
const calls: string[] = [];
let setupProblem: string | null = null;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const server = Bun.serve({
  port: Number(process.env.PORT ?? 0),
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") return new Response(String(MeetingsPage({ project: { id: "p", projectId: "pub", name: "Invoicing" }, user: { name: "Test" }, setupProblem, botName: "LFG" })), { headers: { "Content-Type": "text/html" } });
    if (url.pathname.startsWith("/public/")) { const file = Bun.file("." + url.pathname); return (await file.exists()) ? new Response(file) : new Response("", { status: 404 }); }
    if (!url.pathname.startsWith("/api/meetings")) return json({}, 404);
    const [, , , id, action] = url.pathname.split("/");
    calls.push(`${req.method} ${url.pathname}`);
    if (req.method === "POST" && !id) {
      const body = await req.json() as { meetingUrl: string; projectId: string };
      if (!/meet\.google\.com/.test(body.meetingUrl)) return json({ error: "Paste a Google Meet link (meet.google.com). Zoom and Teams are not supported yet." }, 400);
      const row: Row = { id: "m-new", title: "Meeting · Nov 13, 3:40 PM", status: "joining", statusDetail: null, platform: "google_meet", meetingUrl: body.meetingUrl, conversationId: "conv-new", projectId: body.projectId, createdAt: "2026-11-13T15:40:00Z" };
      meetings.unshift(row); segments[row.id] = [];
      return json({ meeting: row });
    }
    if (req.method === "POST" && action === "leave") { meetings.find((m) => m.id === id)!.status = "ended"; return json({ ok: true }); }
    if (id) { const after = Number(url.searchParams.get("after") ?? 0); return json({ meeting: meetings.find((m) => m.id === id), segments: (segments[id] ?? []).filter((s) => s.seq > after) }); }
    return json({ meetings, setupProblem });
  },
});
const base = `http://localhost:${server.port}`;
if (process.argv.includes("--serve")) {
  meetings.unshift({ id: "m-live", title: "Meeting · Nov 13, 3:40 PM", status: "in_call", statusDetail: null, platform: "google_meet", meetingUrl: "https://meet.google.com/abc-defg-hij", conversationId: "conv-live", projectId: "pub", createdAt: "2026-11-13T15:40:00Z" });
  segments["m-live"] = [
    { seq: 1, kind: "speech", speaker: "Priya", text: "We should let customers pay invoices by card." },
    { seq: 2, kind: "speech", speaker: "Sam", text: "Agreed, and refunds need an approval step." },
    { seq: 3, kind: "speech", speaker: "Priya", text: "Hey LFG, create a PRD on what we just discussed." },
    { seq: 4, kind: "agent", speaker: "LFG", text: "Done. I saved Card Payments PRD with the approval step for refunds." },
    { seq: 5, kind: "chat", speaker: "Sam", text: "@LFG how many tickets are pending?" },
  ];
  console.log(`Meetings page stand-in at ${base}`);
  await new Promise(() => {});
}

let bad = 0;
const check = (pass: boolean, label: string) => { if (!pass) bad++; console.log(`  ${pass ? "ok  " : "FAIL"} ${label}`); };
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(base + "/");
  await page.waitForSelector(".meeting-row");

  console.log("past calls:");
  check((await page.locator(".meeting-row").count()) === 1, "the earlier call is listed");
  check((await page.locator(".meeting-pill").first().innerText()).toLowerCase() === "ended", "it shows as ended");
  check((await page.locator("[data-leave]").count()) === 0, "an ended call has no Remove button");
  check((await page.locator(".meeting-row a").first().getAttribute("href")) === "/chat/project/pub/conversation/conv-old", "Open chat goes to the meeting's conversation");

  console.log("\nadding the agent:");
  await page.fill("#meeting-url", "https://example.com/not-a-meeting");
  await page.click("#meeting-add-btn");
  await page.waitForSelector("#meeting-note.error");
  check((await page.innerText("#meeting-note")).includes("Paste a Google Meet link"), "a link that isn't a meeting is refused with the reason");
  await page.fill("#meeting-url", "https://meet.google.com/abc-defg-hij");
  await page.click("#meeting-add-btn");
  await page.waitForSelector('.meeting-row[data-id="m-new"]');
  check((await page.innerText('.meeting-row[data-id="m-new"] .meeting-pill')).toLowerCase() === "joining", "the new call appears as joining");
  check((await page.inputValue("#meeting-url")) === "", "the link box is cleared");
  check(!(await page.locator("#meeting-note").getAttribute("class"))!.includes("error"), "the earlier error is gone");

  console.log("\nwhile the call is live:");
  meetings[0]!.status = "waiting_room";
  await page.waitForFunction(() => document.querySelector('.meeting-row[data-id="m-new"] .meeting-pill')?.getAttribute("data-status") === "waiting_room", null, { timeout: 9000 });
  check((await page.innerText('.meeting-row[data-id="m-new"] .meeting-meta')).includes("needs to admit LFG"), "waiting room: says someone must admit the agent");
  meetings[0]!.status = "in_call";
  await page.click('[data-transcript="m-new"]');
  await page.waitForSelector("#transcript-m-new .meetings-empty");
  check(true, "an empty transcript says nothing has been said yet");
  segments["m-new"]!.push({ seq: 1, kind: "speech", speaker: "Priya", text: "Hey LFG, how many tickets are pending? <b>x</b>" }, { seq: 2, kind: "agent", speaker: "LFG", text: "Four tickets are pending." });
  await page.waitForFunction(() => document.querySelectorAll("#transcript-m-new .meeting-line").length === 2, null, { timeout: 9000 });
  check((await page.locator("#transcript-m-new .meetings-empty").count()) === 0, "new lines replace the empty note without a reload");
  check((await page.locator("#transcript-m-new .meeting-line b").count()) === 2 && (await page.innerText("#transcript-m-new")).includes("<b>x</b>"), "what was said is shown as text, never as markup");
  segments["m-new"]!.push({ seq: 3, kind: "speech", speaker: "Sam", text: "Thanks." });
  await page.waitForFunction(() => document.querySelectorAll("#transcript-m-new .meeting-line").length === 3, null, { timeout: 9000 });
  check(true, "later lines are appended once each across refreshes");

  console.log("\nremoving the agent:");
  await page.click('[data-leave="m-new"]');
  await page.waitForFunction(() => document.querySelector('.meeting-row[data-id="m-new"] .meeting-pill')?.getAttribute("data-status") === "ended");
  check(calls.includes("POST /api/meetings/m-new/leave"), "Remove from call asks the server to leave");
  check((await page.locator("[data-leave]").count()) === 0, "the Remove button goes away");
  check((await page.locator("#transcript-m-new .meeting-line").count()) === 3, "the open transcript stays open");

  console.log("\nnot set up:");
  setupProblem = "The meeting agent is not set up on this server yet: it runs its browser on Mags, and MAGS_API_TOKEN is missing.";
  await page.goto(base + "/");
  await page.waitForSelector(".meeting-setup");
  check((await page.locator("#meeting-add").count()) === 0, "the form is replaced by the reason it can't be used");
  check(errors.length === 0, `no script errors${errors.length ? ": " + errors.join("; ") : ""}`);
} finally {
  await browser.close();
  server.stop(true);
}
console.log(bad ? `\n${bad} FAILED` : "\nall good");
process.exit(bad ? 1 : 0);
