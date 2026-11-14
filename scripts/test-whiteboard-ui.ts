/**
 * The whiteboard in a real browser: bun run test:whiteboard-ui
 *
 * Serves the real page templates, scripts and stylesheet over the real board storage (an
 * in-memory database) and the real agent with a scripted stand-in for the model, then drives
 * it: draw, connect, restyle, undo, comment, ask the agent, and watch a second browser follow.
 * Pass --serve to keep the server running (on WB_PORT) for a look by hand.
 */
process.env.DATABASE_DRIVER = "sqlite";
process.env.DATABASE_URL = ":memory:";
import { readFileSync } from "node:fs";
import { chromium, type Page } from "playwright-core";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";

const { db } = await import("../src/config/db.ts");
const sqlite = (db as unknown as { $client: { exec(sql: string): void } }).$client;
sqlite.exec("CREATE TABLE IF NOT EXISTS user(id TEXT PRIMARY KEY); INSERT OR IGNORE INTO user VALUES ('u1');");
sqlite.exec(readFileSync(new URL("../drizzle/manual/20261114-whiteboards-sqlite.sql", import.meta.url), "utf8"));
sqlite.exec(readFileSync(new URL("../drizzle/manual/20261114-whiteboard-links-sqlite.sql", import.meta.url), "utf8"));
const store = await import("../src/services/whiteboards/store.ts");
const { runBoardAgent } = await import("../src/services/whiteboards/agent.ts");
const { WhiteboardPage } = await import("../src/templates/pages/whiteboard.tsx");
const { WhiteboardsPage } = await import("../src/templates/pages/whiteboards.tsx");
// Boards opened by link need no sign-in, so the real public routes are served as they are.
const { Hono } = await import("hono");
const { sharedBoardsApi } = await import("../src/routes/api/whiteboards.ts");
const { default: sharedBoardRoutes } = await import("../src/routes/shared-board.ts");
const publicApp = new Hono().route("/api/shared-boards", sharedBoardsApi).route("/", sharedBoardRoutes);

// The stand-in model: asked for a login screen it draws one, otherwise it answers in words.
const finish = (kind: string) => ({ type: "finish", finishReason: { unified: kind, raw: undefined }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } });
const say = (text: string) => [{ type: "text-start", id: "t" }, ...text.split(/(?<= )/).map((delta) => ({ type: "text-delta", id: "t", delta })), { type: "text-end", id: "t" }, finish("stop")];
const LOGIN = [
  { key: "screen", type: "frame", x: 0, y: 0, w: 390, h: 620, text: "Sign in" },
  { type: "text", x: 40, y: 70, text: "Welcome back", fontSize: 30, bold: true, color: "black" },
  { type: "text", x: 40, y: 118, text: "Sign in to see your invoices", fontSize: 15, color: "slate" },
  { key: "email", type: "rect", x: 40, y: 180, w: 310, h: 44, text: "sam@acme.co", fill: "white", stroke: "gray", align: "left", radius: 8, color: "slate" },
  { key: "password", type: "rect", x: 40, y: 240, w: 310, h: 44, text: "Password", fill: "white", stroke: "gray", align: "left", radius: 8, color: "slate" },
  { key: "go", type: "rect", x: 40, y: 310, w: 310, h: 46, text: "Sign in", fill: "accent", color: "white", bold: true, radius: 8 },
  { type: "text", x: 128, y: 380, text: "Forgot your password?", fontSize: 14, color: "accent" },
  { key: "home", type: "frame", x: 510, y: 0, w: 390, h: 620, text: "Invoices" },
  { type: "rect", x: 510, y: 0, w: 390, h: 56, text: "Invoices", fill: "black", color: "white", bold: true, radius: 0 },
  { type: "rect", x: 534, y: 84, w: 342, h: 88, text: "INV-1042 · Acme Co · $2,400 due Nov 30", fill: "white", stroke: "gray", radius: 12 },
  { type: "rect", x: 534, y: 188, w: 342, h: 88, text: "INV-1041 · Globex · $980 paid", fill: "white", stroke: "gray", radius: 12 },
  { type: "sticky", x: 960, y: 40, text: "Should refunds need approval?", fill: "pink" },
  { type: "arrow", from: "go", to: "home", text: "success" },
];
let agentDelay = 0;
const model = () => {
  let step = 0;
  return new MockLanguageModelV3({
    doStream: async (options: any) => {
      // The latest thing the person said (later entries are the agent's own tool calls and results).
      const asked = JSON.stringify(options.prompt.filter((m: any) => m.role === "user").at(-1));
      const system = JSON.stringify(options.prompt[0]);
      const origin = /Start new work at about x=(-?\d+), y=(-?\d+)/.exec(system)!;
      const place = (e: any) => ({ ...e, ...(e.x != null ? { x: e.x + Number(origin[1]), y: e.y + Number(origin[2]) } : {}) });
      let chunks: any[];
      if (/login/i.test(asked) && step === 0) chunks = [{ type: "tool-call", toolCallId: crypto.randomUUID(), toolName: "add_elements", input: JSON.stringify({ elements: LOGIN.map(place) }) }, finish("tool-calls")];
      else if (/login/i.test(asked)) chunks = say("I sketched a **sign-in screen** and the invoices screen it leads to, with a note on the open question about refunds. Want me to add the forgot-password flow?");
      else chunks = say(/\* \S+ sticky/.test(system) ? "That note says customers should be able to pay by card. It is the only payment idea on the board so far." : "Tell me what you would like on the board.");
      step++;
      return { stream: simulateReadableStream({ chunks: [{ type: "stream-start", warnings: [] }, ...chunks], initialDelayInMs: agentDelay, chunkDelayInMs: agentDelay ? 60 : 2 }) };
    },
  });
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const html = (body: unknown) => new Response(String(body), { headers: { "Content-Type": "text/html; charset=utf-8" } });
const project = { id: "p", projectId: "pub", name: "Invoicing" };
const patches: string[] = [];

const server = Bun.serve({
  port: Number(process.env.WB_PORT ?? 0), // not PORT: .env sets that to the app's own port
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    const readonly = url.searchParams.get("view") === "1";
    if (url.pathname.startsWith("/board/") || url.pathname.startsWith("/api/shared-boards/")) return publicApp.fetch(req);
    if (url.pathname === "/") return html(WhiteboardsPage({ project, user: { name: "Test" }, canEdit: true }));
    const pageMatch = /^\/projects\/pub\/whiteboards\/([\w-]+)$/.exec(url.pathname);
    if (pageMatch) {
      const board = await store.getBoard(pageMatch[1]!);
      if (!board) return new Response("Board not found", { status: 404 });
      return html(WhiteboardPage({ project, board, user: { name: url.searchParams.get("as") ?? "Priya" }, canEdit: !readonly, canChat: !readonly }));
    }
    if (url.pathname.startsWith("/public/")) { const file = Bun.file("." + url.pathname); return (await file.exists()) ? new Response(file) : new Response("", { status: 404 }); }
    if (!url.pathname.startsWith("/api/whiteboards")) return json({}, 404);
    const [, , , id, action] = url.pathname.split("/");
    if (!id) {
      if (req.method === "POST") { const board = await store.createBoard("u1", "pub", ((await req.json()) as { title?: string }).title); return json({ board: { id: board.id, title: board.title } }); }
      return json({ boards: await store.listBoards("pub"), canEdit: true });
    }
    const board = await store.getBoard(id);
    if (!board) return json({ error: "Board not found" }, 404);
    if (action === "ops") { const result = await store.applyOps(id, (await req.json()) as store.BoardOps); return json({ version: result.version }); }
    if (action === "share") return json(await store.setShare(id, ((await req.json()) as { mode: store.ShareMode | null }).mode));
    if (action === "messages") { await store.clearMessages(id); return json({ ok: true }); }
    if (action === "chat") {
      const body = (await req.json()) as { message: string; selection: string[]; viewport: { x: number; y: number; w: number; h: number } };
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({
        async start(controller) {
          try { await runBoardAgent({ board, userId: "u1", message: body.message, selection: body.selection, viewport: body.viewport, model: model(), emit: (event) => controller.enqueue(encoder.encode(JSON.stringify(event) + "\n")) }); }
          catch (error) { controller.enqueue(encoder.encode(JSON.stringify({ type: "error", message: (error as Error).message }) + "\n")); }
          controller.close();
        },
      }), { headers: { "Content-Type": "application/x-ndjson" } });
    }
    if (req.method === "PATCH") { const title = await store.renameBoard(id, ((await req.json()) as { title: string }).title); patches.push(title); return json({ title }); }
    if (req.method === "DELETE") { await store.deleteBoard(id); return json({ ok: true }); }
    const since = url.searchParams.get("since");
    if (since != null) return json({ title: board.title, ...store.changesSince(board, Number(since)) });
    return json({ board: { id: board.id, title: board.title, version: board.version }, elements: store.readElements(board), messages: (await store.listMessages(id)).map((m) => ({ role: m.role, content: m.content })), canEdit: true, canChat: true, share: { mode: store.shareModeOf(board), token: store.shareModeOf(board) ? board.shareToken : null } });
  },
});
const base = `http://localhost:${server.port}`;
if (process.argv.includes("--serve")) {
  agentDelay = 500;
  const demo = await store.createBoard("u1", "pub", "Card payments brainstorm");
  await store.applyOps(demo.id, { upserts: [
    { id: "h", type: "text", x: 0, y: -70, w: 420, h: 44, text: "What should checkout do?", fontSize: 32, bold: true, color: "auto", z: 1 },
    { id: "s1", type: "sticky", x: 0, y: 0, w: 200, h: 200, text: "Pay an invoice by card", fill: "#fde68a", fontSize: 20, z: 2 },
    { id: "s2", type: "sticky", x: 230, y: 0, w: 200, h: 200, text: "Refunds need a manager's approval", fill: "#f9a8d4", fontSize: 20, z: 3 },
    { id: "s3", type: "sticky", x: 460, y: 0, w: 200, h: 200, text: "Email a receipt straight away", fill: "#93c5fd", fontSize: 20, z: 4 },
    { id: "d", type: "diamond", x: 250, y: 300, w: 160, h: 120, text: "Over $500?", fill: "#ffffff", stroke: "#94a3b8", sw: 2, fontSize: 16, z: 5 },
    { id: "r", type: "rect", x: 500, y: 320, w: 180, h: 80, text: "Ask a manager", fill: "#c4b5fd", stroke: "#7c3aed", sw: 2, radius: 10, fontSize: 16, z: 6 },
    { id: "a1", type: "arrow", x1: 0, y1: 0, x2: 0, y2: 0, from: "s2", to: "d", stroke: "#64748b", sw: 2, z: 7 },
    { id: "a2", type: "arrow", x1: 0, y1: 0, x2: 0, y2: 0, from: "d", to: "r", text: "yes", stroke: "#64748b", sw: 2, z: 8 },
    { id: "c1", type: "comment", x: 0, y: 0, attach: "s2", ax: 190, ay: 10, author: "Sam", thread: [{ author: "Sam", text: "Is this for every refund, or only large ones?", at: Date.now() - 3600_000 }], z: 9 },
  ] });
  console.log(`Whiteboard stand-in at ${base}/projects/pub/whiteboards/${demo.id}  (list: ${base}/)`);
  await new Promise(() => {});
}

let bad = 0;
const check = (pass: boolean, label: string) => { if (!pass) bad++; console.log(`  ${pass ? "ok  " : "FAIL"} ${label}`); };
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const errors: string[] = [];
const elements = async (id: string) => store.readElements((await store.getBoard(id))!);
const until = async (probe: () => Promise<boolean>, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await probe()) return true; await new Promise((r) => setTimeout(r, 80)); } return false; };
const dragOn = async (page: Page, from: [number, number], to: [number, number], steps = 8) => { await page.mouse.move(...from); await page.mouse.down(); await page.mouse.move(...to, { steps }); await page.mouse.up(); };
const local = (page: Page) => page.evaluate(() => Array.from((window as any).LFGBoard.els.values()).map((e: any) => ({ id: e.id, type: e.type, text: e.text })));
const onScreen = (page: Page, id: string) => page.evaluate((elementId) => { const B = (window as any).LFGBoard, b = B.bbox(B.els.get(elementId)), p = B.toScreen(b.x + b.w / 2, b.y + b.h / 2); return [p.x, p.y] as [number, number]; }, id);
const open = async (path: string) => {
  const context = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource|WebSocket/.test(m.text())) errors.push(m.text()); });
  page.on("dialog", (d) => d.accept());
  await page.goto(base + path);
  return page;
};

try {
  console.log("boards list:");
  const list = await open("/");
  await list.waitForSelector("#board-new-card");
  check((await list.locator("a.board-card").count()) === 0, "a project starts with no boards, only the New board card");
  await list.click("#board-new-btn");
  await list.waitForURL(/\/whiteboards\/[\w-]+$/);
  const boardId = list.url().split("/").pop()!;
  check(!!(await store.getBoard(boardId)), "New board creates one and opens it");

  const page = list;
  await page.waitForSelector("#wb.ready");
  console.log("\nan empty board:");
  check(await page.locator("#wb-empty").isVisible(), "says it is blank and offers ways to start");
  check((await page.innerText("#wb-status")) === "Saved", "shows it is saved");

  console.log("\ndrawing:");
  await page.keyboard.press("n");
  await page.mouse.click(700, 420);
  await page.keyboard.type("Pay by card");
  await page.keyboard.press("Escape");
  check(await until(async () => (await elements(boardId)).some((e) => e.type === "sticky" && e.text === "Pay by card")), "a sticky note is placed, typed into and saved");
  check(!(await page.locator("#wb-empty").isVisible()), "the blank-board note goes away");
  await page.keyboard.press("r");
  await dragOn(page, [300, 200], [460, 320]);
  check(await until(async () => (await elements(boardId)).some((e) => e.type === "rect" && Math.round(e.w as number) === 160 && Math.round(e.h as number) === 120)), "dragging with the rectangle tool draws one that size");
  check((await page.evaluate(() => (window as any).LFGBoard.getTool())) === "select", "after drawing a shape the tool returns to select, with the shape selected");
  await page.keyboard.type("x"); // not a tool key: must not start anything odd
  await page.keyboard.press("Enter"); await page.keyboard.type("Checkout"); await page.keyboard.press("Escape");
  check(await until(async () => (await elements(boardId)).some((e) => e.type === "rect" && e.text === "Checkout")), "Enter edits the selected shape's text");

  const rect = (await elements(boardId)).find((e) => e.type === "rect")!, sticky = (await elements(boardId)).find((e) => e.type === "sticky")!;
  await page.keyboard.press("a");
  await dragOn(page, await onScreen(page, rect.id), await onScreen(page, sticky.id));
  check(await until(async () => (await elements(boardId)).some((e) => e.type === "arrow" && e.from === rect.id && e.to === sticky.id)), "an arrow drawn from one element to another attaches to both");
  await page.mouse.click(1000, 700); // clear selection
  const before = await onScreen(page, sticky.id);
  await dragOn(page, before, [before[0] + 180, before[1] + 120]);
  check(await until(async () => { const s = (await elements(boardId)).find((e) => e.id === sticky.id)!; return Math.abs((s.x as number) - (sticky.x as number) - 180) < 12 && Math.abs((s.y as number) - (sticky.y as number) - 120) < 12; }), "dragging an element moves it");
  const arrowEnd = await page.evaluate((id) => { const B = (window as any).LFGBoard; const a: any = Array.from(B.els.values()).find((e: any) => e.type === "arrow"); const b = B.bbox(a), s = B.els.get(id); return b.x + b.w > s.x - 20 && b.y + b.h > s.y - 20; }, sticky.id);
  check(arrowEnd, "the attached arrow follows the moved element");

  await page.keyboard.press("p");
  await page.mouse.move(250, 560); await page.mouse.down();
  for (let i = 1; i <= 30; i++) await page.mouse.move(250 + i * 8, 560 + Math.sin(i / 3) * 30);
  await page.mouse.up();
  check(await until(async () => (await elements(boardId)).some((e) => e.type === "pen" && (e.pts as number[]).length >= 40)), "the pen draws a freehand stroke");
  await page.keyboard.press("Control+z");
  check(await until(async () => !(await elements(boardId)).some((e) => e.type === "pen")), "undo takes the stroke away, on the server too");
  await page.keyboard.press("Control+Shift+z");
  check(await until(async () => (await elements(boardId)).some((e) => e.type === "pen")), "redo brings it back");
  await page.keyboard.press("e");
  await dragOn(page, [300, 520], [320, 600], 12);
  check(await until(async () => !(await elements(boardId)).some((e) => e.type === "pen")), "the eraser removes what it is dragged across");

  console.log("\nstyling the selection:");
  await page.keyboard.press("v");
  await page.mouse.click(...(await onScreen(page, rect.id)));
  await page.waitForSelector("#wb-bar:not([hidden])");
  await page.click('#wb-bar [data-act="fill"]');
  await page.click('#wb-palette [data-colour="#93c5fd"]');
  check(await until(async () => (await elements(boardId)).find((e) => e.id === rect.id)!.fill === "#93c5fd"), "the style bar recolours the selected shape");
  await page.click('#wb-bar [data-act="duplicate"]');
  check(await until(async () => (await elements(boardId)).filter((e) => e.type === "rect").length === 2), "Duplicate makes a copy");
  await page.keyboard.press("Delete");
  check(await until(async () => (await elements(boardId)).filter((e) => e.type === "rect").length === 1), "Delete removes the selection");

  console.log("\ncomments:");
  await page.mouse.click(...(await onScreen(page, rect.id)));
  await page.click('#wb-bar [data-act="comment"]');
  await page.fill("#wb-comment textarea", "Is this the right first step? <b>x</b>");
  await page.keyboard.press("Enter");
  check(await until(async () => (await elements(boardId)).some((e) => e.type === "comment" && e.attach === rect.id && (e.thread as any[])[0].author === "Priya")), "a comment on an element is saved, attached to it, under the person's name");
  check((await page.innerText("#wb-comment .wb-thread-item p")).includes("<b>x</b>"), "comment text is shown as text, never as markup");
  await page.fill("#wb-comment textarea", "Yes, keep it."); await page.keyboard.press("Enter");
  await page.click('#wb-comment [data-c="resolve"]');
  check(await until(async () => { const c = (await elements(boardId)).find((e) => e.type === "comment")!; return (c.thread as any[]).length === 2 && c.resolved === true; }), "replies are added to the thread and it can be resolved");

  console.log("\nasking the agent:");
  await page.mouse.click(1100, 760);
  await page.click("#wb-ask");
  await page.waitForSelector("#wb-chat.open");
  check(await page.locator("#wb-chat-context").isHidden(), "with nothing selected the chat is about the whole board");
  await page.fill("#wb-chat-input", "Sketch a login screen and where it leads");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".wb-msg.assistant .wb-msg-actions", { timeout: 15000 });
  const stored = await elements(boardId);
  check(stored.filter((e) => e.by === "agent").length === LOGIN.length, `the agent's ${LOGIN.length} elements are on the stored board`);
  check((await local(page)).filter((e) => e.type === "frame").length === 2, "and on screen without a reload");
  check((await page.innerText(".wb-msg.assistant .wb-msg-body")).startsWith("I sketched a sign-in screen"), "its reply is shown, with emphasis rendered rather than asterisks");
  const overlap = await page.evaluate(() => { const B = (window as any).LFGBoard, all = Array.from(B.els.values()) as any[]; const mine = all.filter((e) => !e.by && e.type !== "comment"), frames = all.filter((e) => e.by && e.type === "frame"); return mine.some((m) => { const a = B.bbox(m); return frames.some((f) => a.x < f.x + f.w && a.x + a.w > f.x && a.y < f.y + f.h && a.y + a.h > f.y); }); });
  check(!overlap, "what it drew does not sit on top of what was already there");
  const inView = () => page.evaluate(() => { const B = (window as any).LFGBoard, v = B.viewport(), f = (Array.from(B.els.values()) as any[]).filter((e) => e.by && e.type === "frame"); return f.every((e) => e.x >= v.x && e.x + e.w <= v.x + v.w && e.y >= v.y && e.y + e.h <= v.y + v.h); });
  check(await until(inView, 3000), "the view glides to show what was drawn");
  await page.screenshot({ path: "output/whiteboard-agent.png" });

  const noteId = sticky.id;
  await page.evaluate((id) => (window as any).LFGBoard.select([id]), noteId);
  check((await page.innerText("#wb-chat-context")).includes("the selected element"), "selecting an element makes the next question about it");
  await page.fill("#wb-chat-input", "What does this mean?"); await page.keyboard.press("Enter");
  check(await until(async () => (await page.locator(".wb-msg.assistant .wb-msg-body").last().innerText()).includes("pay by card")), "the agent answers about the selected note");
  await page.locator(".wb-msg-actions .wb-link", { hasText: "Remove what was added" }).click();
  check(await until(async () => (await elements(boardId)).filter((e) => e.by === "agent").length === 0), "one click removes everything the agent added");
  await page.keyboard.press("Control+z");
  check(await until(async () => (await elements(boardId)).filter((e) => e.type === "frame").length === 2), "and undo brings it back");

  console.log("\nworking together:");
  const other = await open(`/projects/pub/whiteboards/${boardId}?as=Sam`);
  await other.waitForSelector("#wb.ready");
  check((await local(other)).length === (await elements(boardId)).length, "a second person opening the board sees everything on it");
  check((await other.locator(".wb-msg").count()) === 4, "and the conversation with the agent so far");
  await other.keyboard.press("n"); await other.mouse.click(400, 300); await other.keyboard.type("Sam was here"); await other.keyboard.press("Escape");
  check(await until(async () => (await local(page)).some((e) => e.text === "Sam was here"), 9000), "what they add appears for the first person without a reload");
  await page.evaluate((id) => { const B = (window as any).LFGBoard; B.select([id]); B.deleteSelection(); }, noteId);
  check(await until(async () => !(await local(other)).some((e) => e.id === noteId), 9000), "and what the first person deletes disappears for them");
  check((await local(other)).some((e) => e.text === "Sam was here"), "without losing their own note");

  console.log("\nboard name and view-only:");
  await page.fill("#wb-title", "Checkout ideas"); await page.keyboard.press("Enter");
  check(await until(async () => patches.includes("Checkout ideas")), "renaming the board saves the name");
  const viewer = await open(`/projects/pub/whiteboards/${boardId}?view=1`);
  await viewer.waitForSelector("#wb.ready");
  check((await viewer.innerText("#wb-status")) === "View only" && !(await viewer.locator('[data-tool="pen"]').isVisible()) && (await viewer.locator("#wb-ask").isHidden()), "someone who may only view sees no drawing tools and no agent");
  const count = (await elements(boardId)).length;
  await viewer.keyboard.press("n"); await viewer.mouse.click(600, 400); await viewer.keyboard.press("Delete");
  await new Promise((r) => setTimeout(r, 900));
  check((await elements(boardId)).length === count, "and cannot change the board");

  console.log("\nsharing by link:");
  await page.click("#wb-share-btn");
  check((await page.inputValue("#wb-share-mode")) === "off" && (await page.locator("#wb-share-row").isHidden()), "a board starts with no link");
  await page.selectOption("#wb-share-mode", "edit");
  await page.waitForSelector("#wb-share-row:not([hidden])");
  const link = await page.inputValue("#wb-share-link");
  check(/\/board\/[\w-]{32,}$/.test(link), "choosing \"can edit\" makes a link to copy");
  check((await page.innerText("#wb-share-note")).includes("no account"), "and says what the link allows");
  const guest = await open(new URL(link).pathname);
  await guest.waitForSelector("#wb.ready");
  check(await guest.locator("#wb-guest").isVisible(), "someone opening the link with no account is asked for a name");
  await guest.fill("#wb-guest-name", "Dana"); await guest.keyboard.press("Enter");
  check((await local(guest)).length === (await elements(boardId)).length, "and sees the whole board");
  check((await guest.locator("#wb-ask").isHidden()) && (await guest.locator("#wb-share-btn").count()) === 0 && (await guest.locator(".wb-top a").count()) === 0, "with no agent, no sharing controls and no way into the project");
  await guest.keyboard.press("n"); await guest.mouse.click(420, 640); await guest.keyboard.type("Dana's idea"); await guest.keyboard.press("Escape");
  check(await until(async () => (await elements(boardId)).some((e) => e.text === "Dana's idea")), "what the guest adds is saved");
  check(await until(async () => (await local(page)).some((e) => e.text === "Dana's idea"), 9000), "and shows up for the project member");
  await guest.keyboard.press("c"); await guest.mouse.click(900, 640);
  await guest.fill("#wb-comment textarea", "Love this"); await guest.keyboard.press("Enter");
  check(await until(async () => (await elements(boardId)).some((e) => e.type === "comment" && (e.thread as any[])[0].text === "Love this" && (e.thread as any[])[0].author === "Dana")), "the guest's comment carries the name they gave");
  await page.selectOption("#wb-share-mode", "view");
  await page.waitForFunction(() => (document.getElementById("wb-share-note") as HTMLElement).innerText.includes("cannot change it"));
  check((await page.inputValue("#wb-share-link")) === link, "switching to \"can view\" keeps the same link");
  await guest.reload(); await guest.waitForSelector("#wb.ready");
  check((await guest.innerText("#wb-status")) === "View only" && !(await guest.locator('[data-tool="pen"]').isVisible()) && (await guest.locator("#wb-guest").isHidden()), "and the guest can now only look");
  await page.selectOption("#wb-share-mode", "off");
  await page.waitForSelector("#wb-share-row", { state: "hidden" });
  check((await (await fetch(link)).status) === 404, "turning the link off closes the board to guests");

  await list.goto(base + "/"); await list.waitForSelector("a.board-card");
  check((await list.innerText("a.board-card .board-title")) === "Checkout ideas", "the list shows the board under its new name");
  check(errors.length === 0, `no script errors${errors.length ? ": " + errors.join("; ") : ""}`);
} catch (error) {
  bad++; console.log("  FAIL stopped early:", (error as Error).message.split("\n")[0]);
  if (errors.length) console.log("  script errors:", errors.join("; "));
} finally {
  await browser.close();
  server.stop(true);
}
console.log(bad ? `\n${bad} FAILED` : "\nall good");
process.exit(bad ? 1 : 0);
