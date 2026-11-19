/**
 * LFG MCP endpoint: POST /mcp/turn/:turnId
 *
 * An agent running on someone's own computer (Claude Code, Codex, Copilot) calls LFG's
 * tools here during one chat turn, so the documents, tickets and notes it creates are
 * saved in LFG's database like any other chat's.
 *
 * MCP over Streamable HTTP, stateless: each POST carries JSON-RPC (initialize, ping,
 * tools/list, tools/call) and gets a JSON reply; GET (server-initiated streams) is not
 * offered. Auth: the turn's bearer token (services/runner/turn-tokens.ts). Context
 * fields the server owns (projectId, userId, conversationId, turnId) are hidden from
 * the tool schemas and filled in from the grant, so the agent can't point a tool at
 * another project. Chat access is re-checked on every request.
 */

import { Hono } from "hono";
import { asSchema } from "ai";
import { getChatAccess } from "../services/chat-access.ts";
import { verifyTurnToken, type TurnGrant } from "../services/runner/turn-tokens.ts";
import { buildMcpTools } from "../ai/mcp-tools.ts";

const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_OWNED = ["projectId", "userId", "conversationId", "turnId"];

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any };
const reply = (id: Rpc["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const failure = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** The tool's JSON schema as the agent sees it: without the fields the server fills in. */
async function publicSchema(tool: any): Promise<Record<string, unknown>> {
  const schema = structuredClone(await asSchema(tool.inputSchema).jsonSchema) as Record<string, any>;
  if (schema.properties) for (const key of SERVER_OWNED) delete schema.properties[key];
  if (Array.isArray(schema.required)) schema.required = schema.required.filter((k: string) => !SERVER_OWNED.includes(k));
  delete schema.$schema;
  return schema;
}

/** Property names a JSON schema accepts, including in anyOf/oneOf/allOf branches. */
function declaredKeys(schema: any, out = new Set<string>()): Set<string> {
  if (!schema || typeof schema !== "object") return out;
  for (const key of Object.keys(schema.properties ?? {})) out.add(key);
  for (const branch of [...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])]) declaredKeys(branch, out);
  return out;
}

async function callTool(tools: Record<string, any>, grant: TurnGrant, name: string, args: Record<string, unknown>, callId: string, signal: AbortSignal) {
  const tool = tools[name];
  if (!tool?.execute) return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  const schema = asSchema(tool.inputSchema);
  // Fill in the server-owned fields only where the tool declares them: strict schemas
  // (the preview tools) reject unknown keys, which failed every preview call.
  const declared = declaredKeys(await schema.jsonSchema);
  const owned: Record<string, unknown> = { projectId: grant.projectId ?? undefined, userId: grant.userId, conversationId: grant.conversationId };
  const input = { ...args };
  for (const key of SERVER_OWNED) { if (declared.has(key)) input[key] = owned[key]; else delete input[key]; }
  const checked = schema.validate ? await schema.validate(input) : { success: true as const, value: input };
  if (!checked.success) return { content: [{ type: "text", text: `Invalid arguments for ${name}: ${String((checked as { error?: unknown }).error ?? "")}`.slice(0, 2000) }], isError: true };
  try {
    const result = await tool.execute(checked.value, { toolCallId: callId, messages: [], abortSignal: signal });
    return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result ?? null) }] };
  } catch (error) {
    return { content: [{ type: "text", text: `${name} failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

const mcpServer = new Hono();

mcpServer.get("/mcp/turn/:turnId", (c) => c.text("Method Not Allowed", 405, { Allow: "POST" }));
mcpServer.delete("/mcp/turn/:turnId", (c) => c.body(null, 405, { Allow: "POST" }));

mcpServer.post("/mcp/turn/:turnId", async (c) => {
  const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
  const grant = await verifyTurnToken(c.req.param("turnId"), token);
  if (!grant) return c.json(failure(null, -32001, "Unauthorized"), 401, { "WWW-Authenticate": "Bearer" });
  const access = await getChatAccess(grant.conversationId, grant.userId);
  if (!access.canWrite) return c.json(failure(null, -32001, "No longer allowed to use this conversation"), 403);

  let body: Rpc | Rpc[];
  try { body = await c.req.json(); } catch { return c.json(failure(null, -32700, "Parse error"), 400); }
  const batch = Array.isArray(body) ? body : [body];
  let tools: Record<string, any> | null = null;
  const toolsFor = async () => (tools ??= await buildMcpTools(grant));

  const out: unknown[] = [];
  for (const rpc of batch) {
    if (!rpc || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") { out.push(failure(rpc?.id, -32600, "Invalid Request")); continue; }
    const isNotification = rpc.id === undefined || rpc.id === null;
    switch (rpc.method) {
      case "initialize": {
        const asked = rpc.params?.protocolVersion;
        out.push(reply(rpc.id, {
          protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "lfg", version: "1.0.0" },
          instructions: "LFG's workspace for this conversation: read and write the project's documents, tickets, epics and notes. Save every document or ticket you produce here; that is how your work reaches the team.",
        }));
        break;
      }
      case "ping": out.push(reply(rpc.id, {})); break;
      case "tools/list": {
        const all = await toolsFor();
        out.push(reply(rpc.id, {
          tools: await Promise.all(Object.entries(all).map(async ([name, tool]) => ({
            name, description: String(tool.description ?? "").slice(0, 4000), inputSchema: await publicSchema(tool),
          }))),
        }));
        break;
      }
      case "tools/call": {
        const name = String(rpc.params?.name ?? "");
        const args = (rpc.params?.arguments && typeof rpc.params.arguments === "object") ? rpc.params.arguments : {};
        out.push(reply(rpc.id, await callTool(await toolsFor(), grant, name, args, String(rpc.id ?? ""), c.req.raw.signal)));
        break;
      }
      default:
        if (!isNotification) out.push(failure(rpc.id, -32601, `Method not found: ${rpc.method}`));
    }
  }
  if (!out.length) return c.body(null, 202);
  return c.json(Array.isArray(body) ? out : out[0]);
});

export default mcpServer;
