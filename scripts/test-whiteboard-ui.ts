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
const live = await import("../src/services/whiteboards/live.ts");
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
/**
 * A sunrise landscape, composed the way the agent is told to draw pictures: filled freeform
 * shapes, layered back to front. It stands in for what a capable model sends when asked for one.
 */
function landscape() {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const W = 1200, H = 700, horizon = 430, out: any[] = [];
  const band = (y: number, h: number, fill: string) => out.push({ type: "rect", x: 0, y, w: W, h, fill, stroke: "none", radius: 0 });
  band(0, 150, "#7fb4e6"); band(140, 110, "#a9cdee"); band(240, 90, "#f6c9a4"); band(320, 115, "#fde2b3");
  out.push({ type: "ellipse", x: 470, y: 250, w: 300, h: 300, fill: "#fff1c2", stroke: "none", opacity: 0.45 });
  out.push({ type: "ellipse", x: 530, y: 310, w: 180, h: 180, fill: "#ffd04f", stroke: "none" });
  for (const [x, y, w] of [[150, 90, 190], [820, 130, 230], [430, 60, 150]] as const) {
    out.push({ type: "path", closed: true, fill: "#ffffff", opacity: 0.85, points: [[x, y + 30], [x + w * 0.15, y + 8], [x + w * 0.35, y], [x + w * 0.55, y + 6], [x + w * 0.75, y - 2], [x + w, y + 22], [x + w * 0.9, y + 40], [x + w * 0.5, y + 46], [x + w * 0.12, y + 42]] });
  }
  const range = (base: number, peaks: Array<[number, number]>, fill: string) => {
    const points: number[][] = [[0, base]];
    for (const [x, top] of peaks) { points.push([x - 60 - rnd() * 40, top + 70 + rnd() * 30], [x, top], [x + 50 + rnd() * 40, top + 60 + rnd() * 40]); }
    points.push([W, base]);
    out.push({ type: "path", closed: true, smooth: false, fill, points });
  };
  range(horizon + 6, [[140, 250], [330, 215], [760, 230], [960, 200], [1130, 265]], "#9fb0d0");
  range(horizon + 6, [[60, 300], [250, 255], [470, 320], [850, 270], [1060, 305]], "#6f83a8");
  for (const [x, top] of [[330, 215], [960, 200], [250, 255], [850, 270]] as const) {
    out.push({ type: "path", closed: true, smooth: false, fill: "#ffffff", opacity: 0.92, points: [[x, top], [x + 26, top + 34], [x + 10, top + 28], [x - 2, top + 42], [x - 14, top + 27], [x - 28, top + 36]] });
  }
  band(horizon, H - horizon, "#9ccf7a");
  const hill = (points: number[][], fill: string) => out.push({ type: "path", closed: true, fill, points });
  hill([[0, 470], [120, 425], [260, 410], [400, 428], [520, 455], [540, 520], [0, 540]], "#8cc56c");
  hill([[W, 480], [1090, 428], [940, 412], [800, 426], [690, 452], [670, 520], [W, 545]], "#84bf66");
  hill([[0, 560], [180, 520], [360, 545], [470, 600], [0, 640]], "#6fae57");
  hill([[W, 570], [1010, 525], [840, 548], [740, 610], [W, 650]], "#6aa953");
  // The river: narrow at the horizon, widening and winding toward the viewer.
  const centre = (t: number) => 610 + Math.sin(t * 3.4) * 95 * (0.25 + t), half = (t: number) => 9 + 205 * Math.pow(t, 1.7);
  const left: number[][] = [], right: number[][] = [];
  for (let i = 0; i <= 12; i++) { const t = i / 12, y = horizon + 4 + t * (H - horizon - 4); left.push([centre(t) - half(t), y]); right.push([centre(t) + half(t), y]); }
  out.push({ type: "path", closed: true, fill: "#5fa8dc", points: [...left, ...right.reverse()] });
  out.push({ type: "path", closed: true, fill: "#ffe9a8", opacity: 0.4, points: [0.08, 0.3, 0.55, 0.8].flatMap((t) => [[centre(t) - half(t) * 0.25, horizon + t * 266]]).concat([0.8, 0.55, 0.3, 0.08].map((t) => [centre(t) + half(t) * 0.3, horizon + t * 266])) });
  for (const t of [0.35, 0.55, 0.72, 0.88]) out.push({ type: "path", stroke: "#d8eefc", strokeWidth: 2.5, opacity: 0.8, points: [[centre(t) - half(t) * 0.5, horizon + t * 266], [centre(t) - half(t) * 0.15, horizon + t * 266 - 5], [centre(t) + half(t) * 0.2, horizon + t * 266 + 2], [centre(t) + half(t) * 0.45, horizon + t * 266 - 3]] });
  // Trees on both banks, the far ones first so nearer ones overlap them.
  const trees: Array<{ x: number; y: number; pine: boolean }> = [];
  for (let i = 0; i < 26; i++) {
    const t = 0.06 + rnd() * 0.9, y = horizon + 8 + t * 250, edge = half(t) + 34 + rnd() * 30, side = i % 2 ? 1 : -1;
    const x = side < 0 ? 30 + rnd() * Math.max(20, centre(t) - edge - 40) : centre(t) + edge + rnd() * Math.max(20, W - 40 - centre(t) - edge);
    trees.push({ x, y, pine: rnd() < 0.42 });
  }
  trees.sort((a, b) => a.y - b.y);
  const greens = ["#3f8f4a", "#4fa055", "#2f7d43", "#5aad5c", "#3b8a52"];
  for (const tree of trees) {
    const k = 0.32 + ((tree.y - horizon) / 260) * 1.05, { x, y } = tree, green = greens[Math.floor(rnd() * greens.length)]!;
    out.push({ type: "ellipse", x: x - 26 * k, y: y - 5 * k, w: 52 * k, h: 12 * k, fill: "#2e5d33", stroke: "none", opacity: 0.25 });
    out.push({ type: "rect", x: x - 5 * k, y: y - 46 * k, w: 10 * k, h: 48 * k, fill: "#7a5433", stroke: "none", radius: 2 });
    if (tree.pine) for (let layer = 0; layer < 3; layer++) { const w = (62 - layer * 14) * k, top = y - (74 + layer * 30) * k; out.push({ type: "path", closed: true, smooth: false, fill: layer === 2 ? "#3a8a55" : "#2f7a4b", points: [[x, top], [x + w / 2, top + 46 * k], [x - w / 2, top + 46 * k]] }); }
    else {
      const blob = (cx: number, cy: number, r: number, fill: string) => out.push({ type: "path", closed: true, fill, points: Array.from({ length: 9 }, (_, i) => { const a = (i / 9) * Math.PI * 2, rr = r * (0.82 + rnd() * 0.3); return [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.9]; }) });
      blob(x - 16 * k, y - 62 * k, 26 * k, green); blob(x + 17 * k, y - 66 * k, 27 * k, green); blob(x, y - 88 * k, 30 * k, greens[(greens.indexOf(green) + 3) % greens.length]!);
    }
  }
  for (const [x, y] of [[300, 150], [345, 132], [392, 158], [720, 110], [770, 126]] as const) out.push({ type: "path", stroke: "#3b4252", strokeWidth: 2, points: [[x - 14, y - 3], [x - 6, y - 10], [x, y], [x + 7, y - 10], [x + 15, y - 4]] });
  return out;
}
let agentDelay = 0;
const model = () => {
  let step = 0;
  return new MockLanguageModelV3({
    doStream: async (options: any) => {
      // The latest thing the person said (later entries are the agent's own tool calls and results).
      const asked = JSON.stringify(options.prompt.filter((m: any) => m.role === "user").at(-1));
      const system = JSON.stringify(options.prompt[0]);
      const origin = /Start new work at about x=(-?\d+), y=(-?\d+)/.exec(system)!;
      const place = (e: any) => ({ ...e, ...(e.x != null ? { x: e.x + Number(origin[1]), y: e.y + Number(origin[2]) } : {}), ...(e.points ? { points: e.points.map((p: number[]) => [p[0]! + Number(origin[1]), p[1]! + Number(origin[2])]) } : {}) });
      let chunks: any[];
      if (/landscape/i.test(asked) && step === 0) chunks = [{ type: "tool-call", toolCallId: crypto.randomUUID(), toolName: "add_elements", input: JSON.stringify({ elements: landscape().map(place) }) }, finish("tool-calls")];
      else if (/landscape/i.test(asked)) chunks = say("I drew a sunrise over a mountain range, with a river winding toward you between two green banks of trees.");
      else if (/login/i.test(asked) && step === 0) chunks = [{ type: "tool-call", toolCallId: crypto.randomUUID(), toolName: "add_elements", input: JSON.stringify({ elements: LOGIN.map(place) }) }, finish("tool-calls")];
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
const modelPicks: string[] = [];
const MODELS = [{ key: "claude_fast", label: "Claude Fast", provider: "Anthropic" }, { key: "gpt_big", label: "GPT Big", provider: "OpenAI" }];
const origin = (req: Request) => req.headers.get("X-Board-Client");
const cookieName = (req: Request) => decodeURIComponent(/(?:^|; )wb_as=([^;]+)/.exec(req.headers.get("Cookie") ?? "")?.[1] ?? "Priya");

const server = Bun.serve({
  port: Number(process.env.WB_PORT ?? 0), // not PORT: .env sets that to the app's own port
  idleTimeout: 60,
  websocket: {
    open: (ws: any) => live.boardSockets.open(ws),
    message: (ws: any, data: string | Buffer) => live.boardSockets.message(ws, data),
    close: (ws: any) => live.boardSockets.close(ws),
  },
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws/board") {
      // Guests are let in by the real rule (a link that is on); members are whoever the page was opened as.
      const token = url.searchParams.get("token");
      const shared = token ? await store.boardByShareToken(token) : null;
      const member = token ? null : await store.getBoard(url.searchParams.get("board") ?? "");
      const info = shared ? { boardId: shared.id, name: url.searchParams.get("name") || "Guest", canEdit: store.shareModeOf(shared) === "edit", guest: true }
        : member ? { boardId: member.id, name: cookieName(req), canEdit: !/view=1/.test(req.headers.get("Cookie") ?? ""), guest: false } : null;
      if (!info) return new Response("Unauthorized", { status: 401 });
      return server.upgrade(req, { data: { board: info } }) ? (undefined as unknown as Response) : new Response("Upgrade failed", { status: 500 });
    }
    if (url.pathname === "/api/settings/model") { modelPicks.push(((await req.json()) as { modelKey: string }).modelKey); return json({ success: true }); }
    const readonly = url.searchParams.get("view") === "1";
    if (url.pathname.startsWith("/board/") || url.pathname.startsWith("/api/shared-boards/")) return publicApp.fetch(req);
    // The chat page's right panel, reduced to what the Boards tab and a board card need: the real
    // pane markup's ids, the real scripts and stylesheet, and the two panel functions they call.
    if (url.pathname === "/panel") return html(`<!DOCTYPE html><html data-theme="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="/public/css/theme-variables.css"><link rel="stylesheet" href="/public/css/boards-tab.css">
      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css">
      <style>body{margin:0;display:flex;height:100vh;background:#121212;color:#e2e8f0;font-family:system-ui}#chat{width:38%;padding:16px;display:flex;flex-direction:column;gap:10px}#chat-input{margin-top:auto}#side{flex:1;display:flex;flex-direction:column;border-left:1px solid #333}.tab-pane{display:none;flex:1;min-height:0}.tab-pane.active{display:block}</style></head><body>
      <div id="chat"><div id="cards"></div><textarea id="chat-input" rows="2"></textarea></div>
      <div id="side"><div><button class="tab-button active" data-tab="filebrowser">Docs</button><button class="tab-button" data-tab="boards">Boards</button></div>
        <div class="tab-pane active" id="filebrowser">Docs</div>
        <div class="tab-pane" id="boards"><div class="boards-tab" id="boards-root" data-project-id="pub"><div class="boards-tab-head">
          <button type="button" class="boards-tab-back" id="boards-tab-back" hidden>back</button><h3 class="boards-tab-title" id="boards-tab-title">Whiteboards</h3>
          <a class="boards-tab-full" id="boards-tab-full" target="_blank" hidden>full</a><button type="button" class="boards-tab-new" id="boards-tab-new">New board</button></div>
          <p class="boards-tab-note" id="boards-tab-note"></p><div class="boards-tab-list" id="boards-tab-list"></div><iframe class="boards-tab-frame" id="boards-tab-frame" hidden></iframe></div></div></div>
      <script>window.panelOpened = 0; window.ArtifactsPanel = { open() { window.panelOpened++; } };
        window.switchTab = (id) => { document.querySelectorAll(".tab-button").forEach(b => b.classList.toggle("active", b.dataset.tab === id)); document.querySelectorAll(".tab-pane").forEach(p => p.classList.toggle("active", p.id === id)); };
        document.querySelectorAll(".tab-button").forEach(b => b.addEventListener("click", () => window.switchTab(b.dataset.tab)));</script>
      <script src="/public/js/boards-tab.js"></script><script src="/public/js/chat-artifacts.js"></script></body></html>`);
    if (url.pathname === "/") return html(WhiteboardsPage({ project, user: { name: "Test" }, canEdit: true }));
    const pageMatch = /^\/projects\/pub\/whiteboards\/([\w-]+)$/.exec(url.pathname);
    if (pageMatch) {
      const board = await store.getBoard(pageMatch[1]!);
      if (!board) return new Response("Board not found", { status: 404 });
      const as = url.searchParams.get("as") ?? "Priya";
      const response = html(WhiteboardPage({ project, board, user: { name: as }, canEdit: !readonly, canChat: !readonly, embed: url.searchParams.get("embed") === "1" }));
      response.headers.append("Set-Cookie", `wb_as=${encodeURIComponent(as)}; Path=/`);
      response.headers.append("Set-Cookie", `view=${readonly ? 1 : 0}; Path=/`);
      return response;
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
    if (action === "ops") { const result = await store.applyOps(id, (await req.json()) as store.BoardOps, { origin: origin(req) }); return json({ version: result.version }); }
    if (action === "share") { const share = await store.setShare(id, ((await req.json()) as { mode: store.ShareMode | null }).mode); live.closeGuests(id); return json(share); }
    if (action === "messages") { await store.clearMessages(id); return json({ ok: true }); }
    if (action === "chat") {
      const body = (await req.json()) as { message: string; selection: string[]; viewport: { x: number; y: number; w: number; h: number } };
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({
        async start(controller) {
          try {
            const reply = await runBoardAgent({ board, userId: "u1", message: body.message, selection: body.selection, viewport: body.viewport, model: model(), origin: origin(req), emit: (event) => controller.enqueue(encoder.encode(JSON.stringify(event) + "\n")) });
            live.broadcast(id, { t: "chat", name: cookieName(req), message: body.message, reply }, origin(req), { membersOnly: true });
          }
          catch (error) { controller.enqueue(encoder.encode(JSON.stringify({ type: "error", message: (error as Error).message }) + "\n")); }
          controller.close();
        },
      }), { headers: { "Content-Type": "application/x-ndjson" } });
    }
    if (req.method === "PATCH") { const title = await store.renameBoard(id, ((await req.json()) as { title: string }).title); patches.push(title); live.broadcast(id, { t: "title", title }, origin(req)); return json({ title }); }
    if (req.method === "DELETE") { await store.deleteBoard(id); return json({ ok: true }); }
    const since = url.searchParams.get("since");
    if (since != null) return json({ title: board.title, ...store.changesSince(board, Number(since)) });
    return json({ board: { id: board.id, title: board.title, version: board.version }, elements: store.readElements(board), messages: (await store.listMessages(id)).map((m) => ({ role: m.role, content: m.content })), canEdit: true, canChat: true, models: MODELS, model: modelPicks.at(-1) ?? "claude_fast", share: { mode: store.shareModeOf(board), token: store.shareModeOf(board) ? board.shareToken : null } });
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

  await page.fill("#wb-chat-input", "draw a landscape with a river, trees, mountains and the sun rising"); await page.keyboard.press("Enter");
  check(await until(async () => (await elements(boardId)).filter((e) => e.type === "pen" && e.closed && e.fill).length > 40, 15000), "asked for a picture, the agent draws one from filled freeform shapes");
  const picture = (await elements(boardId)).filter((e) => e.by === "agent" && (e.type === "pen" || e.fill));
  check(picture.some((e) => e.sharp) && picture.some((e) => e.type === "pen" && !e.sharp) && picture.some((e) => (e.opacity as number) < 1), "using sharp edges, flowing curves and transparency");
  await page.waitForSelector(".wb-msg.assistant:last-child .wb-msg-actions", { timeout: 15000 });
  // A clean look at the picture for the record: chat out of the way, picture filling the view.
  await page.evaluate(() => { const B = (window as any).LFGBoard; document.getElementById("wb-chat")!.style.visibility = "hidden"; B.select([]); B.flyTo(B.unionBox((Array.from(B.els.values()) as any[]).filter((e) => e.type === "pen" && e.closed)), { instant: true, pad: 70, maxZoom: 2 }); });
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: "output/whiteboard-landscape.png" });
  await page.evaluate(() => { document.getElementById("wb-chat")!.style.visibility = ""; });
  const hill = picture.find((e) => e.type === "pen" && e.closed && e.fill === "#6fae57")!;
  const picked = await page.evaluate((id) => { const B = (window as any).LFGBoard, e = B.els.get(id), s = B.toScreen(e.x + e.w * 0.2, e.y + e.h * 0.6); return [s.x, s.y]; }, hill.id);
  await page.locator(".wb-msg-actions .wb-link", { hasText: "Remove what was added" }).last().click();
  check(await until(async () => !(await elements(boardId)).some((e) => e.type === "pen" && e.closed)), "and it can be removed in one click like anything else the agent adds");
  void picked;

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
  check((await other.locator(".wb-msg").count()) === 6, "and the conversation with the agent so far");
  await other.keyboard.press("n"); await other.mouse.click(400, 300); await other.keyboard.type("Sam was here"); await other.keyboard.press("Escape");
  check(await until(async () => (await local(page)).some((e) => e.text === "Sam was here"), 9000), "what they add appears for the first person without a reload");
  await page.evaluate((id) => { const B = (window as any).LFGBoard; B.select([id]); B.deleteSelection(); }, noteId);
  check(await until(async () => !(await local(other)).some((e) => e.id === noteId), 9000), "and what the first person deletes disappears for them");
  check((await local(other)).some((e) => e.text === "Sam was here"), "without losing their own note");

  console.log("\nlive, with two people on the board:");
  const peerNames = (p: Page) => p.evaluate(() => Array.from(document.querySelectorAll("#wb-peers .wb-peer")).map((n) => n.getAttribute("title")!.split(" · ")[0]));
  check(await until(async () => (await peerNames(page)).join() === "Sam" && (await peerNames(other)).join() === "Priya"), "each sees who else is on the board");
  check(await page.evaluate(() => document.getElementById("wb")!.classList.contains("live")), "and that the board is live");
  await other.mouse.move(640, 500);
  const seen = async () => page.evaluate(() => { const p: any = Array.from((window as any).LFGBoard.peers.values())[0]; return p && p.shown ? [p.tx, p.ty] : null; });
  const there = await other.evaluate(() => { const w = (window as any).LFGBoard.toWorld(640, 500); return [Math.round(w.x), Math.round(w.y)]; });
  check(await until(async () => { const at = await seen(); return !!at && Math.abs(at[0] - there[0]) <= 1 && Math.abs(at[1] - there[1]) <= 1; }, 2000), "one person's cursor shows for the other, at the same place on the board");
  const samNote = (await local(other)).find((e) => e.text === "Sam was here")!;
  const xOf = (p: Page, id: string) => p.evaluate((elementId) => (window as any).LFGBoard.els.get(elementId).x as number, samNote.id).catch(() => NaN);
  const startX = await xOf(page, samNote.id), grab = await onScreen(other, samNote.id);
  await other.mouse.move(...grab); await other.mouse.down(); await other.mouse.move(grab[0] + 90, grab[1] + 40, { steps: 6 });
  check(await until(async () => Math.abs((await xOf(page, samNote.id)) - startX) > 40, 2000), "an element being dragged moves for the other person before it is dropped");
  check(((await elements(boardId)).find((e) => e.id === samNote.id)!.x as number) === startX, "while the stored board waits for the drop");
  await other.mouse.up();
  check(await until(async () => Math.abs(((await elements(boardId)).find((e) => e.id === samNote.id)!.x as number) - startX) > 40), "and the drop saves it");
  check(await until(async () => (await page.evaluate(() => { const p: any = Array.from((window as any).LFGBoard.peers.values())[0]; return p.sel; })).includes(samNote.id), 2000), "what one person has selected is marked for the other");
  await other.keyboard.press("n"); await other.mouse.click(520, 700); await other.keyboard.type("Fast"); await other.keyboard.press("Escape");
  const sentAt = Date.now();
  check(await until(async () => (await local(page)).some((e) => e.text === "Fast"), 1500), `a saved change arrives well inside a second or two (${Date.now() - sentAt} ms), not on the next poll`);
  await other.mouse.click(1250, 800); // nothing selected: the next question is about the whole board
  await page.click("#wb-ask").catch(() => {});
  if (!(await page.locator("#wb-chat.open").count())) await page.click("#wb-ask");
  const bubbles = await other.locator(".wb-msg").count();
  await page.fill("#wb-chat-input", "What should we add?"); await page.keyboard.press("Enter");
  check(await until(async () => (await other.locator(".wb-msg").count()) === bubbles + 2 && (await other.innerText(".wb-msg.other .wb-msg-who")) === "Priya", 5000), "a question one member asks the agent, and its answer, appear for the other member");
  check((await page.locator("#wb-chat-model option").count()) === 2 && (await page.inputValue("#wb-chat-model")) === "claude_fast", "the chat offers the models this person can use, with the current one picked");
  await page.selectOption("#wb-chat-model", "gpt_big");
  check(await until(async () => modelPicks.at(-1) === "gpt_big"), "choosing another model saves the choice");
  await other.context().close();
  check(await until(async () => (await peerNames(page)).length === 0, 3000), "when someone leaves, they disappear from the board");

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
  check(await until(async () => (await page.evaluate(() => Array.from(document.querySelectorAll("#wb-peers .wb-peer")).map((n) => n.getAttribute("title")))).some((t) => t!.startsWith("Dana (guest)")), 3000), "the member sees the guest arrive, under the name they gave");
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
  check(await until(async () => (await guest.locator("#wb.ready").count()) === 1 && (await guest.innerText("#wb-status").catch(() => "")) === "View only", 6000), "the guest's page reloads by itself when the link changes");
  check((await guest.innerText("#wb-status")) === "View only" && !(await guest.locator('[data-tool="pen"]').isVisible()) && (await guest.locator("#wb-guest").isHidden()), "and the guest can now only look");
  await page.selectOption("#wb-share-mode", "off");
  await page.waitForSelector("#wb-share-row", { state: "hidden" });
  check((await (await fetch(link)).status) === 404, "turning the link off closes the board to guests");
  check(await until(async () => (await guest.innerText("body").catch(() => "")).includes("not available"), 6000), "and the guest who had it open is shown that it is no longer available");

  console.log("\nthe chat's Boards panel:");
  const panel = await open("/panel");
  check((await panel.locator(".boards-tab-card").count()) === 0 && (await panel.evaluate(() => (window as any).panelOpened)) === 0, "nothing is loaded until the Boards tab is opened");
  await panel.click('.tab-button[data-tab="boards"]');
  await panel.waitForSelector(".boards-tab-card");
  check((await panel.innerText(".boards-tab-card b")) === "Checkout ideas", "the Boards tab lists the project's whiteboards");
  await panel.click(".boards-tab-card");
  const inner = panel.frameLocator("#boards-tab-frame");
  await inner.locator("#wb.ready").waitFor();
  check((await panel.innerText("#boards-tab-title")) === "Checkout ideas" && (await panel.locator("#boards-tab-back").isVisible()), "choosing one opens the live board in the panel, under its name");
  check((await panel.getAttribute("#boards-tab-full", "href")) === `/projects/pub/whiteboards/${boardId}`, "with a way to open it full screen");
  check((await inner.locator("#wb-ask").isHidden()) && (await inner.locator(".wb-top a").count()) === 0 && (await inner.locator('[data-tool="pen"]').isVisible()), "in the panel the board keeps its tools but leaves the agent to the chat beside it");
  const frameEls = () => panel.frames().find((f) => f.url().includes("embed=1"))!.evaluate(() => Array.from((window as any).LFGBoard.els.values()).map((e: any) => e.text));
  await store.applyOps(boardId, { upserts: [{ id: "fromchat", type: "sticky", x: 4000, y: 0, w: 200, h: 200, text: "Drawn from the chat" }] }, { by: "agent" });
  check(await until(async () => (await frameEls()).includes("Drawn from the chat"), 2000), "what the chat agent draws shows up on it at once");
  const embedded = panel.frames().find((f) => f.url().includes("embed=1"))!;
  await embedded.evaluate(() => { const B = (window as any).LFGBoard; B.select([Array.from(B.els.values()).find((e: any) => e.type === "sticky").id]); });
  await inner.locator('#wb-bar [data-act="ask"]').click();
  check(await until(async () => panel.evaluate(() => document.activeElement?.id === "chat-input"), 2000), "Ask LFG on a selection takes you to the chat's message box");
  await panel.click("#boards-tab-back");
  await panel.waitForSelector(".boards-tab-card");
  check(await panel.locator("#boards-tab-frame").isHidden(), "back returns to the list of boards");
  await panel.click('.tab-button[data-tab="filebrowser"]');
  const opened = await panel.evaluate(() => (window as any).panelOpened);
  await panel.evaluate((id) => (window as any).ChatArtifacts.render(document.getElementById("cards"), { kind: "board", id, name: "Checkout ideas" }, "pub"), boardId);
  check((await panel.innerText(".chat-artifact-card")).includes("Checkout ideas") && (await panel.innerText(".chat-artifact-card")).includes("Whiteboard"), "a board the agent drew on gets a card in the chat");
  await inner.locator("#wb.ready").waitFor();
  check((await panel.evaluate(() => (window as any).panelOpened)) > opened && (await panel.evaluate(() => document.getElementById("boards")!.classList.contains("active"))), "and the panel opens on that board by itself, so the drawing is watched as it happens");
  await panel.click("#boards-tab-back"); await panel.click('.tab-button[data-tab="filebrowser"]');
  await panel.evaluate((id) => (window as any).ChatArtifacts.render(document.getElementById("cards"), { kind: "board", id, name: "Checkout ideas" }, "pub", { replay: true }), boardId);
  await new Promise((r) => setTimeout(r, 300));
  check(!(await panel.evaluate(() => document.getElementById("boards")!.classList.contains("active"))) && (await panel.locator(".chat-artifact-card").count()) === 1, "reloading the chat's history does not pop the panel open or repeat the card");
  await panel.click(".chat-artifact-card button");
  await inner.locator("#wb.ready").waitFor();
  check(await panel.evaluate(() => document.getElementById("boards")!.classList.contains("active")), "the card's Open board button opens it");
  await panel.screenshot({ path: "output/whiteboard-panel.png" });
  await panel.context().close();

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
