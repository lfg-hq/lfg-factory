/**
 * The meeting bot against a stand-in for Google Meet: node scripts/test-meeting-bot.mjs
 *
 * Part one checks how growing, corrected and scrolled captions become transcript lines.
 * Part two runs the real bot worker in a local Chrome against a page with Meet's flow
 * (name, "Ask to join", waiting, captions that rewrite themselves, chat, leaving). It
 * proves the bot's mechanics; it cannot prove Google's real page still matches.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createCaptionAssembler, unseenPart } from "./meeting-captions.mjs";

let bad = 0;
const check = (pass, label) => { if (!pass) bad++; console.log(`  ${pass ? "ok  " : "FAIL"} ${label}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("captions:");
{
  let t = 0;
  const a = createCaptionAssembler({ quietMs: 1000, now: () => t });
  const out = [];
  const show = (blocks, at) => { t = at; out.push(...a.update(blocks)); };
  show([{ id: "1", speaker: "Priya", text: "Hey LFG" }], 0);
  show([{ id: "1", speaker: "Priya", text: "Hey LFG, create a PRD" }], 400);
  check(out.length === 0, "nothing is reported while the speaker is mid-sentence");
  show([{ id: "1", speaker: "Priya", text: "Hey LFG, create a PRD" }], 1500);
  check(same(out, [{ speaker: "Priya", text: "Hey LFG, create a PRD" }]), "a pause finishes the line");
  show([{ id: "1", speaker: "Priya", text: "Hey LFG, create a PRD on payments." }], 1600);
  show([{ id: "1", speaker: "Priya", text: "Hey LFG, create a PRD on payments." }, { id: "2", speaker: "Sam", text: "Good idea" }], 1700);
  check(same(out[1], { speaker: "Priya", text: "on payments." }), "someone else starting finishes the line, and only the new words are reported");
  show([{ id: "2", speaker: "Sam", text: "Good idea" }], 1800);
  show([], 1900);
  check(same(out[2], { speaker: "Sam", text: "Good idea" }) && out.length === 3, "a block leaving the screen is reported once");
  check(unseenPart("we should let customers pay by card", "customers pay by card and by bank transfer") === " and by bank transfer", "when the start scrolls away, only the new end is taken");
  check(unseenPart("refunds need an approvals", "refunds need an approval step") === " step", "a corrected word does not repeat the whole line");
  t = 5000;
  const long = "This is a sentence about the plan. ".repeat(12);
  const b = createCaptionAssembler({ quietMs: 1000, now: () => t });
  const first = b.update([{ id: "9", speaker: "Sam", text: long + "And one more" }]);
  check(first.length === 1 && first[0].text.endsWith("plan.") && same(b.flush(), [{ speaker: "Sam", text: "And one more" }]), "a long unbroken stretch is reported in finished sentences");
}

// ── A stand-in for Google Meet ───────────────────────────────────────────────
const PAGE = `<!doctype html><title>Meet stand-in</title><body>
<div id="pre"><input aria-label="Your name" placeholder="Your name"><button id="ask">Ask to join</button></div>
<div id="wait" hidden>Asking to be let in...</div>
<div id="call" hidden>
  <div data-participant-id="a"></div><div data-participant-id="b"></div>
  <button aria-label="Turn on captions (c)" id="cc">cc</button>
  <button aria-label="Chat with everyone" id="chatbtn">chat</button>
  <button aria-label="Leave call" id="leave">leave</button>
  <div id="panel" hidden><div id="msgs"></div><textarea aria-label="Send a message"></textarea></div>
</div>
<div id="over" hidden>You left the meeting</div>
<script>
const $ = (id) => document.getElementById(id);
const post = (what, body) => fetch("/event/" + what, { method: "POST", body: JSON.stringify(body || {}) });
$("ask").onclick = () => { post("asked", { name: document.querySelector("input").value }); $("pre").hidden = true; $("wait").hidden = false; setTimeout(() => { $("wait").hidden = true; $("call").hidden = false; }, 1200); };
$("chatbtn").onclick = () => { $("panel").hidden = false; };
$("leave").onclick = () => { $("call").hidden = true; $("over").hidden = false; post("left"); };
let n = 0;
function message(sender, text) { const g = document.createElement("div"); g.innerHTML = "<div></div><div data-message-id='m" + (++n) + "'></div>"; g.children[0].textContent = sender + " 3:41 PM"; g.children[1].textContent = text; $("msgs").appendChild(g); }
document.querySelector("textarea").addEventListener("keydown", (e) => { if (e.key !== "Enter") return; e.preventDefault(); const text = e.target.value; e.target.value = ""; post("chat", { text }); message("You", text); });
function block(id, speaker) { const d = document.createElement("div"); d.id = id; d.innerHTML = "<div><img alt=''><span></span></div><div></div>"; d.querySelector("span").textContent = speaker; return d; }
$("cc").onclick = () => {
  const region = document.createElement("div"); region.setAttribute("role", "region"); region.setAttribute("aria-label", "Captions"); $("call").appendChild(region);
  const say = (id, speaker, text, at) => setTimeout(() => { let b = $(id); if (!b) region.appendChild(b = block(id, speaker)); b.children[1].textContent = text; }, at);
  say("b1", "Priya Shah", "We should let", 300);
  say("b1", "Priya Shah", "We should let customers pay by card.", 900);
  say("b2", "Sam Lee", "Hey LFG", 3200);
  say("b2", "Sam Lee", "Hey LFG, how many tickets are pending?", 3800);
  setTimeout(() => message("Sam Lee", "@LFG and which is oldest?"), 6500);
};
</script>`;
const events = [];
const server = createServer((req, res) => {
  if (req.method === "POST") { let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => { events.push([req.url.split("/").pop(), JSON.parse(body || "{}")]); res.end("ok"); }); return; }
  res.setHeader("Content-Type", "text/html"); res.end(PAGE);
});
await new Promise((r) => server.listen(0, r));

console.log("\nthe bot in a call:");
const child = spawn("node", ["scripts/meeting-bot-worker.mjs"], { stdio: ["pipe", "pipe", "inherit"] });
const got = [];
let buffer = "";
child.stdout.on("data", (d) => { buffer += d; let i; while ((i = buffer.indexOf("\n")) >= 0) { try { got.push(JSON.parse(buffer.slice(0, i))); } catch {} buffer = buffer.slice(i + 1); } });
const until = async (test, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
const tell = (o) => child.stdin.write(JSON.stringify(o) + "\n");
tell({ localChrome: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", meetingUrl: `http://localhost:${server.address().port}/abc-defg-hij`, botName: "LFG", greeting: "LFG joined and is taking notes." });

const statuses = () => got.filter((e) => e.type === "status").map((e) => e.status);
const speech = () => got.filter((e) => e.type === "speech").map((e) => `${e.speaker}: ${e.text}`);
check(await until(() => statuses().includes("in_call")), "it asks to join, waits to be let in, and gets into the call");
check(same(statuses(), ["waiting_room", "in_call"]), "it reports waiting, then in the call");
check(events.some(([what, body]) => what === "asked" && body.name === "LFG"), "it joins under its own name");
check(await until(() => events.some(([what, body]) => what === "chat" && body.text === "LFG joined and is taking notes.")), "it announces itself in the meeting chat");
check(await until(() => speech().length >= 2), "it hears what is said");
check(same(speech(), ["Priya Shah: We should let customers pay by card.", "Sam Lee: Hey LFG, how many tickets are pending?"]), "each line is reported once, complete, with the speaker's name");
check(await until(() => got.some((e) => e.type === "chat")), "it reads the meeting chat");
const typed = got.filter((e) => e.type === "chat");
check(typed.length === 1 && typed[0].text === "@LFG and which is oldest?" && typed[0].speaker === "Sam Lee", "a typed message comes with its sender, and the bot's own messages are not echoed back");
tell({ cmd: "chat", text: "Four tickets are pending." });
check(await until(() => events.some(([what, body]) => what === "chat" && body.text === "Four tickets are pending.")), "it posts an answer in the meeting chat");
tell({ cmd: "screenshot", id: "s1" });
check(await until(() => got.some((e) => e.type === "screenshot" && e.id === "s1" && e.jpegBase64.length > 1000 && e.presenting === false)), "it can show what is on screen, and knows nobody is presenting");
tell({ cmd: "leave" });
check(await until(() => statuses().includes("ended")), "asked to leave, it reports the call as ended");
check(await until(() => events.some(([what]) => what === "left")), "and it presses Leave rather than just vanishing");
await until(() => child.exitCode !== null, 15000);
check(child.exitCode === 0, "the worker exits cleanly");
server.close();
console.log(bad ? `\n${bad} FAILED` : "\nall good");
process.exit(bad ? 1 : 0);
