import { tool, zodSchema } from "ai";
import { z } from "zod";
import {
  askInstantSandboxQuestion,
  createOrContinueInstantApp,
  proposePlan,
  proposeInstantDesign,
  retryInstantBuild,
  exportInstantAppToGitHub,
  getInstantAppStatus,
  provisionInstantAppDatabase,
  requestInstantEnvVariable,
  swapInstantAppTheme,
  runInstantAppQA,
} from "../../services/instant-app.ts";
import { askUser } from "./misc-tools.ts";

export interface InstantToolContext {
  userId: string;
  conversationId: string;
  projectId?: string;
  /** The model selected in the composer — decides the build backend. */
  modelKey?: string;
}

export function createInstantTools(ctx: InstantToolContext) {
  return {
    propose_plan: tool({
      description:
        "STEP 1 of approval. Present the PLAN ONLY (product summary + sections/features + stack) as an approval card — NO colors/design here. Call this right after the user answers your questions. WAIT for the user to approve the plan (they click 'Approve plan' or reply) before calling propose_design. If the user requests changes, call propose_plan AGAIN with the revised summary/sections and a short `change_note` describing what changed (it's shown in the plan's change log).",
      inputSchema: zodSchema(
        z.object({
          name: z.string().describe("Short app name in kebab-case"),
          requirements: z.string().describe("Detailed requirements doc with features/data/pages/UI"),
          project_type: z.enum(["webapp", "landing", "game"]).optional(),
          summary: z.string().describe("Two or three sentences: the product + its architecture/stack"),
          sections: z
            .array(z.object({ title: z.string(), description: z.string() }))
            .min(2)
            .max(8)
            .describe("The key sections / features / architecture pieces, each a short title + description"),
          change_note: z
            .string()
            .optional()
            .describe("When RE-proposing after the user asked for changes, a one-line note of what changed (added to the change log). Omit on the first proposal."),
        })
      ),
      execute: async ({ name, requirements, project_type, summary, sections, change_note }) => {
        const result = await proposePlan({
          userId: ctx.userId,
          projectId: ctx.projectId,
          conversationId: ctx.conversationId,
          name,
          requirements,
          projectType: project_type,
          summary,
          sections,
          changeNote: change_note,
        });
        return {
          message_to_agent: `Plan for ${result.appName} (${result.projectType}) is shown to the user as an approval card with its own buttons. Your turn is OVER — reply with NO text. When the user approves the plan, call propose_design (the design/colors step). If they ask for plan changes, call propose_plan again with the revisions + a change_note.`,
        };
      },
    }),

    propose_design: tool({
      description:
        "STEP 2 of approval (call ONLY after the user approved the plan via propose_plan). Present the DESIGN ONLY — color palette (swatches), fonts, and style — as an approval card. WAIT for the user to approve the design before calling create_instant_app. Pass the SAME name/requirements/project_type as the plan, plus your chosen design ids.",
      inputSchema: zodSchema(
        z.object({
          name: z.string().describe("Short app name in kebab-case"),
          requirements: z.string().describe("Detailed requirements doc with features/data/pages/UI"),
          project_type: z.enum(["webapp", "landing", "game"]).optional(),
          brightness: z
            .enum(["light", "dark"])
            .optional()
            .describe(
              "The user's light/dark preference — a HARD constraint. Set 'light' if they want a light/bright UI, 'dark' for a dark UI. Always set this to match what the user said; the palette is then guaranteed to match (a 'light' request can never yield a dark palette). Omit only if the user expressed no preference."
            ),
          palette_id: z
            .string()
            .optional()
            .describe("Preferred palette id (a HINT). It's honored only if it fits `brightness`; otherwise a matching-brightness palette is chosen for you."),
          font_pairing_id: z.string().optional(),
          style_profile_id: z.string().optional(),
          design_change: z
            .boolean()
            .optional()
            .default(false)
            .describe(
              "Set TRUE only when the user EXPLICITLY asked to change the app's existing look/theme/colors/fonts/style. For a NEW app, or when ADDING a page/feature to an existing app, leave FALSE (default) — the app's current design is reused so the whole app isn't accidentally restyled. If you're unsure whether the user wants a design change, ASK them instead of guessing."
            ),
        })
      ),
      execute: async ({ name, requirements, project_type, brightness, palette_id, font_pairing_id, style_profile_id, design_change }) => {
        const result = await proposeInstantDesign({
          userId: ctx.userId,
          projectId: ctx.projectId,
          conversationId: ctx.conversationId,
          name,
          requirements,
          projectType: project_type,
          designChange: design_change,
          brightness,
          designChoices: (palette_id || font_pairing_id || style_profile_id)
            ? { paletteId: palette_id, fontPairingId: font_pairing_id, styleProfileId: style_profile_id }
            : undefined,
        });
        return {
          message_to_agent: `Design proposal for ${result.appName} (${result.projectType}, palette: ${result.palette}) is now shown to the user as an approval card WITH its own Approve & build / Request changes buttons. Your turn is OVER — reply with NO text at all (no summary, no "here's what I'll build", no "approve to start", no recap of features/design). Any text you add here is duplicate noise next to the card. Just stop. Later: when the user approves, call create_instant_app with the same details; if they ask for changes, call propose_design again.`,
        };
      },
    }),

    create_instant_app: tool({
      description:
        "Create a new instant app once requirements are clear. This provisions a sandbox, builds the app with Claude CLI over Mags, and starts the server. You MUST pick a palette_id, font_pairing_id, and style_profile_id that best match the app's purpose and vibe.",
      inputSchema: zodSchema(
        z.object({
          name: z.string().describe("Short app name in kebab-case"),
          requirements: z.string().describe("Detailed requirements doc with features/data/pages/UI"),
          project_type: z
            .enum(["webapp", "landing", "game"])
            .optional()
            .describe(
              "The kind of project, which selects the build stack: 'webapp' (default) for full-stack apps/dashboards/tools (Next.js + shadcn + SQLite); 'landing' for marketing/landing pages (Next.js + framer-motion, design-heavy); 'game' for browser games (Vite + three.js). Choose based on what the user is building."
            ),
          env_vars: z.record(z.string(), z.string()).optional(),
          palette_id: z.string().optional().describe("Design palette ID. Options: midnight-indigo (dark/tech/professional), forest-emerald (natural/health/calm), sunset-amber (warm/energetic/creative), ocean-cyan (fresh/trustworthy/clean), rose-blush (elegant/feminine/luxury), slate-minimal (clean/professional/neutral), violet-dream (creative/vibrant/playful), sand-earth (warm/rustic/organic), neon-dark (bold/futuristic/gaming), coral-light (friendly/warm/approachable)"),
          font_pairing_id: z.string().optional().describe("Font pairing ID. Options: inter-system (clean/modern), space-grotesk-inter (tech/bold), playfair-lato (elegant/editorial), dm-sans-mono (friendly/clean), sora-outfit (playful/creative), cabinet-general (bold/startup), merriweather-source (editorial/warm), geist-mono (tech/minimal)"),
          style_profile_id: z.string().optional().describe("Style profile ID. Options: sharp (professional/minimal), soft (friendly/modern), rounded (playful/fun), brutalist (edgy/bold), glass (elegant/futuristic)"),
          design_change: z
            .boolean()
            .optional()
            .default(false)
            .describe(
              "Set TRUE only when the user EXPLICITLY asked to change the app's existing look/theme/colors/fonts/style. For a NEW app, or when ADDING a page/feature to an existing app, leave FALSE (default) — the app's current design is reused so the whole app isn't accidentally restyled."
            ),
        })
      ),
      execute: async ({ name, requirements, project_type, env_vars, palette_id, font_pairing_id, style_profile_id, design_change }) => {
        const result = await createOrContinueInstantApp({
          userId: ctx.userId,
          projectId: ctx.projectId,
          conversationId: ctx.conversationId,
          name,
          requirements,
          envVars: env_vars,
          buildModelKey: ctx.modelKey,
          projectType: project_type,
          designChange: design_change,
          designChoices: (palette_id || font_pairing_id || style_profile_id)
            ? { paletteId: palette_id, fontPairingId: font_pairing_id, styleProfileId: style_profile_id }
            : undefined,
        });

        return {
          message_to_agent: result.continued
            ? `Sending your changes to the running app ${result.appName}.`
            : `Provisioning workspace and building ${result.appName}.`,
          data: {
            app_id: result.appId,
            app_name: result.appName,
            status: result.status,
          },
        };
      },
    }),

    retry_build: tool({
      description:
        "Retry/rebuild the existing app for this conversation using its ALREADY-SAVED requirements and design. Use this whenever a build fails, the sandbox is in a bad state, or the user says 'retry' / 'continue' / 'try again'. The full plan is persisted server-side — do NOT re-ask the user what to build or re-describe the app. Takes no arguments.",
      inputSchema: zodSchema(z.object({})),
      execute: async () => {
        const result = await retryInstantBuild({
          userId: ctx.userId,
          conversationId: ctx.conversationId,
          modelKey: ctx.modelKey,
        });
        return result.started
          ? { message_to_agent: `Rebuilding ${result.appName} from its saved requirements${result.reason ? ` (${result.reason})` : ""}. Tell the user it's retrying — do NOT ask them to re-describe the app.` }
          : { message_to_agent: result.reason ?? "Could not retry." };
      },
    }),

    test_app: tool({
      description:
        "Run automated QA on the running app for this conversation. It visits every screen in a real cloud browser, screenshots each, and reports PASS/FAIL with observations (HTTP status, page heading, blank-vs-rendered, JS/console errors). Call this whenever the user asks to test / QA / check / verify the app. Results (screenshots + per-screen PASS/FAIL) stream into the chat on their own — do NOT describe or list them yourself. Takes no arguments.",
      inputSchema: zodSchema(z.object({})),
      execute: async () => {
        const result = await runInstantAppQA({ userId: ctx.userId, conversationId: ctx.conversationId });
        return result.started
          ? { message_to_agent: `QA started for ${result.appName}. A results card (screenshots + PASS/FAIL per screen) streams into the chat on its own. Reply with ONE short line like "Running QA — results will appear below." and do NOT list results yourself.` }
          : { message_to_agent: `Could not start QA: ${result.reason}.` };
      },
    }),

    get_instant_app_status: tool({
      description:
        "Get the current status and preview URL of the instant app for this conversation. Use this whenever the user asks for a URL or reports preview issues.",
      inputSchema: zodSchema(
        z.object({
          restart_server: z.boolean().optional().default(false),
        })
      ),
      execute: async ({ restart_server }) => {
        const status = await getInstantAppStatus({
          userId: ctx.userId,
          conversationId: ctx.conversationId,
          restartServer: restart_server,
        });

        if (!status) {
          return {
            message_to_agent:
              "No instant app exists for this conversation yet. Ask the user what they want to build and call create_instant_app.",
          };
        }

        return {
          message_to_agent: `App ${status.appName} status: ${status.status}. Preview URL: ${status.previewUrl || "(not available yet)"}`,
          data: {
            app_name: status.appName,
            status: status.status,
            preview_url: status.previewUrl,
          },
        };
      },
    }),

    request_env_variable: tool({
      description:
        "Request a required environment variable from the user. This sends a structured prompt to the instant chat UI.",
      inputSchema: zodSchema(
        z.object({
          key: z.string(),
          description: z.string(),
          required: z.boolean().optional().default(true),
        })
      ),
      execute: async ({ key, description, required }) => {
        const result = await requestInstantEnvVariable({
          userId: ctx.userId,
          conversationId: ctx.conversationId,
          key,
          description,
          required,
        });
        return result.sent
          ? { message_to_agent: `Requested ${key} from the user.` }
          : { message_to_agent: `Could not request ${key}: ${result.reason}` };
      },
    }),

    ask_sandbox: tool({
      description:
        "Ask a question about the current sandbox environment for debugging or project inspection.",
      inputSchema: zodSchema(
        z.object({
          question: z.string(),
        })
      ),
      execute: async ({ question }) => {
        const result = await askInstantSandboxQuestion({
          userId: ctx.userId,
          conversationId: ctx.conversationId,
          question,
        });
        return {
          message_to_agent: result.answer,
        };
      },
    }),

    export_to_github: tool({
      description:
        "Export the instant app's code to a GitHub repository. Use when the user wants to save their code to GitHub. Requires GitHub to be connected in Settings.",
      inputSchema: zodSchema(
        z.object({
          app_id: z.string().describe("The public app_id of the instant app to export"),
          repo_name: z.string().optional().describe("Custom repository name. Auto-generated from app name if omitted."),
          is_private: z.boolean().optional().default(true).describe("Whether the repo should be private"),
        })
      ),
      execute: async ({ app_id, repo_name, is_private }) => {
        const result = await exportInstantAppToGitHub({
          userId: ctx.userId,
          appId: app_id,
          repoName: repo_name,
          isPrivate: is_private,
        });
        return {
          message_to_agent: result.message,
          data: result.success
            ? { repo_url: result.repoUrl, commit_sha: result.commitSha }
            : undefined,
        };
      },
    }),

    askUser,

    swap_theme: tool({
      description:
        "Swap the design theme of the running instant app. You can change the color palette, font pairing, and/or style profile. After swapping, tell the user to apply changes by asking for a rebuild. Available palettes: midnight-indigo, forest-emerald, sunset-amber, ocean-cyan, rose-blush, slate-minimal, violet-dream, sand-earth, neon-dark, coral-light. Font pairings: inter-system, space-grotesk-inter, playfair-lato, dm-sans-mono, sora-outfit, cabinet-general, merriweather-source, geist-mono. Style profiles: sharp, soft, rounded, brutalist, glass.",
      inputSchema: zodSchema(
        z.object({
          palette_id: z.string().optional().describe("Color palette ID to switch to"),
          font_pairing_id: z.string().optional().describe("Font pairing ID to switch to"),
          style_profile_id: z.string().optional().describe("Style profile ID to switch to"),
        })
      ),
      execute: async ({ palette_id, font_pairing_id, style_profile_id }) => {
        const result = await swapInstantAppTheme({
          userId: ctx.userId,
          conversationId: ctx.conversationId,
          paletteId: palette_id,
          fontPairingId: font_pairing_id,
          styleProfileId: style_profile_id,
        });

        if (!result.success) {
          return { message_to_agent: result.message };
        }

        return {
          message_to_agent: `${result.message} Call create_instant_app with the same app name and a requirement like "Apply the new design tokens from /data/project/design-tokens.css — update globals.css and rebuild" to apply the changes.`,
          data: {
            palette: result.tokens?.meta.paletteName,
            fonts: result.tokens?.meta.fontPairingName,
            style: result.tokens?.meta.styleProfileName,
          },
        };
      },
    }),

    provision_database: tool({
      description:
        "Provision a PostgreSQL database for the instant app and automatically add DATABASE_URL to the app's environment variables. Use when the user needs a real database instead of SQLite.",
      inputSchema: zodSchema(
        z.object({
          app_id: z.string().describe("The public app_id of the instant app"),
        })
      ),
      execute: async ({ app_id }) => {
        const result = await provisionInstantAppDatabase({
          userId: ctx.userId,
          appId: app_id,
        });
        return {
          message_to_agent: result.message,
          data: result.success
            ? { db_name: result.dbName, connection_string: result.connectionString }
            : undefined,
        };
      },
    }),

  };
}
