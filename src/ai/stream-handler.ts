import { streamText, stepCountIs, generateText } from "ai";
import { promises as fs } from "node:fs";
import path from "node:path";
import { db } from "../config/db.ts";
import { messages, conversations, modelSelections, agentRoles, chatFiles } from "../db/schema/chat.ts";
import { llmApiKeys } from "../db/schema/users.ts";
import { projects } from "../db/schema/projects.ts";
import { projectFiles } from "../db/schema/documents.ts";
import { projectTickets, ticketLogs, ticketAddenda } from "../db/schema/tickets.ts";
import { eq, and, desc, inArray } from "drizzle-orm";
import { getModel, getModelWithSearch, getProviderName, getLiteModel, DEFAULT_MODEL_KEY } from "./provider.ts";
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
import { createAgentTools } from "./tools/agent-tools.ts";
import { broadcastToUser, getConnection } from "../ws/connection-manager.ts";
import { getComposioTools, listConnectors } from "../services/composio-manager.ts";
import { downloadBinary } from "../services/s3.ts";
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
}

// Providers whose configured models can view images directly (multimodal).
const VISION_NATIVE = new Set(["anthropic", "openai", "google"]);
// A cheap/fast vision model per provider, used to describe an image for a
// text-only model (DeepSeek's hosted API is text-only) — the "vision model
// first, reasoning model second" pattern.
const VISION_MODEL: Record<string, string> = {
  openai: "gpt-5.6-luna", google: "gemini_2.5_flash_lite", anthropic: "claude_4.5_haiku",
};

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

/** Describe an image using whatever vision-capable key the user has. Returns the
 *  text description, or null if no vision model is available / it fails. */
async function analyzeImage(bytes: Uint8Array, mediaType: string, userApiKeys: any): Promise<string | null> {
  for (const provider of ["openai", "google", "anthropic"]) {
    // Use the user's vision key if they have one, else fall back to the SERVER's
    // env key (allowEnvFallback). getModel throws only if NEITHER exists for this
    // provider → catch + try the next. This is what makes the DeepSeek (text-only)
    // vision pre-pass work on prod where the user has no personal vision key.
    try {
      const model = getModel(VISION_MODEL[provider]!, userApiKeys, { allowEnvFallback: true });
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
      if (out) { console.log(`[vision] described image via ${provider} (${out.length} chars)`); return out; }
    } catch (e) {
      console.warn(`[vision] ${provider} describe failed:`, (e as Error).message?.slice(0, 120));
    }
  }
  return null;
}

export async function handleStream(req: StreamRequest): Promise<{ conversationId: string }> {
  const { ws, userId, userMessage, projectId, turboMode, instantMode, abortController } = req;

  // ── 1. Resolve or create conversation ───────────────────────────────────────
  let convId = req.conversationId;
  if (convId) {
    // Verify the conversation actually exists — stale URLs can reference deleted conversations
    const [existing] = await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, convId)).limit(1);
    if (!existing) {
      console.log(`[stream] Conversation ${convId} not found in DB, creating new one`);
      convId = undefined;
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

  const [apiKeys] = await db
    .select()
    .from(llmApiKeys)
    .where(eq(llmApiKeys.userId, userId));

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
    const providerName = getProviderName(modelKey);
    if (images.length && providerName && VISION_NATIVE.has(providerName)) {
      // Vision-native models: attach every image directly to the last user message.
      setLastUser([{ type: "text", text: userMessage }, ...images.map((x) => ({ type: "image", image: x.bytes, mediaType: x.f.type }))]);
    } else if (images.length) {
      // Text-only model: describe each image via the vision pre-pass and inject the text.
      ws.send(JSON.stringify({ type: "ai_chunk", chunk: "", is_final: false, is_notification: true, notification_type: "status", message: images.length > 1 ? `Analyzing ${images.length} images…` : "Analyzing image…" }));
      const descs: string[] = [];
      for (const x of images) {
        const desc = await analyzeImage(x.bytes, x.f.type || "image/png", userApiKeys);
        descs.push(desc
          ? `[Attached image "${x.f.name}". The current model can't view images — here is a vision model's description, treat it as ground truth:\n\n${desc}]`
          : `[The user attached an image "${x.f.name}", but the selected model can't view images and no vision-capable key (OpenAI / Google / Anthropic) is configured. Tell them to add one in Settings → LLM Keys or switch to a vision model — do NOT guess what the image shows.]`);
      }
      setLastUser(`${userMessage}\n\n${descs.join("\n\n")}`);
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

  // Polymorphic tool bag: composition varies by mode (agent / instant / product).
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

  // Add web search tools based on the active provider
  if (Object.keys(searchTools).length > 0) {
    tools = { ...tools, ...searchTools };
  }

  // Add agent-specific tools (sandbox, memory, self-config).
  if (agentRecord) {
    const agentTools = createAgentTools({ agentId: agentRecord.agentId, userId });
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
    systemPrompt = getProductSystemPrompt({ userId, projectId: internalProjectId, projectFlags });
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
        }).where(eq(messages.id, assistantMsgId));
      } else {
        const [row] = await db.insert(messages).values({
          conversationId: convId,
          role: "assistant",
          content,
          isPartial: !final,
          toolSteps: opts.steps ?? null,
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
          // Fallback: if askUser card wasn't sent via tool-call, try from tool-result
          if (event.toolName === "askUser" && !askUserCardSent) {
            const resultObj = (event as Record<string, unknown>).result;
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
