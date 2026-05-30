/**
 * Agent Webhook Trigger — Phase 2 T2
 *
 * Public endpoint (no session auth). Each agent has a signed webhookToken
 * generated at creation time. POSTing to /api/agents/webhook/:token fires
 * a "webhook" run on that agent with the request body forwarded as the
 * trigger payload.
 *
 * Used for: Stripe webhooks, GitHub events, inbound-email relays, Zapier
 * steps, or anything else that wants to push work into an agent from the
 * outside world.
 */

import { Hono } from "hono";
import { getAgentByWebhookToken } from "../../services/agent-manager.ts";
import { runAgentTask } from "../../services/agent-runner.ts";

export const agentWebhookRouter = new Hono();

// POST /api/agents/webhook/:token
agentWebhookRouter.post("/webhook/:token", async (c) => {
  const { token } = c.req.param();
  if (!token || token.length < 16) return c.json({ error: "Invalid token" }, 400);

  const agent = await getAgentByWebhookToken(token);
  if (!agent) return c.json({ error: "Unknown webhook token" }, 404);

  let payload: Record<string, unknown> = {};
  try {
    const text = await c.req.text();
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
      }
    }
  } catch {
    payload = {};
  }

  // Headers can be useful context (e.g. Stripe-Signature, X-GitHub-Event)
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    // Don't echo the token header back into the payload
    if (key.toLowerCase() === "authorization") return;
    headers[key] = value;
  });

  const prompt =
    agent.instructions?.trim() ||
    "A webhook event was received. Inspect the trigger payload, decide what to do, and act.";

  try {
    const result = await runAgentTask({
      agentId: agent.agentId,
      userId: agent.userId,
      prompt,
      triggerType: "webhook",
      payload: { ...payload, __headers: headers },
    });
    return c.json({ status: result.status, run_id: result.runId, output: result.output });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});
