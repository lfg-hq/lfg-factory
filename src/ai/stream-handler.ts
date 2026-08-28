import { streamText, stepCountIs, generateText } from "ai";
import { promises as fs } from "node:fs";
import path from "node:path";
import { db } from "../config/db.ts";
import { getChatAccess } from "../services/chat-access.ts";
import { messages, conversations, modelSelections, agentRoles, chatFiles } from "../db/schema/chat.ts";
import { llmApiKeys } from "../db/schema/users.ts";
import { projects } from "../db/schema/projects.ts";
import { resolveLlmGrants, llmKeyUserId } from "../services/llm-access.ts";
import { projectFiles } from "../db/schema/documents.ts";
import { projectTickets, ticketLogs, ticketAddenda } from "../db/schema/tickets.ts";
import { projectEnvironments } from "../db/schema/project-environments.ts";
import { eq, and, desc, inArray } from "drizzle-orm";
import { getModel, getModelWithSearch, getProviderName, getLiteModel, getGoogleVisionModel, DEFAULT_MODEL_KEY } from "./provider.ts";
import { withCaching } from "./prompt-cache.ts";
import { toolsProduct, toolsTurbo } from "./tools/index.ts";
import { createInstantTools } from "./tools/instant-tools.ts";
import { setDocumentWsBroadcast, setTicketWsBroadcast } from "./tools/index.ts";
import { setMiscWsBroadcast } from "./tools/index.ts";
import { getProductSystemPrompt } from "./prompts/product.ts";
import { normalizeAskUserQuestions } from "./tools/misc-tools.ts";
import { getInstantSystemPrompt } from "./prompts/instant.ts";
import { getAgentSystemPrompt } from "./prompts/agent.ts";
import { getAgentByConversation } from "../services/agent-manager.ts";
import { createAgentTools, createWebResearchTools } from "./tools/agent-tools.ts";
import { broadcastToUser, getConnection } from "../ws/connection-manager.ts";
import { getComposioTools, listConnectors } from "../services/composio-manager.ts";
import { downloadBinary } from "../services/s3.ts";
import { createPreviewInspectTool } from "../services/dev-preview.ts";
import type { ServerWebSocket } from "bun";
import type { WsData } from "../ws/types.ts";

const MAX_HISTORY = 20; // messages to load for context
const FLUSH_CHARS = 80;
const FLUSH_MS = 80;

// ── Tool names whose arguments should be streamed to the right panel ──────────
const DOCUMENT_STREAM_TOOLS = new Set([
  "streamDocumentContent",
]);

// ── Instant-mode "card" tools that OWN the rest of the turn ──────────────────
// The card UI is the final output; any assistant text emitted AFTER one of these
// renders below the card, out of order (DeepSeek often ignores the "no text after
// the tool call" rule). Suppress trailing text once one fires — display + DB.
const TURN_CLOSING_TOOLS = new Set([
  "propose_plan",
  "propose_design",
  "create_instant_app",
]);

// ── Web search tool names (provider-specific) — notify user immediately ──────
const WEB_SEARCH_TOOLS = new Set([
  "web_search",           // OpenAI & Anthropic
  "google_search",        // Google
  "web_search_20250305",  // Anthropic alternate name
]);

// ── Strip web-search citation artifacts from AI responses ────────────────────
// OpenAI web search injects various citation markers:
//   【cite†turn0search0】  (unicode brackets)
//   ≡cite≡turn0search0≡   (triple-bar variant)
//   citeturn0search0       (bare, no delimiters)
//   (domain.com)(domain.com) trailing URL noise
const CITATION_PATTERNS = [
  /\u3010cite\u2020[^\u3011]*\u3011/g,          // 【cite†...】
  /\u2261cite\u2261[^\u2261]*\u2261/g,           // ≡cite≡...≡
  /\bcite(?:turn\d+search\d+)+\b/g,              // bare citeturn0search0...
  /\(https?:\/\/[^)]*\?utm_source=openai\)/g,    // (url?utm_source=openai)
];
function stripCitations(text: string): string {
  let cleaned = text;
  for (const re of CITATION_PATTERNS) {
    cleaned = cleaned.replace(re, "");
  }
  return cleaned;
}

function toolFileType(_toolName: string, accumulated: string): string {
  // streamDocumentContent carries fileType in args
  const m = accumulated.match(/"fileType"\s*:\s*"([^"\\]*)"/);
  return m?.[1] ?? "document";
}

// State for extracting "content" field value from streaming JSON args
interface DocStreamState {
  toolName: string;
  accumulated: string;
  contentStartPos: number | null; // position AFTER the opening quote of content value
  lastSentPos: number;
  panelOpened: boolean; // whether we've sent the initial file_stream notification
}

// Advance through `state.accumulated` starting at `lastSentPos`, decode JSON
// escapes, and return any newly available content characters.
function drainContentDelta(state: DocStreamState): string {
  if (state.contentStartPos === null) return "";
  const slice = state.accumulated.slice(state.lastSentPos);
  let out = "";
  let i = 0;
  while (i < slice.length) {
    const ch = slice[i];
    if (ch === '"') { i++; break; }            // end of JSON string value
    if (ch !== "\\") { out += ch; i++; continue; }
    if (i + 1 >= slice.length) break;           // incomplete escape — wait
    const esc = slice[i + 1]!;
    if (esc === "u") {
      if (i + 5 >= slice.length) break;         // incomplete unicode — wait
      out += String.fromCharCode(parseInt(slice.slice(i + 2, i + 6), 16));
      i += 6;
    } else {
      const MAP: Record<string, string> = {
        '"': '"', "\\": "\\", n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", "/": "/",
      };
      out += MAP[esc] ?? esc;
      i += 2;
    }
  }
  state.lastSentPos += i;
  return out;
}

// Wire up the WS broadcaster for streaming tools
const wsBroadcast = (userId: string, data: object) => broadcastToUser(userId, data);
setDocumentWsBroadcast(wsBroadcast);
setTicketWsBroadcast(wsBroadcast);
setMiscWsBroadcast(wsBroadcast);

export interface StreamRequest {
  ws: ServerWebSocket<WsData>;
  userId: string;
  userMessage: string;
  /** The user dictated this message — recorded so history can show the mic. */
  isVoice?: boolean;
  conversationId?: string;
  projectId?: string;
  turboMode?: boolean;
  instantMode?: boolean;
  userRole?: string;
  file?: { id?: string; name?: string; type?: string; size?: number } | null;
  /** All attachments on this message (multi-file). `file` is kept as the first, for compat. */
  files?: Array<{ id?: string; name?: string; type?: string; size?: number }>;
  /** Tickets referenced via @ticket — their context is injected into the model. */
  mentionedTickets?: Array<{ id: string; key?: string; name?: string; branch?: string }>;
  abortController: AbortController;
  /** Called on every stream event (chunk / tool call / step) — lets the caller's
   *  watchdog treat this as an IDLE timer (fires only when the model truly goes
   *  silent) instead of killing a long-but-active agentic run at a fixed wall clock. */
  onActivity?: () => void;
}

// Providers whose configured models can view images directly (multimodal) — these get
// the image attached natively; text-only models (DeepSeek/Kimi/GLM) go through the
// Google-only vision pre-pass (analyzeImage) instead.
const VISION_NATIVE = new Set(["anthropic", "openai", "google"]);

// Read/inspect tools — grouped under a persistent "Gathering information…" status so the
// user sees ONE steady indicator (not a flicker) with the SPECIFIC action beneath it.
export const INVESTIGATION_TOOLS = new Set([
  "queryCodebase", "inspectPreview", "getFileContent", "getFileList",
  "getRecentActivities", "getTicketDetails", "getPendingTickets", "getProjectContext",
]);

/** A short, human line describing WHAT a tool call is actually doing, from its args —
 *  so the status pill can say "Reading src/foo.ts on feature/cal-7" instead of a bare
 *  "Inspect preview". Returns "" when there's nothing specific to add. */
/**
 * A readable name for any tool, used when toolActionDetail has nothing specific to say.
 *
 * Without this the saved trail only kept the handful of tools that produce a detail
 * string, so a turn the user watched run nine steps replayed as one after a refresh.
 */
const TOOL_LABELS: Record<string, string> = {
  getProjectDashboard: "Loading project dashboard",
  getFileList: "Listing the project files",
  getFileContent: "Reading a file",
  queryCodebase: "Reading the codebase",
  inspectPreview: "Inspecting the live preview",
  streamDocumentContent: "Writing a document",
  patchFileContent: "Editing a document",
  updateFileContent: "Updating a document",
  previewPage: "Generating preview page",
  createTickets: "Creating tickets",
  updateTicket: "Updating a ticket",
  updateTicketDetails: "Updating ticket details",
  getPendingTickets: "Checking pending tickets",
  getTicketDetails: "Loading ticket details",
  getNextTicket: "Finding the next ticket",
  scheduleTickets: "Scheduling the build",
  queueTicketExecution: "Queueing a build",
  retryTicket: "Retrying a ticket",
  sendTicketMessage: "Messaging the ticket agent",
  startEpic: "Starting an epic",
  addToEpic: "Adding to the epic",
  checkEpicOverlap: "Checking for overlapping work",
  getEpicStatus: "Checking epic status",
  listTicketsForEpic: "Listing the epic's tickets",
  getRecentActivities: "Checking recent activity",
  lookupTechnologySpecs: "Researching technology",
  setProjectStack: "Recording the stack",
  captureProjectName: "Naming the project",
  getProjectEnvVars: "Reading environment variables",
  registerRequiredEnvVars: "Registering environment variables",
  setEnvVar: "Setting an environment variable",
};

export function toolLabel(toolName: string): string {
  if (TOOL_LABELS[toolName]) return TOOL_LABELS[toolName]!;
  // camelCase → "Camel case", so an unmapped tool still reads as something.
  const words = toolName.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function toolActionDetail(toolName: string, input: unknown): string {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const clip = (v: string, n = 72) => (v.length > n ? v.slice(0, n).trimEnd() + "…" : v);
  try {
    switch (toolName) {
      case "queryCodebase": {
        const q = clip(s(o.question), 64);
        const br = s(o.branch) || (o.ticketId ? `ticket ${clip(s(o.ticketId), 10)}` : "");
        return `Reading the codebase${br ? ` on ${br}` : ""}${q ? ` — ${q}` : ""}`;
      }
      case "inspectPreview": {
        const reason = clip(s(o.reason), 64);
        const cmd = clip(s(o.command), 56);
        const where = s(o.workdir) && s(o.workdir) !== "preview" ? ` [${clip(s(o.workdir), 24)}]` : "";
        if (reason) return `Inspecting the live preview${where} — ${reason}`;
        return cmd ? `Inspecting the preview${where}: ${cmd}` : "Inspecting the live preview";
      }
      case "getFileContent": return `Reading ${clip(s(o.path) || s(o.filename) || s(o.fileName) || s(o.name) || "a file", 60)}`;
      case "getFileList": return "Listing the project files";
      case "getTicketDetails": return "Loading ticket details";
      case "getRecentActivities": return "Checking recent activity";
      case "createTickets": {
        const arr = Array.isArray(o.tickets) ? (o.tickets as unknown[]) : [];
        return arr.length ? `Creating ${arr.length} ticket${arr.length > 1 ? "s" : ""}` : "";
      }
      default: return "";
    }
  } catch { return ""; }
}

/**
 * Build a system-context block describing the @ticket-referenced tickets: each
 * ticket's spec, git branch, acceptance criteria, pending addenda, and a short
 * "what's been done" history — so the chat model answers in the ticket's context.
 */
async function buildTicketMentionContext(ticketIds: string[]): Promise<string> {
  const ids = [...new Set(ticketIds.filter(Boolean))].slice(0, 4);
  if (!ids.length) return "";
  const tickets = await db.select().from(projectTickets).where(inArray(projectTickets.id, ids)).catch(() => []);
  if (!tickets.length) return "";
  const parts: string[] = [];
  for (const t of tickets) {
    const branch = t.githubBranch || `feature/ticket-${t.id}`;
    const ac = (t.acceptanceCriteria as string[] | null) ?? [];
    const [addenda, done] = await Promise.all([
      db.select({ d: ticketAddenda.description }).from(ticketAddenda)
        .where(and(eq(ticketAddenda.ticketId, t.id), eq(ticketAddenda.status, "pending"))).catch(() => []),
      db.select({ m: ticketLogs.command }).from(ticketLogs)
        .where(and(eq(ticketLogs.ticketId, t.id), eq(ticketLogs.logType, "ai_response")))
        .orderBy(desc(ticketLogs.createdAt)).limit(2).catch(() => []),
    ]);
    parts.push(
      `### ${t.ticketKey ? t.ticketKey + " — " : ""}${t.name}\n` +
      `- Status: ${t.status} · Branch: \`${branch}\` (the Preview has been switched to this branch)\n` +
      (t.description ? `- Spec: ${String(t.description).replace(/\s+/g, " ").slice(0, 1200)}\n` : "") +
      (ac.length ? `- Acceptance criteria: ${ac.map((c) => `(${c})`).join(" ")}\n` : "") +
      (addenda.length ? `- Pending change requests: ${addenda.map((a) => a.d).join(" | ")}\n` : "") +
      (done.length ? `- Recently done: ${done.map((x) => (x.m ?? "").replace(/\s+/g, " ").slice(0, 200)).join(" || ")}\n` : "")
    );
  }
  return `The user is asking about the following ticket(s). Answer in this context; the live Preview is showing the first ticket's branch.\n\n${parts.join("\n")}`;
}

/** If the live Preview is serving a ticket's branch, return a system note pinning the
 *  model to it — so it reads the RIGHT branch for a screenshot/bug question (the preview's
 *  worktree via inspectPreview, the feature branch via queryCodebase). "" when the preview
 *  is idle or on the default branch (nothing to disambiguate). */
async function buildPreviewBranchContext(projectId: string): Promise<string> {
  const [env] = await db.select({ branch: projectEnvironments.previewBranch, status: projectEnvironments.previewStatus })
    .from(projectEnvironments).where(eq(projectEnvironments.projectId, projectId)).limit(1).catch(() => [] as any[]);
  const branch = env?.branch;
  if (!branch || branch === "(default)" || env?.status !== "running") return "";
  const [tk] = await db.select({ id: projectTickets.id, key: projectTickets.ticketKey, name: projectTickets.name })
    .from(projectTickets).where(and(eq(projectTickets.projectId, projectId), eq(projectTickets.githubBranch, branch))).limit(1).catch(() => [] as any[]);
  const who = tk ? `${tk.key ? tk.key + " — " : ""}${tk.name}` : "";
  return `The LIVE Preview the user is looking at is currently serving branch \`${branch}\`${who ? ` (ticket ${who})` : ""} — NOT the default branch. When the user's message or a screenshot is about what they see in the preview:\n` +
    `- inspectPreview already runs in THIS checkout (the branch's worktree), so use it to see the running app.\n` +
    `- For code questions about it, call queryCodebase with ${tk ? `ticketId "${tk.id}" (or ` : ""}branch \`${branch}\`${tk ? ")" : ""} so you read THIS branch — reading the default branch would show different code and lead you to the wrong conclusion.`;
}

/** Describe an image using GOOGLE (Gemini) ONLY — the cheapest vision option and, per
 *  product decision, the only provider we use for the text-only-model image pre-pass.
 *  Uses the user's Google key if present, else the server env key. Returns the text
 *  description, or null if no key is configured / it fails. */
export async function analyzeImage(bytes: Uint8Array, mediaType: string, userApiKeys: any): Promise<string | null> {
  try {
    const model = getGoogleVisionModel(userApiKeys, { allowEnvFallback: true });
    const { text } = await generateText({
      model,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe this screenshot/image in precise detail for another AI that CANNOT see it. Extract ALL visible text verbatim, name the page/section, describe the UI layout and any data, charts, errors, or code. Be factual — do not guess." },
          { type: "image", image: bytes, mediaType },
        ],
      }],
      maxOutputTokens: 1000,
    });
    const out = text?.trim() || null;
    if (out) { console.log(`[vision] described image via google (${out.length} chars)`); return out; }
  } catch (e) {
    console.warn(`[vision] google describe failed:`, (e as Error).message?.slice(0, 200));
  }
  return null;
}

/** Read an uploaded chat file's raw bytes (S3 or local disk). */
export async function readImageBytes(fileId: string): Promise<Uint8Array | null> {
  try {
    const [cf] = await db.select().from(chatFiles).where(eq(chatFiles.id, fileId));
    if (cf?.filePath?.startsWith("s3:")) { const { body } = await downloadBinary(cf.filePath.slice(3)); return new Uint8Array(body); }
    if (cf?.filePath) return new Uint8Array(await fs.readFile(path.resolve(cf.filePath)));
  } catch (e) { console.warn(`[vision] could not read uploaded image:`, (e as Error).message?.slice(0, 120)); }
  return null;
}

/** Describe any IMAGE attachments as text via the Gemini pre-pass, so a text-only agent
 *  (e.g. the @preview shell agent) can "see" a screenshot. Returns "" if none/failed. */
export async function describeAttachedImages(
  files: Array<{ id?: string; name?: string; type?: string }> | undefined,
  userApiKeys?: any,
): Promise<string> {
  const imgs = (files || []).filter((f) => f.id && (f.type || "").startsWith("image/"));
  if (!imgs.length) return "";
  const parts = await Promise.all(imgs.map(async (f) => {
    const bytes = await readImageBytes(f.id!);
    if (!bytes) return "";
    const desc = await analyzeImage(bytes, f.type || "image/png", userApiKeys);
    return desc ? `[Attached image "${f.name || f.id}" — a vision model's description of it, treat as ground truth:\n${desc}]` : "";
  }));
  return parts.filter(Boolean).join("\n\n");
}

export async function handleStream(req: StreamRequest): Promise<{ conversationId: string }> {
  const { ws, userId, userMessage, projectId, turboMode, instantMode, abortController, isVoice } = req;

  // ── 1. Resolve or create conversation ───────────────────────────────────────
  let convId = req.conversationId;
  // Whether this turn is an owner/admin continuing SOMEONE ELSE's shared chat.
  // Their messages get attributed so the transcript doesn't silently mix voices.
  let writingAsGuest = false;
  if (convId) {
    // Verify the conversation actually exists — stale URLs can reference deleted conversations
    const [existing] = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, convId)).limit(1);
    if (!existing) {
      console.log(`[stream] Conversation ${convId} not found in DB, creating new one`);
      convId = undefined;
    } else {
      // Existence is NOT permission. Without this, any caller holding a conversation
      // id could post into it — including across projects they aren't a member of.
      const access = await getChatAccess(convId, userId);
      if (!access.canWrite) {
        console.warn(`[stream] user ${userId} denied write on conversation ${convId}`);
        ws.send(JSON.stringify({
          type: "error",
          error: access.canRead
            ? "This chat belongs to a teammate. You can read it, but only its author (or a project admin) can continue it."
            : "You don't have access to this conversation.",
        }));
        return { conversationId: convId };
      }
      writingAsGuest = access.actingAsGuest;
    }
  }
  if (!convId) {
    const [conv] = await db
      .insert(conversations)
      .values({ userId, projectId: projectId ?? null, title: (userMessage || "New conversation").slice(0, 50) })
      .returning();
    convId = conv!.id;
    // Notify client of new conversation
    ws.send(JSON.stringify({ type: "conversation_created", conversationId: convId }));
  }

  // Bind THIS connection to the conversation as early as possible so conversation-scoped
  // broadcasts (instant build status/notifications) that fire during this turn reach the
  // owning tab — and ONLY the owning tab. Without this, a brand-new instant tab isn't
  // bound yet when its first build broadcasts, and the messages leak to other tabs.
  const _conn = getConnection(ws);
  if (_conn) _conn.conversationId = convId;

  // ── 1b. Detect agent conversation ────────────────────────────────────────────
  const agentRecord = convId ? await getAgentByConversation(convId) : null;

  // ── 2. Save user message ─────────────────────────────────────────────────────
  const [userMsgRow] = await db.insert(messages).values({
    conversationId: convId,
    role: "user",
    content: userMessage,
    isVoice: !!isVoice,
    // Only stamped when someone OTHER than the conversation's author wrote it.
    authorId: writingAsGuest ? userId : null,
  }).returning({ id: messages.id });

  // ── 3. Load recent history ───────────────────────────────────────────────────
  const history = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, convId))
    .orderBy(desc(messages.createdAt))
    .limit(MAX_HISTORY);

  // Expand assistant rows that have stored tool_steps into the full AI SDK
  // message sequence (tool-call / tool-result pairs) so the next turn has
  // the same context the LLM had on its previous turn. Without this, the
  // LLM only sees its own polished text reply and "forgets" what tools it
  // ran and what they returned — leading to "I need that doc" right after
  // it just fetched it.
  const contextMessages: any[] = [];
  for (const m of history.reverse()) {
    const steps = (m as any).toolSteps as any[] | null | undefined;
    if (m.role === "assistant" && Array.isArray(steps) && steps.length > 0) {
      // Replay the captured AI SDK response.messages sequence verbatim.
      // These rows include intermediate assistant tool-call + tool result
      // messages plus the final assistant text.
      for (const step of steps) contextMessages.push(step);
    } else {
      contextMessages.push({
        role: m.role as "user" | "assistant" | "system",
        content: m.content,
      });
    }
  }

  // ── 3b. @ticket context — inject each referenced ticket's spec/branch/history ──
  if (req.mentionedTickets?.length) {
    const block = await buildTicketMentionContext(req.mentionedTickets.map((t) => t.id));
    if (block) contextMessages.push({ role: "system", content: block });
  }

  // ── 4. Resolve model & API keys ──────────────────────────────────────────────
  const [modelSel] = await db
    .select()
    .from(modelSelections)
    .where(eq(modelSelections.userId, userId));

  // Fine-grained LLM sharing: a collaborator granted "use my API keys" runs the analyst
  // chat on the OWNER's keys; otherwise on their own. The model CHOICE stays the acting
  // user's (modelSel above) — only the credential source is shared.
  let keyUserId = userId;
  if (projectId) {
    const [proj] = await db.select({ id: projects.id, ownerId: projects.ownerId }).from(projects).where(eq(projects.projectId, projectId)).limit(1);
    if (proj) keyUserId = llmKeyUserId(await resolveLlmGrants(proj, userId), userId);
  }
  const [apiKeys] = await db
    .select()
    .from(llmApiKeys)
    .where(eq(llmApiKeys.userId, keyUserId));

  const modelKey = modelSel?.selectedModel ?? DEFAULT_MODEL_KEY;
  const userApiKeys = apiKeys
    ? { anthropic: apiKeys.anthropicApiKey ?? undefined, openai: apiKeys.openaiApiKey ?? undefined, google: apiKeys.googleApiKey ?? undefined, kimi: apiKeys.kimiApiKey ?? undefined, deepseek: apiKeys.deepseekApiKey ?? undefined, glm: apiKeys.glmApiKey ?? undefined }
    : undefined;

  // ── Check user has a key for the selected provider (unless instant mode) ────
  if (!instantMode) {
    const providerName = getProviderName(modelKey);
    const keyMap: Record<string, string | undefined> = {
      openai: userApiKeys?.openai,
      anthropic: userApiKeys?.anthropic,
      google: userApiKeys?.google,
      kimi: userApiKeys?.kimi,
      deepseek: userApiKeys?.deepseek,
      glm: userApiKeys?.glm,
    };
    if (providerName && !keyMap[providerName]) {
      const errMsg = `⚠️ No ${providerName.charAt(0).toUpperCase() + providerName.slice(1)} API key found. Please add your API key in **Settings → LLM Keys** to use this model.`;
      console.log(`[stream] Blocking: no user key for provider=${providerName} model=${modelKey}`);
      ws.send(JSON.stringify({ type: "ai_chunk", chunk: errMsg, is_final: true }));
      return { conversationId: convId };
    }
  }

  let model;
  let searchTools: Record<string, unknown> = {};
  try {
    const result = getModelWithSearch(modelKey, userApiKeys, { allowEnvFallback: !!instantMode });
    model = result.model;
    searchTools = result.searchTools;
  } catch (err) {
    if (!instantMode) {
      const errMsg = err instanceof Error ? err.message : "Failed to initialize model";
      ws.send(JSON.stringify({ type: "ai_chunk", chunk: errMsg, is_final: true }));
      return { conversationId: convId };
    }
    // Instant mode: fall back to default model with server keys
    const result = getModelWithSearch(DEFAULT_MODEL_KEY, undefined, { allowEnvFallback: true });
    model = result.model;
    searchTools = result.searchTools;
  }

  // ── 4b. Attach an uploaded IMAGE to the model turn ──────────────────────────
  // Vision-native models (Claude/GPT/Gemini) get the image directly. Text-only
  // models (DeepSeek's hosted API is text-only) can't view images, so we run a
  // vision pre-pass with the user's vision key and feed DeepSeek the description.
  const allFiles = (req.files && req.files.length ? req.files : (req.file ? [req.file] : []));
  const imgFiles = allFiles.filter((f) => (f.type || "").startsWith("image/") && f.id);

  // Persist ALL attachments on the message so they render in history after a reload.
  if (userMsgRow?.id && allFiles.length) {
    await db.update(messages)
      .set({ contentIfFile: allFiles.filter((f) => f.id).map((f) => ({ id: f.id, name: f.name, type: f.type, url: `/api/files/${f.id}` })) })
      .where(eq(messages.id, userMsgRow.id)).catch(() => {});
  }

  if (imgFiles.length) {
    const readBytes = async (id: string): Promise<Uint8Array | null> => {
      try {
        const [cf] = await db.select().from(chatFiles).where(eq(chatFiles.id, id));
        if (cf?.filePath?.startsWith("s3:")) { const { body } = await downloadBinary(cf.filePath.slice(3)); return new Uint8Array(body); }
        if (cf?.filePath) return new Uint8Array(await fs.readFile(path.resolve(cf.filePath)));
      } catch (e) { console.warn(`[stream] could not read uploaded image:`, (e as Error).message?.slice(0, 120)); }
      return null;
    };
    const images = (await Promise.all(imgFiles.map(async (f) => ({ f, bytes: await readBytes(f.id!) }))))
      .filter((x): x is { f: typeof imgFiles[number]; bytes: Uint8Array } => !!x.bytes);

    const setLastUser = (content: any) => {
      for (let i = contextMessages.length - 1; i >= 0; i--) {
        if (contextMessages[i].role === "user") { contextMessages[i] = { role: "user", content }; return; }
      }
    };
    // So a model can ATTACH an image to a ticket (createTickets attachmentImageIds), the
    // image id must travel with it — for text-only models it rides alongside the Gemini
    // description; for vision-native models it's a short note next to the image.
    const idNote = images.length
      ? `\n\n[Attached image ids you can pass to tools like createTickets(attachmentImageIds): ${images.map((x) => `"${x.f.name || x.f.id}" → imageId: ${x.f.id}`).join("; ")}]`
      : "";
    const providerName = getProviderName(modelKey);
    if (images.length && providerName && VISION_NATIVE.has(providerName)) {
      // Vision-native models: attach every image directly to the last user message.
      setLastUser([{ type: "text", text: userMessage + idNote }, ...images.map((x) => ({ type: "image", image: x.bytes, mediaType: x.f.type }))]);
    } else if (images.length) {
      // Text-only model: describe each image via the vision pre-pass and inject the text.
      // Run ALL describes CONCURRENTLY — a sequential await-in-loop made N images take N×
      // the Gemini latency (two full-screen screenshots stalled "Thinking…" for ~2 min
      // before the model even started). Promise.all preserves order, so descriptions stay
      // aligned with their images.
      ws.send(JSON.stringify({ type: "ai_chunk", chunk: "", is_final: false, is_notification: true, notification_type: "status", message: images.length > 1 ? `Analyzing ${images.length} images…` : "Analyzing image…" }));
      const descs = await Promise.all(images.map(async (x) => {
        const desc = await analyzeImage(x.bytes, x.f.type || "image/png", userApiKeys);
        // Keep the imageId next to the description so the model can attach the REAL image
        // (not just the prose) to a ticket via createTickets(attachmentImageIds).
        return desc
          ? `[Attached image "${x.f.name}" (imageId: ${x.f.id}). The current model can't view images — here is a vision model's description, treat it as ground truth:\n\n${desc}]`
          : `[The user attached an image "${x.f.name}" (imageId: ${x.f.id}), but the selected model can't view images and the Google (Gemini) vision pre-pass couldn't run — the Google AI key is missing or was rejected. Tell them to add a valid Google key in Settings → LLM Keys (or switch to a vision-native model) — do NOT guess what the image shows.]`;
      }));
      setLastUser(`${userMessage}\n\n${descs.join("\n\n")}${idNote}`);
    }
  }

  // ── 5. Select system prompt & tools ─────────────────────────────────────────
  const [role] = await db
    .select()
    .from(agentRoles)
    .where(eq(agentRoles.userId, userId));

  const isTurbo = turboMode ?? role?.turboMode ?? false;

  // Resolve the public URL projectId → internal projects.id so tools insert
  // records with the correct FK value (projectPrds.projectId, etc. all reference
  // projects.id, not the public-facing projects.projectId).
  let internalProjectId = projectId;
  if (projectId) {
    const [proj] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.projectId, projectId));
    if (proj) internalProjectId = proj.id;
  }

  // ── Branch awareness — pin the model to the branch the Preview is showing ──────
  // If the live preview is serving a ticket branch, tell the model so it reads THAT
  // branch (worktree for the preview, feature branch for the codebase) instead of the
  // default — otherwise a screenshot/bug question gets answered against the wrong code.
  // Skipped when @ticket already pinned the context.
  if (internalProjectId && !req.mentionedTickets?.length) {
    const branchCtx = await buildPreviewBranchContext(internalProjectId);
    if (branchCtx) contextMessages.push({ role: "system", content: branchCtx });
  }

  // Polymorphic tool bag: composition varies by mode (agent / instant / product).
  // The tools that record which chat produced a ticket or an epic take conversationId as
  // a MODEL-supplied argument, and the model frequently omits it — which is why work built
  // from a chat shows up with no conversation linked anywhere. The server always knows
  // which conversation this is, so inject it rather than hoping: an explicit value from
  // the model still wins, this only fills the blank.
  const withConversation = (t: Record<string, any>): Record<string, any> => {
    for (const name of ["createTickets", "startEpic", "addToEpic", "createTicket"]) {
      const tool = t[name];
      if (!tool || typeof tool.execute !== "function") continue;
      const original = tool.execute.bind(tool);
      tool.execute = (args: Record<string, unknown>, opts: unknown) =>
        original({ ...args, conversationId: (args?.conversationId as string) || convId }, opts);
    }
    return t;
  };

  let tools: Record<string, any> = instantMode
    ? createInstantTools({
        userId,
        conversationId: convId,
        projectId: internalProjectId ?? undefined,
        modelKey,
      })
    : isTurbo
      ? toolsTurbo
      : toolsProduct;

  // Merge Composio tools. For agent chats, scope strictly to the toolkits
  // the user has explicitly enabled on that agent (agent.composioToolkits).
  // A new agent with nothing toggled on gets no Composio tools at all.
  // For non-agent chat (no agentRecord), load the full connected set.
  const enabledToolkits = agentRecord ? (agentRecord.composioToolkits ?? []) : undefined;
  const composioTools = await Promise.race([
    getComposioTools(userId, enabledToolkits),
    new Promise<Record<string, never>>((resolve) => setTimeout(() => resolve({}), 10_000)),
  ]);
  if (Object.keys(composioTools).length > 0) {
    tools = { ...tools, ...composioTools };
  }

  // Add web search tools based on the active provider (Anthropic/OpenAI/Google native).
  if (Object.keys(searchTools).length > 0) {
    tools = { ...tools, ...searchTools };
  } else if (!instantMode) {
    // Provider-native search is EMPTY for DeepSeek/Kimi/GLM. Without a fallback, the
    // product/analyst chat on those models had NO web search and (correctly) said so.
    // The Exa webSearch/readUrl are provider-agnostic — add them so every model can
    // research. (createAgentTools only ran for custom Agents, so product chat missed it.)
    tools = { ...tools, ...createWebResearchTools() };
  }

  // Read-only window into the LIVE preview sandbox so the product/Analyst agent can
  // DIAGNOSE runtime issues (DB migration errors, 500s) with real evidence instead of
  // guessing from source. Mutations stay behind @preview. Needs the INTERNAL id:
  // projectEnvironments.projectId is a FK to projects.id, not the public projectId —
  // passing the public one made every lookup miss, so the agent always reported "no
  // preview sandbox exists" even with a healthy running preview. Not for instant/agent chats.
  if (!instantMode && !agentRecord && internalProjectId) {
    tools = { ...tools, ...createPreviewInspectTool({ projectId: internalProjectId }) };
  }

  // Add agent-specific tools (sandbox, memory, self-config).
  if (agentRecord) {
    // onActivity: long sandbox/Python calls beat the chat idle watchdog while they
    // work, so a 10-minute command isn't mistaken for a hung stream and aborted.
    const agentTools = createAgentTools({ agentId: agentRecord.agentId, userId, onActivity: req.onActivity });
    tools = { ...tools, ...agentTools };
  }

  // ── Query project context flags (for product prompt) ──────────────────────
  let projectFlags: {
    hasTickets: boolean;
    hasDocs: boolean;
    hasGithub: boolean;
    hasTechAnalysis: boolean;
    hasDesignLanguage: boolean;
  } | undefined;

  if (!instantMode && internalProjectId) {
    const [proj, files, tickets] = await Promise.all([
      db.select({ repoUrl: projects.repoUrl }).from(projects).where(eq(projects.id, internalProjectId)).then(r => r[0]),
      db.select({ fileType: projectFiles.fileType }).from(projectFiles).where(eq(projectFiles.projectId, internalProjectId)),
      db.select({ id: projectTickets.id }).from(projectTickets).where(eq(projectTickets.projectId, internalProjectId)).limit(1),
    ]);
    const fileTypes = new Set(files.map(f => f.fileType));
    projectFlags = {
      hasTickets: tickets.length > 0,
      hasDocs: files.length > 0,
      hasGithub: !!proj?.repoUrl,
      hasTechAnalysis: fileTypes.has("tech_analysis"),
      hasDesignLanguage: fileTypes.has("design_language"),
    };
  }

  let systemPrompt: string;
  if (agentRecord) {
    // Source of truth for connected toolkits is Composio itself (not our local
    // table — OAuth connections aren't always mirrored locally). Use filter='all'
    // and post-filter by isConnected; session-scoped filter='connected' returns
    // only session-enabled toolkits (empty for manageConnections sessions).
    // limit hard-capped at 50 by Composio's session.toolkits endpoint
    const connectorList = await Promise.race([
      listConnectors(userId, { filter: "all", limit: 50 }),
      new Promise<{ items: [] }>((resolve) => setTimeout(() => resolve({ items: [] }), 5_000)),
    ]);
    systemPrompt = getAgentSystemPrompt({
      name: agentRecord.name,
      personality: agentRecord.personality,
      instructions: agentRecord.instructions,
      memoryContent: agentRecord.memoryContent,
      connectedToolkits: connectorList.items.filter((t: any) => t.isConnected).map((t: any) => t.slug),
      enabledToolkits: agentRecord.composioToolkits ?? [],
    });
  } else if (instantMode) {
    systemPrompt = getInstantSystemPrompt();
  } else {
    // Skills are FETCHED BY THE AGENT (loadSkill), not pushed in from here — the prompt
    // only advertises what exists. Server-side keyword matching guessed from outside the
    // conversation and got it wrong in both directions.
    systemPrompt = getProductSystemPrompt({ userId, projectId: internalProjectId, conversationId: convId, projectFlags });

    // Whatever the project owner told every agent here to do. Appended last so it
    // outranks the defaults it contradicts.
    if (internalProjectId) {
      const [projRow] = await db
        .select({ ci: projects.customInstructions })
        .from(projects)
        .where(eq(projects.id, internalProjectId))
        .limit(1)
        .catch(() => [] as Array<{ ci: string | null }>);
      const ci = (projRow?.ci ?? "").trim();
      if (ci) {
        systemPrompt += `\n\n---\n\n## Project instructions (from this project's settings)\n\n${ci}\n\nThese come from the people who own this project. Where they conflict with your defaults, follow these.`;
      }
    }
  }

  // ── 6. Stream with AI SDK ────────────────────────────────────────────────────
  let fullResponse = "";
  let chunkBuffer = "";
  let lastFlush = Date.now();
  let streamError: Error | null = null;
  // Hoisted so we can read .response after the stream completes (for
  // tool-step persistence).
  let streamTextResult: ReturnType<typeof streamText> | null = null;

  const flush = () => {
    if (!chunkBuffer) return;
    ws.send(JSON.stringify({ type: "ai_chunk", chunk: stripCitations(chunkBuffer), is_final: false }));
    chunkBuffer = "";
    lastFlush = Date.now();
  };

  // Incremental persistence: checkpoint the assistant message to the DB AS it
  // streams (isPartial=true), then finalize (isPartial=false) when the turn ends.
  // Previously the reply was written only ONCE at the very end, so a refresh — or a
  // dropped socket — mid-response lost the whole message even though the client had
  // already rendered it. We upsert a SINGLE row (no duplicates); the final save is
  // authoritative. All writes are best-effort and never throw into the stream loop.
  let assistantMsgId: string | null = null;
  let checkpointInFlight = false;
  let checkpointPromise: Promise<void> | null = null;
  let lastCheckpoint = 0;
  const CHECKPOINT_MS = 2500;
  // What the user watched happen this turn, in order. Kept alongside the message so
  // reopening the conversation still shows what the agent did — the trail used to live
  // only in the DOM and vanished on refresh.
  const activityTrail: Array<{ text: string; tool?: string }> = [];
  // Previews rendered this turn, saved with the message so a refresh brings the card
  // back — it used to exist only in the socket message that announced it.
  const pagePreviews: Array<{ id: string; name: string }> = [];
  const noteActivity = (text: string, tool?: string) => {
    if (!text) return;
    const last = activityTrail[activityTrail.length - 1];
    if (last && last.text === text) return;          // same line twice in a row
    if (activityTrail.length >= 60) return;          // a runaway turn shouldn't bloat the row
    activityTrail.push(tool ? { text, tool } : { text });
  };

  const persistAssistant = async (
    content: string,
    opts: { steps?: any[] | null; final?: boolean } = {},
  ): Promise<void> => {
    const final = opts.final ?? false;
    if (!content && !final) return; // nothing meaningful to save yet
    try {
      if (assistantMsgId) {
        await db.update(messages).set({
          content,
          isPartial: !final,
          lastUpdated: new Date(),
          ...(opts.steps !== undefined ? { toolSteps: opts.steps } : {}),
          ...(activityTrail.length ? { activityTrail } : {}),
          ...(pagePreviews.length ? { pagePreviews } : {}),
        }).where(eq(messages.id, assistantMsgId));
      } else {
        const [row] = await db.insert(messages).values({
          conversationId: convId,
          role: "assistant",
          content,
          isPartial: !final,
          toolSteps: opts.steps ?? null,
          activityTrail: activityTrail.length ? activityTrail : null,
          pagePreviews: pagePreviews.length ? pagePreviews : null,
        }).returning({ id: messages.id });
        assistantMsgId = row?.id ?? null;
      }
    } catch (err) {
      console.warn("[stream-handler] assistant checkpoint failed:", (err as Error).message);
    }
  };

  // Apply provider-appropriate prompt caching. For Anthropic this attaches
  // explicit cache_control breakpoints on the system prompt (caches system +
  // tools) and the last message (caches the growing history prefix). For every
  // other provider caching is automatic given our stable [system][tools][history]
  // ordering, so this is a no-op that returns the inputs unchanged.
  const cached = withCaching(modelKey, { system: systemPrompt, messages: contextMessages });

  try {
    const result = streamText({
      model,
      system: cached.system,
      messages: cached.messages as any,
      tools,
      stopWhen: stepCountIs(80),
      abortSignal: abortController.signal,
      onStepFinish: ({ toolCalls }) => {
        if (!toolCalls?.length) return;
        flush();
        for (const tc of toolCalls) {
          // Skip tools that handle their own WS notifications — a generic
          // notification here would cause duplicates.
          if (DOCUMENT_STREAM_TOOLS.has(tc.toolName)) continue;
          // askUser / confirmAction are handled in the tool-call fullStream event
          if (tc.toolName === "askUser" || tc.toolName === "confirmAction") continue;
          ws.send(JSON.stringify({
            type: "ai_chunk",
            chunk: "",
            is_final: false,
            is_notification: true,
            notification_type: tc.toolName,
            function_name: tc.toolName,
          }));
        }
      },
    });
    streamTextResult = result;

    // ── Use fullStream so we can intercept tool-input-delta events and forward
    //    document content character-by-character as the model generates it.
    const docStreams = new Map<string, DocStreamState>();

    // Accumulate askUser tool args from deltas (event.args/result may be empty)
    const askUserArgs = new Map<string, string>();
    let askUserCardSent = false;
    const confirmArgs = new Map<string, string>();
    let confirmCardSent = false;
    let turnClosedByCard = false; // a propose_*/create_instant_app card fired — drop trailing text

    for await (const event of result.fullStream) {
      if (abortController.signal.aborted) break;
      // Proof-of-life for the caller's idle watchdog: every event (text delta, tool
      // call/step) counts as activity, so a long agentic run (many codebase queries)
      // isn't mistaken for a hang and aborted mid-work.
      req.onActivity?.();

      switch (event.type) {

        case "text-delta": {
          // After askUser card is sent, suppress text entirely — both display
          // and DB persistence.  The post-card text just references the
          // transient card UI which isn't persisted, so saving it confuses
          // the AI on subsequent turns.
          if (askUserCardSent || confirmCardSent || turnClosedByCard) break;

          fullResponse += event.text;
          chunkBuffer += event.text;
          const now = Date.now();
          if (chunkBuffer.length >= FLUSH_CHARS || now - lastFlush >= FLUSH_MS) flush();
          // Throttled DB checkpoint so a refresh mid-stream keeps the partial reply
          // instead of losing it. Fire-and-forget; a full-content write is last-write-wins.
          if (!checkpointInFlight && now - lastCheckpoint >= CHECKPOINT_MS) {
            checkpointInFlight = true;
            lastCheckpoint = now;
            checkpointPromise = persistAssistant(stripCitations(fullResponse)).finally(() => { checkpointInFlight = false; });
          }
          break;
        }

        case "tool-input-start": {
          // A card tool owns the turn — suppress any assistant text that follows.
          if (TURN_CLOSING_TOOLS.has(event.toolName)) turnClosedByCard = true;
          if (DOCUMENT_STREAM_TOOLS.has(event.toolName)) {
            docStreams.set(event.id, {
              toolName: event.toolName,
              accumulated: "",
              contentStartPos: null,
              lastSentPos: 0,
              panelOpened: false,
            });
          }
          // Track askUser args accumulation
          if (event.toolName === "askUser") {
            askUserArgs.set(event.id, "");
          }
          // Track confirmAction args accumulation — it owns the turn like a card
          if (event.toolName === "confirmAction") {
            confirmArgs.set(event.id, "");
          }
          // Notify client immediately when ANY tool starts (shows indicator)
          // Skip askUser / confirmAction — they send their own card notification
          if (event.toolName !== "askUser" && event.toolName !== "confirmAction") {
            flush();
            ws.send(JSON.stringify({
              type: "ai_chunk",
              chunk: "",
              is_final: false,
              is_notification: true,
              early_notification: true,
              notification_type: WEB_SEARCH_TOOLS.has(event.toolName) ? "web_search" : event.toolName,
              function_name: event.toolName,
              investigation: INVESTIGATION_TOOLS.has(event.toolName),
            }));
          }
          break;
        }

        case "tool-input-delta": {
          // Accumulate askUser args
          if (askUserArgs.has(event.id)) {
            askUserArgs.set(event.id, askUserArgs.get(event.id)! + event.delta);
          }
          // Accumulate confirmAction args
          if (confirmArgs.has(event.id)) {
            confirmArgs.set(event.id, confirmArgs.get(event.id)! + event.delta);
          }

          const st = docStreams.get(event.id);
          if (!st) break;

          st.accumulated += event.delta;

          // Open the panel once we know the actual file type from the args
          if (!st.panelOpened) {
            const detectedType = toolFileType(st.toolName, st.accumulated);
            if (detectedType !== "document") {
              // We now know the real type (prd, implementation, etc.)
              st.panelOpened = true;
              flush();
              ws.send(JSON.stringify({
                type: "ai_chunk",
                is_notification: true,
                notification_type: "file_stream",
                file_type: detectedType,
                content_chunk: "",
                is_complete: false,
              }));
            }
          }

          // Try to locate the start of the "content" value in the JSON args
          if (st.contentStartPos === null) {
            const m = st.accumulated.match(/"content"\s*:\s*"/);
            if (m && m.index !== undefined) {
              st.contentStartPos = m.index + m[0].length;
              st.lastSentPos = st.contentStartPos;
            }
          }

          const chunk = drainContentDelta(st);
          if (chunk) {
            // If panel hasn't been opened yet, open it now with whatever type we have
            if (!st.panelOpened) {
              st.panelOpened = true;
              flush();
              ws.send(JSON.stringify({
                type: "ai_chunk",
                is_notification: true,
                notification_type: "file_stream",
                file_type: toolFileType(st.toolName, st.accumulated),
                content_chunk: "",
                is_complete: false,
              }));
            }
            flush(); // flush any buffered chat text first
            ws.send(JSON.stringify({
              type: "ai_chunk",
              is_notification: true,
              notification_type: "file_stream",
              file_type: toolFileType(st.toolName, st.accumulated),
              content_chunk: chunk,
              is_complete: false,
            }));
          }
          break;
        }

        // tool-call fires once args are fully generated; execute() has NOT run yet.
        case "tool-call": {
          // Surface the SPECIFIC action (from the now-complete args) so the status
          // indicator reads "Reading src/foo.ts on feature/cal-7", not a bare tool name.
          if (event.toolName !== "askUser" && event.toolName !== "confirmAction") {
            const detail = toolActionDetail(event.toolName, (event as Record<string, unknown>).input ?? (event as Record<string, unknown>).args);
            // Record the step whether or not there's a specific detail — the fallback
            // label is what the user sees live, so it belongs in the saved trail too.
            noteActivity(detail || toolLabel(event.toolName), event.toolName);
            if (detail) {
              ws.send(JSON.stringify({
                type: "ai_chunk", chunk: "", is_final: false, is_notification: true,
                notification_type: "tool_detail", function_name: event.toolName,
                // The call id lets the client REFINE this line in place when the
                // result arrives, instead of adding a second row for the same action.
                tool_call_id: (event as Record<string, unknown>).toolCallId ?? null,
                investigation: INVESTIGATION_TOOLS.has(event.toolName), detail,
              }));
            }
          }
          if (event.toolName === "askUser") {
            // Try parsed input first (already available on the event), fall back to accumulated raw
            const raw = askUserArgs.get(event.toolCallId) ?? "";
            askUserArgs.delete(event.toolCallId);
            let rawQuestions: unknown[] = [];

            // Prefer the already-parsed input from the AI SDK
            const input = (event as Record<string, unknown>).input ?? (event as Record<string, unknown>).args;
            if (input && typeof input === "object" && Array.isArray((input as Record<string, unknown>).questions)) {
              rawQuestions = (input as Record<string, unknown>).questions as unknown[];
            } else if (raw) {
              // Fallback: parse from accumulated tool-input-delta
              try {
                const parsed = JSON.parse(raw);
                rawQuestions = Array.isArray(parsed.questions) ? parsed.questions : [];
              } catch {
                console.warn("[stream] Failed to parse askUser args:", raw.slice(0, 200));
              }
            }

            // Normalize title/options aliases → question/suggestions and drop
            // malformed items, so the card renders regardless of field naming.
            const questions = normalizeAskUserQuestions(rawQuestions);

            if (questions.length > 0) {
              flush();
              askUserCardSent = true;
              ws.send(JSON.stringify({
                type: "ai_chunk",
                chunk: "",
                is_final: false,
                is_notification: true,
                notification_type: "ask_user",
                questions,
              }));
            } else {
              console.warn("[stream] askUser called with empty questions. Parsed input:", JSON.stringify(input).slice(0, 300), "Raw args:", raw.slice(0, 300));
            }
          }

          if (event.toolName === "confirmAction") {
            const raw = confirmArgs.get(event.toolCallId) ?? "";
            confirmArgs.delete(event.toolCallId);

            // Prefer the already-parsed input; fall back to accumulated raw.
            let input = (event as Record<string, unknown>).input ?? (event as Record<string, unknown>).args;
            if ((!input || typeof input !== "object") && raw) {
              try { input = JSON.parse(raw); } catch { input = undefined; }
            }
            const obj = (input ?? {}) as Record<string, unknown>;
            const title = typeof obj.title === "string" ? obj.title : "";

            if (title) {
              flush();
              confirmCardSent = true;
              ws.send(JSON.stringify({
                type: "ai_chunk",
                chunk: "",
                is_final: false,
                is_notification: true,
                notification_type: "confirm_action",
                title,
                summary: typeof obj.summary === "string" ? obj.summary : "",
                confirmLabel: typeof obj.confirmLabel === "string" ? obj.confirmLabel : "Yes, go ahead",
                cancelLabel: typeof obj.cancelLabel === "string" ? obj.cancelLabel : "No, let me adjust",
              }));
            } else {
              console.warn("[stream] confirmAction called with empty title. Raw args:", raw.slice(0, 300));
            }
          }

          break;
        }

        case "tool-result": {
          // AI SDK v6 puts the tool's return value on `output`. Reading `.result`
          // (the v4/v5 name) silently yielded undefined, so everything gated on it —
          // the page-preview card, the resolved file name — simply never fired.
          const toolOutput = (ev: unknown): Record<string, unknown> | undefined => {
            const e = (ev ?? {}) as Record<string, unknown>;
            const v = e.output ?? e.result;
            return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
          };

          // The rendered page goes down the SAME channel as every other chat
          // notification — the one the trail already proves reaches the client.
          if (event.toolName === "previewPage") {
            const r = toolOutput(event);
            const id = r?.id;
            const nm = r?.name;
            if (typeof id === "string" && id) {
              const previewName = typeof nm === "string" ? nm : "Page preview";
              // Re-previewing under the same name replaces the entry, matching the
              // client, where a new render overwrites the same card.
              const at = pagePreviews.findIndex((p) => p.id === id || p.name === previewName);
              if (at >= 0) pagePreviews[at] = { id, name: previewName };
              else pagePreviews.push({ id, name: previewName });
              flush();
              ws.send(JSON.stringify({
                type: "ai_chunk", chunk: "", is_final: false, is_notification: true,
                notification_type: "page_preview",
                file_id: id,
                file_name: typeof nm === "string" ? nm : "Page preview",
              }));
            }
          }

          // A file is requested by ID, so the tool-call could only say "Reading a file".
          // The result carries the real name — send it back under the same call id so
          // the line becomes "Reading Main PRD".
          if (event.toolName === "getFileContent") {
            const r = toolOutput(event);
            const name = r?.name;
            if (typeof name === "string" && name.trim()) {
              // Replace the placeholder line rather than appending a second one.
              const refined = `Reading ${name.trim().slice(0, 60)}`;
              for (let i = activityTrail.length - 1; i >= 0; i--) {
                if (activityTrail[i]!.tool === "getFileContent" && /^Reading /.test(activityTrail[i]!.text)) {
                  activityTrail[i] = { text: refined, tool: "getFileContent" };
                  break;
                }
              }
              ws.send(JSON.stringify({
                type: "ai_chunk", chunk: "", is_final: false, is_notification: true,
                notification_type: "tool_detail", function_name: event.toolName,
                tool_call_id: (event as Record<string, unknown>).toolCallId ?? null,
                investigation: true, detail: `Reading ${name.trim().slice(0, 60)}`,
              }));
            }
          }
          // Fallback: if askUser card wasn't sent via tool-call, try from tool-result
          if (event.toolName === "askUser" && !askUserCardSent) {
            const resultObj = toolOutput(event);
            if (resultObj && typeof resultObj === "object") {
              const qList = normalizeAskUserQuestions(
                (resultObj as Record<string, unknown>).questions
              );
              if (qList.length > 0) {
                flush();
                askUserCardSent = true;
                ws.send(JSON.stringify({
                  type: "ai_chunk",
                  chunk: "",
                  is_final: false,
                  is_notification: true,
                  notification_type: "ask_user",
                  questions: qList,
                }));
              }
            }
          }
          break;
        }

        default:
          break;
      }
    }

    flush(); // send any remaining buffered text

  } catch (err: any) {
    if (err?.name !== "AbortError") {
      streamError = err;
    }
  } finally {
    // Composio tools are stateless — no client cleanup needed
  }

  // ── 7. Save assistant response ───────────────────────────────────────────────
  const cleanedResponse = stripCitations(fullResponse);
  const finalContent = streamError
    ? `${cleanedResponse}\n\n*Error: ${streamError.message}*`
    : cleanedResponse || "*Generation stopped*";

  // Capture the full AI SDK response sequence (intermediate assistant
  // text + tool-call + tool-result steps) so the next turn replays the
  // exact context the LLM had. Without this, the LLM only sees its own
  // final text and "forgets" what tools it ran (causes "I need that
  // doc" right after it just fetched the doc).
  let savedSteps: any[] | null = null;
  try {
    if (streamTextResult) {
      const resp = await streamTextResult.response;
      const rawMessages: any[] = (resp as any)?.messages ?? [];
      // Hard cap to avoid storing megabytes of tool output. Per-result
      // tool-result content is already capped at 8KB upstream; cap whole
      // turn at ~200KB to keep history loads cheap.
      const serialized = JSON.stringify(rawMessages);
      if (serialized.length <= 200_000) {
        savedSteps = rawMessages;
      } else {
        console.warn(
          `[stream-handler] toolSteps too large (${serialized.length}B), dropping for conv ${convId}`
        );
      }
    }
  } catch (err) {
    console.warn("[stream-handler] failed to capture response.messages:", (err as Error).message);
  }

  // Wait for any in-flight checkpoint to settle so assistantMsgId is set before we
  // finalize — otherwise the final upsert could insert a SECOND row (a duplicate).
  if (checkpointPromise) await checkpointPromise.catch(() => {});
  // Finalize the (possibly already-checkpointed) assistant row: authoritative content,
  // tool steps, and isPartial=false. Upserts the same row created during streaming, so
  // there's exactly one message — no duplicate, and nothing lost if the stream was cut off.
  await persistAssistant(finalContent, { steps: savedSteps, final: true });

  // ── 8. Send final signal ─────────────────────────────────────────────────────
  ws.send(JSON.stringify({
    type: "ai_chunk",
    chunk: streamError ? `\n\n*Error: ${streamError.message}*` : "",
    is_final: true,
    conversation_id: convId,
    projectId: projectId ?? null,
  }));

  // ── 9. Auto-generate title for new conversations ─────────────────────────────
  const isNewConv = !req.conversationId;
  if (isNewConv && fullResponse && !abortController.signal.aborted) {
    // Titling is a cheap, mechanical subtask — route it to the provider's lite
    // model (staying in-provider reuses the user's existing key). Fall back to
    // the full model if the provider has no distinct lite tier / key resolution
    // fails.
    let titleModel = model;
    try {
      titleModel = getLiteModel(modelKey, userApiKeys, { allowEnvFallback: !!instantMode }).model;
    } catch {
      // keep the full model
    }
    generateTitle(convId, userMessage, fullResponse, titleModel).catch(() => {});
  }

  return { conversationId: convId };
}

async function generateTitle(
  convId: string,
  userMessage: string,
  assistantResponse: string,
  model: ReturnType<typeof getModel>
) {
  try {
    const result = await streamText({
      model,
      messages: [
        {
          role: "user",
          content: `Generate a short, descriptive title (5 words max) for this conversation based on the first exchange. Respond with ONLY the title, no quotes or punctuation.\n\nUser: ${userMessage.slice(0, 200)}\nAssistant: ${assistantResponse.slice(0, 200)}`,
        },
      ],
      maxOutputTokens: 20,
    });

    let title = "";
    for await (const chunk of result.textStream) {
      title += chunk;
    }
    title = title.trim().replace(/^["']|["']$/g, "");

    if (title) {
      await db.update(conversations).set({ title, updatedAt: new Date() }).where(eq(conversations.id, convId));
    }
  } catch {
    // Title generation failing is non-critical
  }
}
