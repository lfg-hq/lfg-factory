// Drives the REAL chat turn (handleStream) end to end against a throwaway SQLite database
// and a stubbed model provider. No network, no production data.
//   bun scripts/test-chat-turn.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { strict as assert } from "node:assert";

const dir = mkdtempSync(path.join(tmpdir(), "lfg-chat-turn-"));
process.env.DATABASE_DRIVER = "sqlite";
process.env.DATABASE_URL = path.join(dir, "test.db");
process.env.BETTER_AUTH_SECRET ||= "test-secret-for-chat-turn";
process.env.CHAT_BUILD_EVENT_TURNS = "0";
const push = spawnSync("bunx", ["drizzle-kit", "push", "--force"], { env: process.env, encoding: "utf8" });
assert.equal(push.status, 0, "schema push failed: " + push.stderr?.slice(-400));

// ── Stub provider: scripted DeepSeek-style chat completions, every request recorded ──
type Scripted = { text?: string; tool?: { name: string; args: unknown }; finish?: string; error?: { status: number; body: unknown } };
const script: Scripted[] = [];
const requests: any[] = [];
const sse = (r: Scripted) => {
  const chunk = (delta: unknown, finish: string | null = null, usage?: unknown) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
  let out = chunk({ role: "assistant", content: "" });
  if (r.text) out += chunk({ content: r.text });
  if (r.tool) out += chunk({ tool_calls: [{ index: 0, id: "call_" + requests.length, type: "function", function: { name: r.tool.name, arguments: JSON.stringify(r.tool.args) } }] });
  out += chunk({}, r.finish ?? (r.tool ? "tool_calls" : "stop"), { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020 });
  return out + "data: [DONE]\n\n";
};
globalThis.fetch = (async (url: any, init: any) => {
  if (!String(url).includes("api.deepseek.com")) return new Response("blocked in test", { status: 503 });
  const body = JSON.parse(init.body);
  if (JSON.stringify(body.messages).includes("Generate a short, descriptive title")) return new Response(sse({ text: "Test chat" }), { headers: { "content-type": "text/event-stream" } });
  requests.push(body);
  const next = script.shift();
  assert(next, "unexpected model request #" + requests.length);
  if (next.error) return new Response(JSON.stringify(next.error.body), { status: next.error.status, headers: { "content-type": "application/json" } });
  return new Response(sse(next), { headers: { "content-type": "text/event-stream" } });
}) as typeof fetch;

const { db } = await import("../src/config/db.ts");
const { users, llmApiKeys } = await import("../src/db/schema/users.ts");
const { messages, modelSelections, conversationPlans } = await import("../src/db/schema/chat.ts");
const { handleStream } = await import("../src/ai/stream-handler.ts");
const { eq, asc } = await import("drizzle-orm");

await db.insert(users).values({ id: "u1", name: "Test", email: "t@example.test" });
await db.insert(llmApiKeys).values({ userId: "u1", deepseekApiKey: "test-key" });
await db.insert(modelSelections).values({ userId: "u1", selectedModel: "deepseek_v4_flash" });

const turn = async (userMessage: string, conversationId?: string) => {
  const events: any[] = [];
  const ws = { send: (raw: string) => { events.push(JSON.parse(raw)); return raw.length; }, data: {}, readyState: 1 } as any;
  const { conversationId: id } = await handleStream({ ws, userId: "u1", userMessage, conversationId, abortController: new AbortController() });
  return { id, events };
};
const lastUserText = (body: any) => { const m = body.messages.findLast((x: any) => x.role === "user"); return typeof m.content === "string" ? m.content : JSON.stringify(m.content); };

try {
  // ── Turn 1: the agent records a plan with a tool call, then answers ──
  script.push({ tool: { name: "updatePlan", args: { items: [{ step: "Write PRD", status: "done", note: "doc-91bc" }, { step: "Build INV-1", status: "in_progress" }] } } }, { text: "Plan saved." });
  const first = await turn("Plan the invoicing work.");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].messages.at(-1).role, "user", "the request must end on the user's message");
  assert.equal(requests[0].messages.filter((m: any) => m.role === "system").length, 1, "one system message, at the front");
  assert(requests[0].tools.some((t: any) => t.function.name === "updatePlan"), "plan tool is offered");
  assert(requests[0].max_tokens >= 12000);
  const [plan] = await db.select().from(conversationPlans).where(eq(conversationPlans.conversationId, first.id));
  assert.equal((plan!.items as any[])[1].step, "Build INV-1");
  assert(first.events.some((e) => e.notification_type === "tool_detail" && /Plan 1\/2 done/.test(e.detail ?? "")), "plan progress reaches the chat trail");
  let rows = await db.select().from(messages).where(eq(messages.conversationId, first.id)).orderBy(asc(messages.createdAt));
  const saved = rows.find((r) => r.role === "assistant")!;
  assert.equal(saved.endReason, "complete");
  assert((saved.toolSteps as any[]).some((m) => m.role === "tool"), "tool steps are stored as real call/result messages");

  // A background result arrives between turns.
  await db.insert(messages).values({ conversationId: first.id, role: "assistant", userRole: "operation_status", content: "INV-1: Merged into feature/invoicing." });
  await new Promise((r) => setTimeout(r, 1100)); // message timestamps have one-second resolution

  // ── Turn 2: provider rejects the prompt as too long → one retry; the reply is then cut
  //    off at the output limit → it continues instead of ending half-written ──
  script.push({ error: { status: 400, body: { error: { message: "This model's maximum context length is 128000 tokens. Please reduce the length of the messages.", type: "invalid_request_error", code: "context_length_exceeded" } } } },
    { text: "The first half of the answer", finish: "length" }, { text: " and the second half." });
  const second = await turn("What happened with INV-1, and what is next?", first.id);
  assert.equal(requests.length, 5, "overflow retried once, then the cut-off reply continued");
  const asked = lastUserText(requests[2]);
  assert(asked.startsWith("What happened with INV-1"), "the user's words come first");
  assert(asked.includes("<turn-context"), "server context rides on the user's message");
  assert(asked.includes("INV-1: Merged into feature/invoicing."), "background results are in view");
  assert(asked.includes("[>] Build INV-1"), "the plan is shown at the start of the turn");
  assert.equal(requests[2].messages.at(-1).role, "user");
  assert.equal(requests[2].messages.filter((m: any) => m.role === "system").length, 1);
  assert(requests[2].messages.some((m: any) => m.role === "tool" && String(m.content).includes("Plan 1/2 done")), "last turn's tool result is replayed, structured");
  assert(lastUserText(requests[4]).includes("cut off at the output limit"), "continuation nudge sent after a length stop");
  rows = await db.select().from(messages).where(eq(messages.conversationId, first.id)).orderBy(asc(messages.createdAt));
  const reply = rows.filter((r) => r.role === "assistant" && r.userRole !== "operation_status").at(-1)!;
  assert(reply.content.includes("The first half of the answer") && reply.content.includes("and the second half."), "both halves saved: " + reply.content);
  assert.equal(reply.endReason, "complete");
  assert(!rows.some((r) => r.content.includes("turn-context") || r.content.includes("cut off at the output limit")), "scaffolding never enters the stored transcript");
  assert(!second.events.some((e) => e.type === "error" || e.error_message), "no error reached the client");
  console.log("PASS: plan tool, user-message-last, structured replay, overflow retry and output-limit continuation through the real turn loop");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
