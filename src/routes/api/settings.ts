import { availableChatModels, chatPickerModels } from "../../services/available-models.ts";
import { userLlmAccess } from "../../services/llm-access.ts";
import { Hono } from "hono";
import { requireAuth } from "../../auth/middleware.ts";
import { db } from "../../config/db.ts";
import { modelSelections, agentRoles } from "../../db/schema/chat.ts";
import { applicationState } from "../../db/schema/users.ts";
import { telegramBots } from "../../db/schema/telegram.ts";
import { eq } from "drizzle-orm";
import { listModels, listChatModels, DEFAULT_MODEL_KEY } from "../../ai/provider.ts";
import { isSubscriptionModel } from "../../ai/pi-subscription-model.ts";
import { hasOpenAICodexCredentials } from "../../services/openai-codex-auth.ts";
import { subscriptionOwner } from "../../services/subscription-execution.ts";
import { validateBotToken, startBotForUser, stopBotForUser, isBotActive } from "../../services/telegram.ts";
import type { auth } from "../../auth/index.ts";

type AuthEnv = {
  Variables: {
    user: typeof auth.$Infer.Session.user;
    session: typeof auth.$Infer.Session.session;
  };
};

const settings = new Hono<AuthEnv>();
settings.use("*", requireAuth);

// POST /api/settings/model  — { modelKey: string }
settings.post("/model", async (c) => {
  const user = c.get("user");
  const { modelKey, projectId } = await c.req.json<{ modelKey: string; projectId?: string }>();

  if (!modelKey) return c.json({ error: "modelKey required" }, 400);
  // The agent on the person's computer is chosen in Settings → Integrations; here, its model.
  if (modelKey.startsWith("local/")) {
    const { localAiSettings, setLocalAiSettings, LOCAL_AGENT_MODELS } = await import("../../services/runner/opt-in.ts");
    const [, agent, model] = modelKey.split("/");
    const local = await localAiSettings(user.id);
    if (agent !== local.agent) return c.json({ error: "Pick the agent in Settings → Integrations first." }, 400);
    if (model && !LOCAL_AGENT_MODELS[local.agent].some(m => m.id === model)) return c.json({ error: "Unknown model for this agent" }, 400);
    await setLocalAiSettings(user.id, { model: model || null });
    return c.json({ success: true, modelKey });
  }

  // Validate against known models
  const known = (await availableChatModels(user.id, projectId)).find((m) => m.key === modelKey);
  if (!known) return c.json({ error: "Unknown model key" }, 400);
  if (isSubscriptionModel(modelKey) && !await hasOpenAICodexCredentials(await subscriptionOwner(user.id, projectId))) {
    return c.json({ error: "Connect ChatGPT in Settings, or ask the project owner to grant subscription access." }, 400);
  }

  await db
    .insert(modelSelections)
    .values({ userId: user.id, selectedModel: modelKey })
    .onConflictDoUpdate({
      target: modelSelections.userId,
      set: { selectedModel: modelKey, updatedAt: new Date() },
    });

  return c.json({ success: true, modelKey });
});

// POST /api/settings/role  — { role: string }
settings.post("/role", async (c) => {
  const user = c.get("user");
  const { role } = await c.req.json<{ role: string }>();

  const validRoles = ["product_analyst", "developer", "designer", "default"];
  if (!validRoles.includes(role)) {
    return c.json({ error: "Invalid role" }, 400);
  }

  await db
    .insert(agentRoles)
    .values({ userId: user.id, name: role })
    .onConflictDoUpdate({
      target: agentRoles.userId,
      set: { name: role, updatedAt: new Date() },
    });

  return c.json({ success: true, role });
});

// POST /api/settings/local-effort — { effort: "low"|…|"max"|null }: effort for the agent on the person's computer
settings.post("/local-effort", async (c) => {
  const user = c.get("user");
  const { effort } = await c.req.json<{ effort?: string | null }>();
  const { localAiSettings, setLocalAiSettings, LOCAL_AGENT_EFFORTS } = await import("../../services/runner/opt-in.ts");
  const local = await localAiSettings(user.id);
  if (effort && !(LOCAL_AGENT_EFFORTS[local.agent] as string[]).includes(effort)) return c.json({ error: "Unknown effort level for this agent" }, 400);
  const saved = await setLocalAiSettings(user.id, { effort: (effort || null) as any });
  return c.json({ success: true, effort: saved.effort });
});

// GET /api/settings/local-usage — the plan usage the agent on the person's computer last reported
settings.get("/local-usage", async (c) => {
  const { localAgentUsage, localAiSettings } = await import("../../services/runner/opt-in.ts");
  const userId = c.get("user").id;
  const [local, usage] = await Promise.all([localAiSettings(userId), localAgentUsage(userId)]);
  return c.json({ enabled: local.enabled, agent: local.agent, usage: usage?.agent === local.agent ? usage : null });
});

// GET /api/settings/models — list available models
settings.get("/models", async (c) => {
  return c.json({ models: (await chatPickerModels(c.get("user").id, c.req.query("projectId"))).models });
});

// GET /api/settings/me — current user model + role selection
settings.get("/me", async (c) => {
  const user = c.get("user");

  const [modelSel, roleRow] = await Promise.all([
    db.select().from(modelSelections).where(eq(modelSelections.userId, user.id)).then((r) => r[0]),
    db.select().from(agentRoles).where(eq(agentRoles.userId, user.id)).then((r) => r[0]),
  ]);

  return c.json({
    modelKey: modelSel?.selectedModel ?? DEFAULT_MODEL_KEY,
    role: roleRow?.name ?? "product_analyst",
    turboMode: roleRow?.turboMode ?? false,
  });
});

// PATCH /api/settings/execution-mode — coding-agent model + credential source.
// claudeCodeEnabled remains for backward compatibility while Direct API is hidden.
settings.patch("/execution-mode", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    projectId?: string;
    claudeCodeEnabled?: boolean;
    builderModelKey?: string;
    builderAuthMode?: "subscription" | "api_key";
  }>();

  const access = await userLlmAccess(user.id, body.projectId);
  if (body.builderAuthMode === "api_key" && !access.canUseKey || body.builderAuthMode === "subscription" && !access.canUseSubscription) return c.json({ error: "Credential source disabled by admin" }, 403);
  if (body.builderModelKey && !access.canUseKey && listModels().find(m => m.key === body.builderModelKey)?.provider !== "openai") return c.json({ error: "Only ChatGPT models are enabled" }, 403);

  if (body.builderModelKey) {
    const known = listModels().find((m) => m.key === body.builderModelKey);
    if (!known) return c.json({ error: "Unknown model key" }, 400);
  }
  if (body.builderAuthMode && !["subscription", "api_key"].includes(body.builderAuthMode)) {
    return c.json({ error: "Invalid builder auth mode" }, 400);
  }

  // Check if row exists
  const [existing] = await db
    .select({ id: applicationState.id })
    .from(applicationState)
    .where(eq(applicationState.userId, user.id))
    .limit(1);

  if (existing) {
    // Update existing row
    const setData: Record<string, unknown> = { updatedAt: new Date() };
    if (typeof body.claudeCodeEnabled === "boolean") setData.claudeCodeEnabled = body.claudeCodeEnabled;
    if (body.builderModelKey) setData.builderModelKey = body.builderModelKey;
    if (body.builderAuthMode) setData.builderAuthMode = body.builderAuthMode;
    await db.update(applicationState).set(setData).where(eq(applicationState.userId, user.id));
  } else {
    // Insert new row with explicit defaults
    await db.insert(applicationState).values({
      userId: user.id,
      claudeCodeEnabled: typeof body.claudeCodeEnabled === "boolean" ? body.claudeCodeEnabled : true,
      builderModelKey: body.builderModelKey ?? "claude_4.5_sonnet",
      builderAuthMode: body.builderAuthMode ?? "subscription",
    });
  }

  return c.json({ success: true });
});

// ── Telegram integration ─────────────────────────────────────────────

// GET /api/settings/telegram/status — check bot status
settings.get("/telegram/status", async (c) => {
  const user = c.get("user");
  const [bot] = await db
    .select()
    .from(telegramBots)
    .where(eq(telegramBots.userId, user.id));

  if (!bot) {
    return c.json({ connected: false });
  }

  return c.json({
    connected: true,
    botUsername: bot.botUsername,
    enabled: bot.enabled,
    active: isBotActive(user.id),
    projectId: bot.projectId,
  });
});

// POST /api/settings/telegram/connect — validate & save bot token
settings.post("/telegram/connect", async (c) => {
  const user = c.get("user");
  const { token } = await c.req.json<{ token: string }>();

  if (!token?.trim()) {
    return c.json({ error: "Bot token is required" }, 400);
  }

  // Validate the token
  const result = await validateBotToken(token.trim());
  if (!result.ok) {
    return c.json({ error: result.error ?? "Invalid bot token" }, 400);
  }

  // Upsert
  const existing = await db
    .select()
    .from(telegramBots)
    .where(eq(telegramBots.userId, user.id));

  if (existing.length > 0) {
    // Stop existing polling
    stopBotForUser(user.id);
    await db
      .update(telegramBots)
      .set({
        botToken: token.trim(),
        botUsername: result.username ?? null,
        enabled: true,
        conversationId: null,
        updatedAt: new Date(),
      })
      .where(eq(telegramBots.userId, user.id));
  } else {
    await db.insert(telegramBots).values({
      userId: user.id,
      botToken: token.trim(),
      botUsername: result.username ?? null,
    });
  }

  // Start polling
  await startBotForUser(user.id, token.trim());

  return c.json({ success: true, botUsername: result.username });
});

// POST /api/settings/telegram/disconnect — remove bot
settings.post("/telegram/disconnect", async (c) => {
  const user = c.get("user");
  stopBotForUser(user.id);
  await db.delete(telegramBots).where(eq(telegramBots.userId, user.id));
  return c.json({ success: true });
});

export default settings;
