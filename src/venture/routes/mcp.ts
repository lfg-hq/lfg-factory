/**
 * Ventures MCP: POST /mcp/ventures
 *
 * Lets an LFG reviewer ask their own assistant (Claude Code, Claude Desktop) about
 * the venture pipeline: how many ventures, which verdicts, who went quiet and on
 * what question, full transcripts, and how LFG could help. It can also send a
 * founder a message from the LFG team.
 *
 * MCP over Streamable HTTP, stateless JSON-RPC (same shape as routes/mcp-server.ts).
 * Auth: a reviewer token from the dashboard ("Connect Claude"), re-checked against
 * VENTURE_ADMIN_EMAILS on every request.
 */
import { Hono } from "hono";
import { adminVentureDetail, adminVentureList, adviseOnVenture, postTeamMessage, verifyAdminToken, ventureStats, type Engagement } from "../services/admin.ts";
import { ventureLog } from "../request-log.ts";

const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any };
const reply = (id: Rpc["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const failure = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

const VERDICTS = ["fund", "needs_more_info", "decline", "prohibited", "not_assessed"];
const DECISIONS = ["pending", "approved", "needs_more_info", "declined", "prohibited"];
const ENGAGEMENT: Engagement[] = ["active", "quiet", "dropped", "not_started"];
const ventureId = { type: "string", description: "Venture id, from list_ventures." };

const TOOLS = [
  {
    name: "venture_stats",
    description: "Pipeline totals: ventures and founders, started this week, counts by analyst verdict, by LFG decision and by engagement (active = founder wrote in the last 2 days, quiet, dropped = a week of silence while waiting on the founder, not_started), and how many founders left right after an analyst question.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_ventures",
    description: "List ventures, most recently updated first, with founder name and email, verdict, LFG decision, engagement, message counts, when the founder last wrote, who spoke last, and (when the founder went silent after the analyst) the questions they were left with. Filter as needed.",
    inputSchema: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: VERDICTS, description: "Analyst verdict on the latest assessment." },
        decision: { type: "string", enum: DECISIONS, description: "LFG's latest decision." },
        engagement: { type: "string", enum: ENGAGEMENT },
        search: { type: "string", description: "Match title, founder name or email, or summary." },
        includeArchived: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Default 50." },
      },
    },
  },
  {
    name: "get_venture",
    description: "One venture in full: founder and email, engagement, the analyst's recommendation (verdict, missing inputs, next steps, commitments), LFG decisions with internal notes, founder tasks, timeline, and optionally the conversation transcript.",
    inputSchema: { type: "object", properties: { id: ventureId, transcript: { type: "boolean", description: "Include the conversation. Default true." }, lastMessages: { type: "integer", minimum: 1, maximum: 400, description: "How many recent messages. Default 60." } }, required: ["id"] },
  },
  {
    name: "advise_venture",
    description: "An AI read of one venture for the LFG team: where it stands, how the founder is engaging, what it is stuck on, concrete ways LFG can help, a draft message to the founder, and what the analyst should do differently. Optionally answers a specific question about it.",
    inputSchema: { type: "object", properties: { id: ventureId, question: { type: "string", description: "Optional question about this venture." } }, required: ["id"] },
  },
  {
    name: "send_founder_message",
    description: "Send the founder a message from the LFG team. It appears in their analyst chat, the analyst sees it as context, and (by default) the founder is emailed a copy with a link back. Only send text the reviewer has approved.",
    inputSchema: { type: "object", properties: { id: ventureId, message: { type: "string", description: "Plain text, at most 4,000 characters." }, email: { type: "boolean", description: "Also email the founder. Default true." } }, required: ["id", "message"] },
  },
];

const text = (value: unknown): { content: { type: string; text: string }[]; isError?: boolean } => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const problem = (message: string) => ({ content: [{ type: "text", text: message }], isError: true });
const pick = <T extends string>(value: unknown, allowed: readonly T[]) => (typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : undefined);

async function callTool(name: string, args: Record<string, any>) {
  switch (name) {
    case "venture_stats": return text(await ventureStats());
    case "list_ventures": return text(await adminVentureList({
      verdict: pick(args.verdict, VERDICTS), decision: pick(args.decision, DECISIONS), engagement: pick(args.engagement, ENGAGEMENT),
      search: typeof args.search === "string" ? args.search.slice(0, 200) : undefined, includeArchived: args.includeArchived === true,
      limit: Number.isInteger(args.limit) ? args.limit : undefined,
    }));
    case "get_venture": {
      const detail = await adminVentureDetail(String(args.id ?? ""), { transcript: args.transcript !== false, lastMessages: Number.isInteger(args.lastMessages) ? args.lastMessages : undefined });
      return detail ? text(detail) : problem("No venture with that id. Use list_ventures to find it.");
    }
    case "advise_venture": {
      try { return text(await adviseOnVenture(String(args.id ?? ""), typeof args.question === "string" ? args.question : undefined)); }
      catch (e) { return problem(e instanceof Error && e.message === "VENTURE_NOT_FOUND" ? "No venture with that id. Use list_ventures to find it." : "The advice could not be generated. Retry in a moment."); }
    }
    case "send_founder_message": {
      if (typeof args.message !== "string" || !args.message.trim() || args.message.length > 4000) return problem("Give a message of 1 to 4,000 characters.");
      try {
        const sent = await postTeamMessage(String(args.id ?? ""), args.message, { email: args.email !== false });
        return text({ sent: true, emailed: sent.emailed, messageId: sent.message.id });
      } catch (e) { return problem(e instanceof Error && e.message === "VENTURE_NOT_FOUND" ? "No venture with that id. Use list_ventures to find it." : "The message could not be sent."); }
    }
    default: return problem(`Unknown tool: ${name}`);
  }
}

const ventureMcp = new Hono();

ventureMcp.post("/mcp/ventures", async (c) => {
  const started = performance.now();
  const reviewer = await verifyAdminToken(c.req.header("authorization")?.replace(/^Bearer\s+/i, ""));
  if (!reviewer) return c.json(failure(null, -32001, "Unauthorized: create a token from the Ventures dashboard (Connect Claude)."), 401, { "WWW-Authenticate": "Bearer" });

  let body: Rpc | Rpc[];
  try { body = await c.req.json(); } catch { return c.json(failure(null, -32700, "Parse error"), 400); }
  const out: unknown[] = [];
  for (const rpc of Array.isArray(body) ? body : [body]) {
    if (!rpc || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") { out.push(failure(rpc?.id, -32600, "Invalid Request")); continue; }
    const isNotification = rpc.id === undefined || rpc.id === null;
    switch (rpc.method) {
      case "initialize": {
        const asked = rpc.params?.protocolVersion;
        out.push(reply(rpc.id, {
          protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "lfg-ventures", version: "1.0.0" },
          instructions: "LFG Ventures, for LFG's reviewers: the founders talking to LFG's AI venture analyst. Use venture_stats for totals, list_ventures to find ventures (filter by verdict, decision or engagement), get_venture for one venture and its transcript, advise_venture for how LFG can help, and send_founder_message only with text the reviewer approved. Founder emails and transcripts are private: don't share them outside LFG.",
        }));
        break;
      }
      case "ping": out.push(reply(rpc.id, {})); break;
      case "tools/list": out.push(reply(rpc.id, { tools: TOOLS })); break;
      case "tools/call": {
        const name = String(rpc.params?.name ?? "");
        const args = rpc.params?.arguments && typeof rpc.params.arguments === "object" ? rpc.params.arguments : {};
        let result;
        try { result = await callTool(name, args); } catch { result = problem("The tool failed. Retry in a moment."); }
        ventureLog("venture.mcp.tool", `mcp-${crypto.randomUUID()}`, started, result.isError ? "failed" : "success", { tool: name, reviewer: reviewer.id });
        out.push(reply(rpc.id, result));
        break;
      }
      default:
        if (!isNotification) out.push(failure(rpc.id, -32601, `Method not found: ${rpc.method}`));
    }
  }
  if (!out.length) return c.body(null, 202);
  return c.json(Array.isArray(body) ? out : out[0]);
});

export default ventureMcp;
