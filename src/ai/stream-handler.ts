import { streamText, stepCountIs } from "ai";
import { db } from "../config/db.ts";
import { messages, conversations, modelSelections, agentRoles } from "../db/schema/chat.ts";
import { llmApiKeys } from "../db/schema/users.ts";
import { projects } from "../db/schema/projects.ts";
import { projectFiles } from "../db/schema/documents.ts";
import { projectTickets } from "../db/schema/tickets.ts";
import { eq, desc } from "drizzle-orm";
import { getModel, getModelWithSearch, getProviderName, DEFAULT_MODEL_KEY } from "./provider.ts";
import { toolsProduct, toolsTurbo } from "./tools/index.ts";
import { createInstantTools } from "./tools/instant-tools.ts";
import { setDocumentWsBroadcast, setTicketWsBroadcast } from "./tools/index.ts";
import { setMiscWsBroadcast } from "./tools/index.ts";
import { getProductSystemPrompt } from "./prompts/product.ts";
import { getInstantSystemPrompt } from "./prompts/instant.ts";
import { getAgentSystemPrompt } from "./prompts/agent.ts";
import { getAgentByConversation } from "../services/agent-manager.ts";
import { createAgentTools } from "./tools/agent-tools.ts";
import { broadcastToUser } from "../ws/connection-manager.ts";
import { getComposioTools, listConnectors } from "../services/composio-manager.ts";
import type { ServerWebSocket } from "bun";
import type { WsData } from "../ws/types.ts";

const MAX_HISTORY = 20; // messages to load for context
const FLUSH_CHARS = 80;
const FLUSH_MS = 80;

// ── Tool names whose arguments should be streamed to the right panel ──────────
const DOCUMENT_STREAM_TOOLS = new Set([
  "streamDocumentContent",
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
  abortController: AbortController;
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

  // ── 1b. Detect agent conversation ────────────────────────────────────────────
  const agentRecord = convId ? await getAgentByConversation(convId) : null;

  // ── 2. Save user message ─────────────────────────────────────────────────────
  await db.insert(messages).values({
    conversationId: convId,
    role: "user",
    content: userMessage,
  });

  // ── 3. Load recent history ───────────────────────────────────────────────────
  const history = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, convId))
    .orderBy(desc(messages.createdAt))
    .limit(MAX_HISTORY);

  const contextMessages = history
    .reverse()
    .map((m) => ({ role: m.role as "user" | "assistant" | "system", content: m.content }));

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
    ? { anthropic: apiKeys.anthropicApiKey ?? undefined, openai: apiKeys.openaiApiKey ?? undefined, google: apiKeys.googleApiKey ?? undefined, kimi: apiKeys.kimiApiKey ?? undefined }
    : undefined;

  // ── Check user has a key for the selected provider (unless instant mode) ────
  if (!instantMode) {
    const providerName = getProviderName(modelKey);
    const keyMap: Record<string, string | undefined> = {
      openai: userApiKeys?.openai,
      anthropic: userApiKeys?.anthropic,
      google: userApiKeys?.google,
      kimi: userApiKeys?.kimi,
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

  const flush = () => {
    if (!chunkBuffer) return;
    ws.send(JSON.stringify({ type: "ai_chunk", chunk: stripCitations(chunkBuffer), is_final: false }));
    chunkBuffer = "";
    lastFlush = Date.now();
  };

  try {
    const result = streamText({
      model,
      system: systemPrompt,
      messages: contextMessages,
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
          // askUser is handled in the tool-call fullStream event
          if (tc.toolName === "askUser") continue;
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

    // ── Use fullStream so we can intercept tool-input-delta events and forward
    //    document content character-by-character as the model generates it.
    const docStreams = new Map<string, DocStreamState>();

    // Accumulate askUser tool args from deltas (event.args/result may be empty)
    const askUserArgs = new Map<string, string>();
    let askUserCardSent = false;

    for await (const event of result.fullStream) {
      if (abortController.signal.aborted) break;

      switch (event.type) {

        case "text-delta": {
          // After askUser card is sent, suppress text entirely — both display
          // and DB persistence.  The post-card text just references the
          // transient card UI which isn't persisted, so saving it confuses
          // the AI on subsequent turns.
          if (askUserCardSent) break;

          fullResponse += event.text;
          chunkBuffer += event.text;
          const now = Date.now();
          if (chunkBuffer.length >= FLUSH_CHARS || now - lastFlush >= FLUSH_MS) flush();
          break;
        }

        case "tool-input-start": {
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
          // Notify client immediately when ANY tool starts (shows indicator)
          // Skip askUser — it sends its own notification with question data
          if (event.toolName !== "askUser") {
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
            let questions: unknown[] = [];

            // Prefer the already-parsed input from the AI SDK
            const input = (event as Record<string, unknown>).input ?? (event as Record<string, unknown>).args;
            if (input && typeof input === "object" && Array.isArray((input as Record<string, unknown>).questions)) {
              questions = (input as Record<string, unknown>).questions as unknown[];
            } else if (raw) {
              // Fallback: parse from accumulated tool-input-delta
              try {
                const parsed = JSON.parse(raw);
                questions = Array.isArray(parsed.questions) ? parsed.questions : [];
              } catch {
                console.warn("[stream] Failed to parse askUser args:", raw.slice(0, 200));
              }
            }

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

          break;
        }

        case "tool-result": {
          // Fallback: if askUser card wasn't sent via tool-call, try from tool-result
          if (event.toolName === "askUser" && !askUserCardSent) {
            const resultObj = (event as Record<string, unknown>).result;
            if (resultObj && typeof resultObj === "object") {
              const qList = (resultObj as Record<string, unknown>).questions;
              if (Array.isArray(qList) && qList.length > 0) {
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

  if (finalContent) {
    await db.insert(messages).values({
      conversationId: convId,
      role: "assistant",
      content: finalContent,
    });
  }

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
    generateTitle(convId, userMessage, fullResponse, model).catch(() => {});
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
