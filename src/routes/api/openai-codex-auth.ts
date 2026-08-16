/** OpenAI Codex (ChatGPT subscription) connector API for Pi sandbox builds. */

import { Hono } from "hono";
import { requireAuth } from "../../auth/middleware.ts";
import type { auth } from "../../auth/index.ts";
import {
  disconnectOpenAICodex,
  pollOpenAICodexAuth,
  startOpenAICodexAuth,
} from "../../services/openai-codex-auth.ts";

type AuthEnv = {
  Variables: {
    user: typeof auth.$Infer.Session.user;
    session: typeof auth.$Infer.Session.session;
  };
};

const openAICodexAuthApi = new Hono<AuthEnv>();
openAICodexAuthApi.use("*", requireAuth);

openAICodexAuthApi.post("/start", async (c) => {
  const result = await startOpenAICodexAuth(c.get("user").id);
  return c.json(result, result.status === "error" ? 500 : 200);
});

openAICodexAuthApi.get("/status", async (c) => {
  try {
    return c.json(await pollOpenAICodexAuth(c.get("user").id));
  } catch (error) {
    console.error("[openai-codex-auth/status]", error);
    return c.json({ authenticated: false, pending: false, error: String(error) }, 500);
  }
});

openAICodexAuthApi.post("/disconnect", async (c) => {
  try {
    await disconnectOpenAICodex(c.get("user").id);
    return c.json({ ok: true });
  } catch (error) {
    console.error("[openai-codex-auth/disconnect]", error);
    return c.json({ ok: false, error: String(error) }, 500);
  }
});

export default openAICodexAuthApi;
