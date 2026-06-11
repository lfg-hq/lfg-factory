import { Hono } from "hono";
import { requireAuth } from "../auth/middleware.ts";
import { db } from "../config/db.ts";
import { llmApiKeys, profiles, githubTokens } from "../db/schema/users.ts";
import { telegramBots } from "../db/schema/telegram.ts";
import { composioToolkits } from "../db/schema/composio.ts";
import { eq } from "drizzle-orm";
import { isBotActive } from "../services/telegram.ts";
import { isComposioConfigured } from "../services/composio-manager.ts";
import { SettingsPage } from "../templates/pages/settings.tsx";
import { env } from "../config/env.ts";
import type { auth } from "../auth/index.ts";

type AuthEnv = {
  Variables: {
    user: typeof auth.$Infer.Session.user;
    session: typeof auth.$Infer.Session.session;
  };
};

const settingsRouter = new Hono<AuthEnv>();
settingsRouter.use("*", requireAuth);

async function getOrCreateApiKeys(userId: string) {
  let [row] = await db.select().from(llmApiKeys).where(eq(llmApiKeys.userId, userId));
  if (!row) {
    [row] = await db.insert(llmApiKeys).values({ userId }).returning();
  }
  return row!;
}

async function getProfile(userId: string) {
  let [row] = await db.select().from(profiles).where(eq(profiles.userId, userId));
  if (!row) {
    [row] = await db.insert(profiles).values({ userId }).returning();
  }
  return row!;
}

async function getGithubToken(userId: string) {
  const [row] = await db.select().from(githubTokens).where(eq(githubTokens.userId, userId));
  return row ?? null;
}

async function getTelegramBot(userId: string) {
  const [row] = await db.select().from(telegramBots).where(eq(telegramBots.userId, userId));
  return row ?? null;
}

// GET /settings
settingsRouter.get("/settings", async (c) => {
  const user = c.get("user");
  const [keys, profile, ghToken] = await Promise.all([
    getOrCreateApiKeys(user.id),
    getProfile(user.id),
    getGithubToken(user.id),
  ]);
  return c.html(
    SettingsPage({
      user: { id: user.id, name: user.name, email: user.email },
      apiKeys: {
        openai: !!keys.openaiApiKey,
        anthropic: !!keys.anthropicApiKey,
        google: !!keys.googleApiKey,
        xai: !!keys.xaiApiKey,
        kimi: !!keys.kimiApiKey,
        deepseek: !!keys.deepseekApiKey,
        usePersonalKeys: keys.usePersonalLlmKeys,
      },
      claudeCode: {
        authenticated: profile.claudeCodeAuthenticated,
        hasCredentials: !!profile.claudeCodeCredentials,
        cliApiKey: profile.cliApiKey ?? null,
      },
      github: {
        connected: !!ghToken,
        username: ghToken?.githubUsername ?? null,
        avatarUrl: ghToken?.githubAvatarUrl ?? null,
      },
    })
  );
});

// POST /settings/save-key
settingsRouter.post("/settings/save-key", async (c) => {
  const user = c.get("user");
  const body = await c.req.parseBody();
  const provider = body["provider"] as string;
  const key = (body["key"] as string | undefined)?.trim();

  if (!key) return c.redirect("/settings?error=Key+cannot+be+empty");

  const fieldMap: Record<string, string> = {
    openai: "openaiApiKey",
    anthropic: "anthropicApiKey",
    google: "googleApiKey",
    xai: "xaiApiKey",
    kimi: "kimiApiKey",
    deepseek: "deepseekApiKey",
  };
  const field = fieldMap[provider];
  if (!field) return c.redirect("/settings?error=Unknown+provider");

  await db
    .insert(llmApiKeys)
    .values({ userId: user.id, [field]: key })
    .onConflictDoUpdate({
      target: llmApiKeys.userId,
      set: { [field]: key },
    });

  return c.redirect("/settings?success=Key+saved");
});

// POST /settings/remove-key
settingsRouter.post("/settings/remove-key", async (c) => {
  const user = c.get("user");
  const body = await c.req.parseBody();
  const provider = body["provider"] as string;

  const fieldMap: Record<string, Record<string, null>> = {
    openai: { openaiApiKey: null },
    anthropic: { anthropicApiKey: null },
    google: { googleApiKey: null },
    xai: { xaiApiKey: null },
    kimi: { kimiApiKey: null },
    deepseek: { deepseekApiKey: null },
  };
  const updateFields = fieldMap[provider];
  if (!updateFields) return c.redirect("/settings?error=Unknown+provider");

  await db.update(llmApiKeys).set(updateFields as any).where(eq(llmApiKeys.userId, user.id));
  return c.redirect("/settings?success=Key+removed");
});

// POST /settings/toggle-byok
settingsRouter.post("/settings/toggle-byok", async (c) => {
  const user = c.get("user");
  const body = await c.req.parseBody();
  const enabled = body["enabled"] === "on";

  await db
    .insert(llmApiKeys)
    .values({ userId: user.id, usePersonalLlmKeys: enabled })
    .onConflictDoUpdate({
      target: llmApiKeys.userId,
      set: { usePersonalLlmKeys: enabled },
    });

  return c.redirect("/settings");
});

// POST /settings/claude-code/generate-key
// Generate (or regenerate) the CLI API key used by Claude Code callbacks
settingsRouter.post("/settings/claude-code/generate-key", async (c) => {
  const user = c.get("user");
  const newKey = `lfg_cli_${crypto.randomUUID().replace(/-/g, "")}`;
  await db
    .insert(profiles)
    .values({ userId: user.id, cliApiKey: newKey })
    .onConflictDoUpdate({ target: profiles.userId, set: { cliApiKey: newKey, updatedAt: new Date() } });
  return c.redirect("/settings/integrations?success=CLI+API+key+generated");
});

// POST /settings/claude-code/disconnect
settingsRouter.post("/settings/claude-code/disconnect", async (c) => {
  const user = c.get("user");
  await db
    .update(profiles)
    .set({
      claudeCodeAuthenticated: false,
      claudeCodeCredentials: null,
      claudeCodeCredentialsUpdatedAt: null,
      cliApiKey: null,
      updatedAt: new Date(),
    })
    .where(eq(profiles.userId, user.id));
  return c.redirect("/settings/integrations?success=Claude+Code+disconnected");
});

// GET /settings/integrations — Integrations section (Claude Code + GitHub + Telegram + Composio)
settingsRouter.get("/settings/integrations", async (c) => {
  const user = c.get("user");
  const [keys, profile, ghToken, tgBot, userToolkits] = await Promise.all([
    getOrCreateApiKeys(user.id),
    getProfile(user.id),
    getGithubToken(user.id),
    getTelegramBot(user.id),
    db.select().from(composioToolkits).where(eq(composioToolkits.userId, user.id)),
  ]);
  const url = new URL(c.req.url);
  const error = url.searchParams.get("error") ?? undefined;
  const success = url.searchParams.get("success") ?? undefined;
  return c.html(
    SettingsPage({
      user: { id: user.id, name: user.name, email: user.email },
      apiKeys: {
        openai: !!keys.openaiApiKey,
        anthropic: !!keys.anthropicApiKey,
        google: !!keys.googleApiKey,
        xai: !!keys.xaiApiKey,
        kimi: !!keys.kimiApiKey,
        deepseek: !!keys.deepseekApiKey,
        usePersonalKeys: keys.usePersonalLlmKeys,
      },
      claudeCode: {
        authenticated: profile.claudeCodeAuthenticated,
        hasCredentials: !!profile.claudeCodeCredentials,
        cliApiKey: profile.cliApiKey ?? null,
      },
      github: {
        connected: !!ghToken,
        username: ghToken?.githubUsername ?? null,
        avatarUrl: ghToken?.githubAvatarUrl ?? null,
      },
      telegram: {
        connected: !!tgBot,
        botUsername: tgBot?.botUsername ?? null,
        enabled: tgBot?.enabled ?? false,
        active: isBotActive(user.id),
      },
      composio: {
        configured: isComposioConfigured(),
        toolkits: userToolkits.map((t) => ({
          id: t.id,
          toolkit: t.toolkit,
          enabled: t.enabled,
        })),
      },
      activeSection: "integrations",
      error,
      success,
    })
  );
});

// ── GitHub OAuth (manual flow matching Django's /accounts/github-callback/) ──

// GET /accounts/github-connect/ — initiate OAuth
settingsRouter.get("/accounts/github-connect", async (c) => {
  const clientId = env.GITHUB_CLIENT_ID;
  if (!clientId) return c.redirect("/settings/integrations?error=GitHub+OAuth+not+configured");

  // Generate state for CSRF protection
  const state = crypto.randomUUID();
  // Store state in a cookie (HttpOnly, short-lived)
  c.header(
    "Set-Cookie",
    `github_oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`
  );

  const baseUrl = env.BETTER_AUTH_URL; // e.g. http://localhost:8000
  const redirectUri = `${baseUrl}/accounts/github-callback`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "repo user",
    state,
  });

  return c.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
});

// GET /accounts/github-callback — OAuth callback
settingsRouter.get("/accounts/github-callback", async (c) => {
  const user = c.get("user");
  const code = c.req.query("code");
  const state = c.req.query("state");

  // Verify state from cookie
  const cookieHeader = c.req.header("Cookie") ?? "";
  const stateMatch = cookieHeader.match(/github_oauth_state=([^;]+)/);
  const storedState = stateMatch?.[1];

  if (!code) return c.redirect("/settings/integrations?error=No+code+from+GitHub");
  if (!state || state !== storedState) {
    return c.redirect("/settings/integrations?error=Invalid+OAuth+state");
  }

  // Clear the state cookie
  c.header(
    "Set-Cookie",
    `github_oauth_state=; Path=/; HttpOnly; Max-Age=0`
  );

  const clientId = env.GITHUB_CLIENT_ID;
  const clientSecret = env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return c.redirect("/settings/integrations?error=GitHub+OAuth+not+configured");
  }

  const baseUrl = env.BETTER_AUTH_URL;
  const redirectUri = `${baseUrl}/accounts/github-callback`;

  try {
    // Exchange code for access token
    const tokenResp = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });

    const tokenData = (await tokenResp.json()) as {
      access_token?: string;
      scope?: string;
      error?: string;
      error_description?: string;
    };

    if (!tokenData.access_token) {
      console.error("[github-oauth] Token exchange failed:", tokenData);
      return c.redirect(
        `/settings/integrations?error=${encodeURIComponent(tokenData.error_description ?? tokenData.error ?? "Token exchange failed")}`
      );
    }

    const accessToken = tokenData.access_token;
    const scope = tokenData.scope ?? "";

    // Fetch GitHub user info
    const userResp = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
      },
    });

    const ghUser = (await userResp.json()) as {
      id?: number;
      login?: string;
      avatar_url?: string;
    };

    // Upsert into githubTokens
    const existing = await db
      .select()
      .from(githubTokens)
      .where(eq(githubTokens.userId, user.id))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(githubTokens)
        .set({
          accessToken,
          githubUserId: String(ghUser.id ?? ""),
          githubUsername: ghUser.login ?? null,
          githubAvatarUrl: ghUser.avatar_url ?? null,
          scope,
          updatedAt: new Date(),
        })
        .where(eq(githubTokens.userId, user.id));
    } else {
      await db.insert(githubTokens).values({
        userId: user.id,
        accessToken,
        githubUserId: String(ghUser.id ?? ""),
        githubUsername: ghUser.login ?? null,
        githubAvatarUrl: ghUser.avatar_url ?? null,
        scope,
      });
    }

    console.log(`[github-oauth] Connected GitHub for user ${user.id}: @${ghUser.login}`);
    return c.redirect("/settings/integrations?success=GitHub+connected");
  } catch (err) {
    console.error("[github-oauth] Callback error:", err);
    return c.redirect(`/settings/integrations?error=${encodeURIComponent(String(err))}`);
  }
});

// POST /settings/github/disconnect — Remove GitHub token
settingsRouter.post("/settings/github/disconnect", async (c) => {
  const user = c.get("user");
  await db.delete(githubTokens).where(eq(githubTokens.userId, user.id));
  return c.redirect("/settings/integrations?success=GitHub+disconnected");
});

export default settingsRouter;
