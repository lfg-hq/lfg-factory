/**
 * Build profiles — per project-type scaffold + prompt + serve command.
 *
 * The Instant pipeline used to hard-code a single Next.js + shadcn + drizzle stack
 * and one "full-stack web app" prompt. That's wrong for games and weak for
 * marketing pages. A BuildProfile encapsulates the three things that must vary by
 * project type: how the sandbox is scaffolded, how the coding agent is prompted,
 * and how the dev server is (re)started.
 *
 * Profiles:
 *  - webapp  (default) — Next.js + shadcn/ui + drizzle/SQLite. Ported verbatim.
 *  - landing — Next.js + shadcn/ui + framer-motion, marketing-section prompt.
 *  - game    — Vite + TypeScript + three.js, game-loop prompt, no shadcn/DB.
 *  - python  — Flask + Jinja templates + stdlib sqlite3, single-process HTML app.
 *
 * SINGLE-STACK RULE: a build VM exposes exactly ONE url/port (8080) served by ONE
 * process. A profile is therefore a single stack end-to-end — never a JS frontend
 * paired with a separate Python backend. "python" means the WHOLE app is Python
 * (server-rendered HTML), not a Python API bolted onto Next.js.
 */

import type { DesignTokens } from "../config/design-tokens/index.ts";

export type ProjectType = "webapp" | "landing" | "game" | "python";

export interface ScaffoldStep {
  message: string; // broadcast to the user while it runs
  script: string; // shell script (run via execOnWorkspace)
  /**
   * Run this step DETACHED + polled instead of one blocking exec. Set for steps
   * that can stay silent >100s (big pip/apt installs) — a single long-held HTTP
   * request is killed by Cloudflare with `error code: 524` before it finishes.
   */
  slow?: boolean;
}

export interface BuildPromptParams {
  appName: string;
  requirements: string;
  feedback?: string;
  shouldContinue: boolean;
  tokens: DesignTokens;
  specSection: string;
  apiKeySection: string;
}

export interface BuildProfile {
  type: ProjectType;
  /** Command baked into the VM to auto-restart the dev server on wake-from-sleep. */
  startupCommand: string;
  /** Scaffold steps run once on a new build (create-next-app / vite, deps, etc.). */
  scaffoldSteps: ScaffoldStep[];
  /** Project-relative global stylesheet to append design-tokens.css to (post-scaffold).
   *  Null for stacks without one (e.g. the Vite/three.js game). */
  globalCssPath?: string;
  /** Build the agent prompt for a new build or a change request. */
  buildPrompt: (p: BuildPromptParams) => string;
}

const PATH_PREAMBLE = "export PATH=/root/node/current/bin:/root/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH";

// Scaffold env: use a clean writable npm cache (the rootfs's /root/.npm can be in a
// corrupted state → EEXIST/ENOTDIR install failures) and force legacy peer-dep
// resolution (next/react peer mismatches otherwise abort install with ERESOLVE).
const SCAFFOLD_ENV = [
  PATH_PREAMBLE,
  'export NODE_OPTIONS="--max-old-space-size=1536"',
  // npm cache on /data (big disk), not /tmp (root, 1.9GB) — avoids ENOSPC on install.
  "export npm_config_cache=/data/.npm-cache",
  "export npm_config_legacy_peer_deps=true",
  "mkdir -p /data/.npm-cache",
].join("\n");

// ── Project-type detection ────────────────────────────────────────────────

const GAME_RE =
  /\b(game|gameplay|three\.?js|3d|webgl|player|level|score|physics|shooter|platformer|puzzle|arcade|maze|enemy|sprite|fps|rpg|tower defense|endless runner)\b/i;
const LANDING_RE =
  /\b(landing page|landing site|marketing site|marketing page|home ?page|hero section|waitlist|coming soon|splash page|product page|one[- ]pager|brand site)\b/i;
// Python is chosen when the app's CORE work needs the Python ecosystem (data/ML/
// scientific/document libs, or an explicit Python framework). Kept conservative so a
// generic "dashboard" or "tool" still defaults to the Next.js webapp stack — the
// orchestrator's explicit project_type is the primary signal; this is the fallback.
const PYTHON_RE =
  /\b(python|flask|django|fastapi|streamlit|gradio|jupyter|notebook|pandas|numpy|scikit[- ]?learn|sklearn|scipy|pytorch|tensorflow|keras|matplotlib|seaborn|plotly|opencv|spacy|nltk|transformers|docling|pypdf|pdfplumber|beautifulsoup|scrapy|selenium|sqlalchemy)\b/i;

/**
 * Resolve the project type. An explicit value (from the orchestrator's
 * `project_type` param or persisted metadata) always wins; otherwise fall back
 * to a keyword heuristic over the requirements.
 */
export function detectProjectType(requirements: string, explicit?: string | null): ProjectType {
  if (explicit === "webapp" || explicit === "landing" || explicit === "game" || explicit === "python") return explicit;
  const r = requirements || "";
  if (GAME_RE.test(r)) return "game";
  if (LANDING_RE.test(r)) return "landing";
  if (PYTHON_RE.test(r)) return "python";
  return "webapp";
}

// ── Shared prompt fragments ───────────────────────────────────────────────

// Only the essentials. The 20 @radix-ui/* packages were redundant — `shadcn add`
// pulls the exact Radix dep each component needs, so pre-installing all of them
// just doubled node_modules and (with the npm cache) blew the 2GB disk → ENOSPC.
const BASE_WEB_DEPS =
  "drizzle-orm better-sqlite3 clsx tailwind-merge class-variance-authority lucide-react tw-animate-css";

function nextDesignSection(tokens: DesignTokens): string {
  return `
## Design System — Curated Token Set
You have a pre-built design token system. Two files are already in /data/project:
- \`tokens.json\` — full design token values (colors, typography, style)
- \`design-tokens.css\` — CSS custom properties ready for shadcn/ui

### Palette: ${tokens.meta.paletteName} | Fonts: ${tokens.meta.fontPairingName} | Style: ${tokens.meta.styleProfileName}
Key values for quick reference:
- Primary: ${tokens.colors.primary} | Background: ${tokens.colors.background} | Text: ${tokens.colors.text}
- Heading font: ${tokens.typography.headingFont} | Body font: ${tokens.typography.bodyFont}
- Border radius: ${tokens.style.borderRadius.default} | Transition: ${tokens.style.transitionSpeed}

### Setup Steps (design tokens CSS is ALREADY in globals.css — do NOT cat design-tokens.css again)
1. Import Google Fonts in layout.tsx using next/font/google:
   \`\`\`typescript
   import { ${tokens.typography.headingFont.replace(/\s+/g, "_")} } from 'next/font/google'
   ${tokens.typography.headingFont !== tokens.typography.bodyFont ? `import { ${tokens.typography.bodyFont.replace(/\s+/g, "_")} } from 'next/font/google'` : ""}
   \`\`\`
   Apply the fonts to the html element className.
3. Use the CSS custom properties from design-tokens.css. shadcn/ui components will
   automatically pick up --primary, --background, --border, etc. The tokens override
   the default shadcn theme.
4. For custom components, use the CSS variables: \`hsl(var(--primary))\`, \`hsl(var(--background))\`, etc.
5. DO NOT invent your own colors. Always reference the token values or CSS variables.

### Mandatory Design Rules
- EVERY interactive element (buttons, links, cards, inputs) MUST have hover
  and focus states with smooth transitions (transition-all duration-${tokens.style.transitionSpeed.replace("ms", "")}).
- Use at least 3 levels of typographic hierarchy. Use font-heading for headings, font-body for body text.
- Card shadows: use var(--shadow-sm) for subtle, var(--shadow-md) for elevated, var(--shadow-lg) for prominent.
- Apply generous whitespace. When in doubt, increase padding and gaps.
- Include micro-interactions: button hover scale (hover:scale-[${tokens.style.hoverScale}]),
  card hover lift (hover:translate-y-[${tokens.style.hoverLift}] hover:shadow-lg), smooth transitions.
- Navigation should feel premium — sticky positioning, active state indicators, proper spacing.
- Empty states should never be blank. Add helpful text or CTAs.
- Loading states should use skeleton screens, not just spinners.
`;
}

const NEXT_MEMORY_RULES = `
## CRITICAL: Memory Management (OOM Prevention)
This sandbox has LIMITED memory (~2GB). Builds WILL get OOM-killed if you are not careful.

### Before EVERY \`npm run build\`:
1. Kill ALL running Node processes first:
   pkill -9 -f "next" 2>/dev/null; pkill -9 -f "node" 2>/dev/null; sleep 1
2. Clear the Next.js cache:
   rm -rf /data/project/.next
3. Set Node memory limit:
   export NODE_OPTIONS="--max-old-space-size=1536"
4. THEN run the build:
   npm run build 2>&1

### The FULL build+start sequence (use this EVERY time):
\`\`\`bash
pkill -9 -f "next" 2>/dev/null; pkill -9 -f "node" 2>/dev/null; sleep 1
rm -rf .next
export NODE_OPTIONS="--max-old-space-size=1536"
npm run build 2>&1 && nohup npm start -- -H 0.0.0.0 -p 8080 > dev.log 2>&1 &
\`\`\`

### If the build gets killed (OOM):
- Do NOT just retry the same command. You MUST kill processes and clear cache first.
- Do NOT run \`free -m\` or debug memory. Just follow the sequence above.
- Do NOT retry more than 2 times. If it still fails after 2 attempts with the full sequence, reduce the app complexity (fewer pages, simpler components).
`;

const VITE_MEMORY_RULES = `
## CRITICAL: Memory & Server Management
This sandbox has LIMITED memory (~2GB). Use the Vite dev server — no production build is
needed to preview the game.

### Start/restart sequence (use this EVERY time you (re)start the server):
\`\`\`bash
pkill -9 -f "vite" 2>/dev/null; pkill -9 -f "node" 2>/dev/null; sleep 1
export NODE_OPTIONS="--max-old-space-size=1536"
nohup npm run dev -- --host 0.0.0.0 --port 8080 > dev.log 2>&1 &
\`\`\`

- Vite serves on 0.0.0.0:8080. Do NOT change the port.
- If the server won't come up, check dev.log (tail -50 dev.log) for the real error.
`;

const NEXT_WEB_RULES = `## Rules
- The app MUST listen on 0.0.0.0:8080. MUST use nohup. Redirect output to dev.log.
- Do NOT create nested project directories.
- Do NOT use yarn or pnpm. Use npm only. Do NOT use sudo.
- Use apk (not apt/yum) for system packages.
- Do NOT use the TodoWrite tool. It wastes turns and provides no value.
- Do NOT run diagnostic commands (whoami, env, node -v, npm -v, ls node_modules, cat .npmrc).
  The environment is configured correctly.
- Do NOT manually write shadcn/ui component files. They are pre-installed in
  src/components/ui/. If one is missing, run: npx shadcn@latest add <name> -y
- MINIMIZE tool calls. Combine related file writes. Write multiple files in sequence
  without intermediate checks.
- If npm install fails, retry ONCE then move on. Do not debug npm.`;

// ── Next.js scaffold steps (shared by webapp + landing) ────────────────────

// The VM root disk is only ~1.9GB. The npm cache duplicates every downloaded
// tarball, so we purge it after each install step to stay under the limit (ENOSPC).
const PURGE_NPM_CACHE = "npm cache clean --force 2>/dev/null; rm -rf /data/.npm-cache/* 2>/dev/null; true";

function nextScaffoldSteps(extraDeps: string): ScaffoldStep[] {
  return [
    {
      message: "Setting up Next.js project...",
      script: `
${SCAFFOLD_ENV}
# The /data volume is mounted but the project subdir may not exist yet.
mkdir -p /data/project
cd /data/project

# 1. Scaffold Next.js
rm -rf /data/project/* /data/project/.* 2>/dev/null; true
npx create-next-app@latest /data/project --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm --yes 2>&1
${PURGE_NPM_CACHE}
`.trim(),
    },
    {
      message: "Installing dependencies...",
      script: `
${SCAFFOLD_ENV}
cd /data/project

# 2. Install core deps (Radix pulled per-component by shadcn below — not here).
npm install ${BASE_WEB_DEPS}${extraDeps ? " " + extraDeps : ""} 2>&1
npm install -D drizzle-kit @types/better-sqlite3 2>&1
${PURGE_NPM_CACHE}
`.trim(),
    },
    {
      message: "Initializing UI components...",
      script: `
${SCAFFOLD_ENV}
cd /data/project

# 3. Init shadcn + add components (pulls only the Radix deps each one needs).
# (design-tokens.css is injected + appended to globals.css AFTER scaffolding —
#  doing it here would be wiped by step 1's rm -rf.)
npx shadcn@latest init -y -d 2>&1
npx shadcn@latest add button card input label dialog dropdown-menu skeleton tabs toast avatar badge separator sheet select textarea switch checkbox -y 2>&1
${PURGE_NPM_CACHE}
`.trim(),
    },
  ];
}

const NEXT_STARTUP_COMMAND =
  `cd /data/project && ${PATH_PREAMBLE} && if [ -f package.json ]; then nohup npm start -- -H 0.0.0.0 -p 8080 > dev.log 2>&1 & fi`;

// ── webapp profile (default — verbatim parity with the original pipeline) ──

const webappProfile: BuildProfile = {
  type: "webapp",
  startupCommand: NEXT_STARTUP_COMMAND,
  scaffoldSteps: nextScaffoldSteps(""),
  globalCssPath: "src/app/globals.css",
  buildPrompt({ appName, requirements, feedback, shouldContinue, tokens, specSection, apiKeySection }) {
    const designSystem = nextDesignSection(tokens);
    const selfReview = `
## Before you finish
Review every page you created. Ask yourself: does this look like a product
someone would pay for, or does it look like a tutorial project? If the latter,
add visual polish until it feels premium. Check: hover states, spacing
consistency, color usage, typography hierarchy, empty states, loading states.
`;

    if (shouldContinue) {
      return `The user wants changes to the running app.

## Feedback / New Requirements
${feedback}

## CRITICAL: Working Directory
- Your working directory is /data/project — ALL project files are here. NEVER cd elsewhere.

${specSection}
${designSystem}
${NEXT_MEMORY_RULES}

## Instructions
1. ${PATH_PREAMBLE}
2. Apply the requested changes to the project in /data/project
3. Build and restart using the FULL build+start sequence from the Memory Management section above.
4. Ensure the app is running on port 8080, bound to 0.0.0.0

## Rules
- Do NOT use the TodoWrite tool. It wastes turns and provides no value.
- Do NOT run diagnostic commands (whoami, env, node -v, npm -v, ls node_modules).
  The environment is configured correctly.
- Do NOT manually write shadcn/ui component files. If one is missing, run: npx shadcn@latest add <name> -y
- MINIMIZE tool calls. Combine related file writes. Write multiple files in sequence
  without intermediate checks.
- If npm install fails, retry ONCE then move on. Do not debug npm.

${selfReview}`;
    }

    return `You are building a full-stack web application inside a cloud sandbox.

## App: ${appName}

## Requirements
${requirements}

${specSection}
${designSystem}
${apiKeySection}
## CRITICAL: Working Directory
- Your CWD is /data/project — ALL work happens here. NEVER cd elsewhere.
- PATH, npm, and node are already configured. Do NOT debug or fix npm/node/PATH issues.
- npm cache is at /data/.npm-cache (writable). Do NOT change npm config.

${NEXT_MEMORY_RULES}

## Project Setup (ALREADY DONE — do NOT repeat)
The project is already scaffolded in /data/project with:
- Next.js + TypeScript + Tailwind CSS (via create-next-app)
- shadcn/ui initialized with common components (button, card, input, label, dialog,
  dropdown-menu, skeleton, tabs, toast, avatar, badge, separator, sheet, select, textarea, switch, checkbox)
- drizzle-orm + better-sqlite3 installed (+ drizzle-kit, @types/better-sqlite3 as devDeps)
- Radix UI primitives installed (dialog, dropdown-menu, navigation-menu, tabs, toast, avatar,
  separator, label, select, accordion, progress, tooltip, popover, checkbox, switch, radio-group)
- lucide-react, clsx, tailwind-merge, class-variance-authority, tw-animate-css installed
- Design tokens CSS already applied to globals.css
- Design token values available in /data/project/tokens.json

DO NOT run create-next-app, npm init, shadcn init, or reinstall existing packages.
If you need additional shadcn components, run: npx shadcn@latest add <component> -y
If you need additional npm packages, install them with: npm install <package>

## Your Task
1. ${PATH_PREAMBLE}
2. Implement ALL requirements — pages, API routes, database schema, UI components.
   Stay in /data/project. Write files directly, do not create subdirectories for the project itself.
   Use the installed shadcn/ui components — do NOT write raw HTML when a component exists.
3. Write a proper README.md (overwrite the default): app name, one-line description, the
   feature list, the tech stack (Next.js, shadcn/ui, SQLite via drizzle), how to run
   (npm install, npm run dev), and any env vars the app needs. NOT a generic placeholder.
4. Build and start using the FULL build+start sequence from the Memory Management section above.
5. Verify: sleep 3 && curl -s http://localhost:8080/ || true

${NEXT_WEB_RULES}

${selfReview}`;
  },
};

// ── landing profile (Next.js + framer-motion, marketing-section prompt) ────

const landingProfile: BuildProfile = {
  type: "landing",
  startupCommand: NEXT_STARTUP_COMMAND,
  scaffoldSteps: nextScaffoldSteps("framer-motion"),
  globalCssPath: "src/app/globals.css",
  buildPrompt({ appName, requirements, feedback, shouldContinue, tokens, specSection, apiKeySection }) {
    const designSystem = nextDesignSection(tokens);
    const marketingSections = `
## Build a beautiful marketing/landing page
Compose the page from clear, full-width SECTIONS (in roughly this order unless the
requirements say otherwise). Each section is a distinct component:
1. Sticky top nav — logo, anchor links, prominent CTA button. Glassy/blur on scroll.
2. Hero — bold oversized headline, supporting sub-headline, primary + secondary CTA,
   and a strong visual (gradient mesh, product mockup, or abstract shapes). Above the fold.
3. Social proof — logo strip or a one-line trusted-by / metric bar.
4. Features — a responsive grid of 3-6 value props, each with a lucide-react icon, title, copy.
5. How it works — 3-4 numbered steps or a visual flow.
6. Testimonials or stats — quote cards or big animated numbers.
7. Pricing — tiered cards with a highlighted "popular" plan (only if relevant).
8. FAQ — accordion (shadcn Accordion).
9. Final CTA banner — full-width, high-contrast, single clear action.
10. Footer — columns of links, socials, copyright.

## Motion (framer-motion is installed)
- Use \`motion\` + \`whileInView\` for scroll-reveal with subtle stagger on section entrances.
- Add tasteful hover/tap micro-interactions on cards and buttons.
- Keep it smooth and restrained — never janky or gratuitous.

## Craft bar
- Real, specific marketing copy — NEVER lorem ipsum or placeholder text.
- Mobile-first responsive; verify the layout at small widths.
- Strong type hierarchy, generous vertical rhythm, gradients/imagery, rounded cards, depth via shadow.
- This must look like a $10k agency landing page, not a dashboard.
`;
    const selfReview = `
## Before you finish
Look at the page as a skeptical visitor. Does the hero make you want to keep scrolling?
Is the copy specific and persuasive (not generic)? Are sections visually distinct with
clear rhythm? Do animations feel smooth? Is it flawless on mobile? Polish until it looks
like a premium, professionally designed marketing site.
`;

    if (shouldContinue) {
      return `The user wants changes to the running landing site.

## Feedback / New Requirements
${feedback}

## CRITICAL: Working Directory
- Your working directory is /data/project — ALL project files are here. NEVER cd elsewhere.

${specSection}
${designSystem}
${marketingSections}
${NEXT_MEMORY_RULES}

## Instructions
1. ${PATH_PREAMBLE}
2. Apply the requested changes in /data/project (framer-motion is available).
3. Build and restart using the FULL build+start sequence above.
4. Ensure the site is running on port 8080, bound to 0.0.0.0

${NEXT_WEB_RULES}

${selfReview}`;
    }

    return `You are building a polished MARKETING / LANDING website with Next.js + Tailwind + shadcn/ui + framer-motion inside a cloud sandbox.

## Site: ${appName}

## Requirements / Brand
${requirements}

${specSection}
${designSystem}
${marketingSections}
${apiKeySection}
## CRITICAL: Working Directory
- Your CWD is /data/project — ALL work happens here. NEVER cd elsewhere.
- PATH, npm, and node are already configured. Do NOT debug npm/node/PATH issues.

${NEXT_MEMORY_RULES}

## Project Setup (ALREADY DONE — do NOT repeat)
- Next.js + TypeScript + Tailwind CSS
- shadcn/ui initialized (button, card, accordion, tabs, dialog, etc.)
- framer-motion installed (import { motion } from "framer-motion")
- lucide-react icons installed
- Design tokens CSS already applied to globals.css; values in /data/project/tokens.json

DO NOT run create-next-app, npm init, or shadcn init. For more shadcn components: npx shadcn@latest add <component> -y

## Your Task
1. ${PATH_PREAMBLE}
2. Build the landing page as composable section components under src/. Use shadcn primitives
   (Accordion for FAQ, Button for CTAs) and framer-motion for scroll-reveal.
3. Write a proper README.md (overwrite the default): site name, description, sections, tech
   stack (Next.js, framer-motion), and how to run. NOT a generic placeholder.
4. Build and start using the FULL build+start sequence above.
5. Verify: sleep 3 && curl -s http://localhost:8080/ || true

${NEXT_WEB_RULES}

${selfReview}`;
  },
};

// ── game profile (Vite + TypeScript + three.js) ───────────────────────────

const gameProfile: BuildProfile = {
  type: "game",
  startupCommand:
    `cd /data/project && ${PATH_PREAMBLE} && if [ -f package.json ]; then nohup npm run dev -- --host 0.0.0.0 --port 8080 > dev.log 2>&1 & fi`,
  scaffoldSteps: [
    {
      message: "Setting up Vite + three.js project...",
      script: `
${SCAFFOLD_ENV}
mkdir -p /data/project
cd /data/project

# 1. Scaffold Vite (vanilla TypeScript)
rm -rf /data/project/* /data/project/.* 2>/dev/null; true
npm create vite@latest /data/project -- --template vanilla-ts 2>&1
npm install 2>&1
${PURGE_NPM_CACHE}
`.trim(),
    },
    {
      message: "Installing three.js...",
      script: `
${SCAFFOLD_ENV}
cd /data/project

# 2. Install three.js
npm install three 2>&1
npm install -D @types/three 2>&1
${PURGE_NPM_CACHE}
`.trim(),
    },
  ],
  buildPrompt({ appName, requirements, feedback, shouldContinue, tokens }) {
    const gameCraft = `
## Game craft bar
- Smooth game loop with requestAnimationFrame and delta-time movement (frame-rate independent).
- A three.js Scene, PerspectiveCamera, and WebGLRenderer appended to the page; canvas fills the viewport.
- Handle window resize (update camera aspect + renderer size). Handle keyboard/mouse/touch input.
- Lighting and materials that look good (ambient + directional, shadows where cheap). Add juice:
  easing, particles, screen shake, simple sound (Web Audio) if it fits.
- Clear game states: start screen → playing → game over, with score/HUD and a restart.
- HUD/menu styling can use the palette — Primary: ${tokens.colors.primary}, Background: ${tokens.colors.background}, Text: ${tokens.colors.text}.
- Target 60fps. Keep geometry/draw calls reasonable for a 2GB sandbox.
`;
    const rules = `## Rules
- The dev server MUST listen on 0.0.0.0:8080 via Vite. MUST use nohup. Redirect output to dev.log.
- This is a Vite + three.js project — NOT Next.js. There is NO shadcn, NO database, NO API routes.
- Entry point is index.html → src/main.ts. Write game code under src/.
- Do NOT use yarn or pnpm. Use npm only. Do NOT use sudo. Use apk for system packages.
- Do NOT use the TodoWrite tool. Do NOT run diagnostic commands (node -v, npm -v, ls node_modules).
- MINIMIZE tool calls. Combine related file writes.
- If npm install fails, retry ONCE then move on.`;

    if (shouldContinue) {
      return `The user wants changes to the running game.

## Feedback / New Requirements
${feedback}

## CRITICAL: Working Directory
- Your working directory is /data/project — ALL files are here. NEVER cd elsewhere.

${gameCraft}
${VITE_MEMORY_RULES}

## Instructions
1. ${PATH_PREAMBLE}
2. Apply the requested changes under src/ (three.js is installed).
3. Restart the dev server using the sequence above. Ensure it serves on 0.0.0.0:8080.

${rules}`;
    }

    return `You are building a browser GAME with Vite + TypeScript + three.js inside a cloud sandbox.

## Game: ${appName}

## Requirements
${requirements}

## CRITICAL: Working Directory
- Your CWD is /data/project — ALL work happens here. NEVER cd elsewhere.
- PATH, npm, and node are already configured. Do NOT debug npm/node/PATH issues.

${VITE_MEMORY_RULES}

## Project Setup (ALREADY DONE — do NOT repeat)
- Vite + TypeScript (vanilla-ts template) scaffolded in /data/project
- three (three.js) + @types/three installed
- Entry: index.html → src/main.ts

DO NOT run \`npm create vite\` or re-scaffold. To add a package: npm install <package>

${gameCraft}

## Your Task
1. ${PATH_PREAMBLE}
2. Implement the game under src/ — scene setup, render loop, camera, lighting, controls,
   game state, scoring, win/lose, and a HUD. Replace the Vite starter content.
3. Write a proper README.md: game name, how to play (controls), tech stack (Vite + three.js),
   and how to run (npm install, npm run dev). NOT a generic placeholder.
4. Start the dev server: nohup npm run dev -- --host 0.0.0.0 --port 8080 > dev.log 2>&1 &
5. Verify: sleep 3 && curl -s http://localhost:8080/ || true

${rules}`;
  },
};

// ── python profile (Flask + Jinja + stdlib sqlite3, single process) ────────
//
// ONE stack, ONE process, ONE port. Flask serves server-rendered Jinja templates
// (templates/) and static assets (static/) on 0.0.0.0:8080 — no Next.js, no node,
// no separate frontend. Persistence is Python's stdlib sqlite3 (no server, no extra
// install). Heavier libs (docling, pandas, etc.) are pip-installed by the agent into
// the venv as the app needs them.

const PYTHON_ENV = [
  // The venv's bin is first so `python`/`pip` resolve to the project interpreter.
  "export PATH=/data/project/.venv/bin:/usr/local/bin:/usr/bin:/bin:$PATH",
  // pip cache on /data (big disk), not root (~1.9GB) — avoids ENOSPC on install.
  "export PIP_CACHE_DIR=/data/.pip-cache",
  "mkdir -p /data/.pip-cache",
].join("\n");

const PYTHON_STARTUP_COMMAND =
  `cd /data/project && if [ -f app.py ] && [ -x .venv/bin/python ]; then fuser -k 8080/tcp 2>/dev/null; pkill -9 -f 'python.*app.py' 2>/dev/null; sleep 1; nohup .venv/bin/python app.py > dev.log 2>&1 & fi`;

const PYTHON_SERVER_RULES = `## Rules
- The app is a SINGLE Python (Flask) process. There is NO Next.js, NO node, NO separate
  frontend — Flask renders the HTML (Jinja templates in templates/) and serves static
  assets from static/. Everything runs in ONE process on ONE port.
- Flask MUST listen on 0.0.0.0:8080. Start it with nohup, redirecting output to dev.log:
  \`nohup .venv/bin/python app.py > dev.log 2>&1 &\`. app.py must end with
  \`app.run(host="0.0.0.0", port=8080)\`.
- Use the venv at /data/project/.venv. Install packages with \`.venv/bin/pip install <pkg>\`
  (never global pip). Install exactly what the requirements ask for; do NOT silently swap a
  requested library for a lighter substitute.
- **CPU-only torch is already pre-installed** in the venv. \`torch\` is a CPU build (no CUDA).
  When you \`pip install docling\` (or any ML lib), torch is ALREADY satisfied, so it will
  NOT re-download it. NEVER run \`pip install torch\` or \`pip install --upgrade torch\` — the
  default/CUDA wheel pulls ~4GB of useless nvidia_* packages that fail on this CPU sandbox
  and break the build. If you must install another torch-adjacent package, keep the CPU
  torch (the venv's pip.conf already points at the CPU index).
- For SYSTEM packages use \`apt-get install -y <pkg>\` on Debian (or \`apk add <pkg>\` on Alpine).
- Database: use Python's stdlib \`sqlite3\` with a file at /data/project/app.db. Do NOT use
  Postgres or any hosted DB. Create tables on startup if missing.
- Do NOT create nested project directories. Do NOT use sudo.
- Do NOT use the TodoWrite tool. Do NOT run diagnostic commands (python -V, pip -V, ls).
  The environment is configured correctly.
- MINIMIZE tool calls. Combine related file writes. If a pip install fails, retry ONCE
  (installing build deps if needed: \`apt-get install -y build-essential python3-dev\` on
  Debian, or \`apk add build-base python3-dev\` on Alpine).`;

const PYTHON_MEMORY_RULES = `## Server management
This sandbox has LIMITED memory (~2GB). Flask is light — no build step is needed.

### Start/restart sequence (use this EVERY time you (re)start the server):
\`\`\`bash
pkill -9 -f "app.py" 2>/dev/null; pkill -9 -f "flask" 2>/dev/null; sleep 1
cd /data/project
nohup .venv/bin/python app.py > dev.log 2>&1 &
\`\`\`
- The app serves on 0.0.0.0:8080. Do NOT change the port.
- If it won't come up, check dev.log (tail -50 dev.log) for the real error (usually a
  missing pip package or a Python traceback).`;

function pythonDesignSection(tokens: DesignTokens): string {
  const heading = tokens.typography.headingFont;
  const body = tokens.typography.bodyFont;
  const fontsParam = [heading, body]
    .filter((f, i, a) => a.indexOf(f) === i)
    .map((f) => `family=${f.replace(/\s+/g, "+")}:wght@400;500;600;700`)
    .join("&");
  return `
## Design System (authoritative: design-tokens.css)
The design tokens are already in /data/project as \`design-tokens.css\` (CSS custom
properties) and \`tokens.json\` (raw values). Wire them into the HTML:
1. Copy the stylesheet into static: \`cp design-tokens.css static/design-tokens.css\`.
2. In your base Jinja template's <head>, load the fonts and tokens:
   \`\`\`html
   <link rel="preconnect" href="https://fonts.googleapis.com">
   <link href="https://fonts.googleapis.com/css2?${fontsParam}&display=swap" rel="stylesheet">
   <link rel="stylesheet" href="{{ url_for('static', filename='design-tokens.css') }}">
   \`\`\`
3. Use the CSS variables for ALL colors/spacing: \`hsl(var(--primary))\`,
   \`hsl(var(--background))\`, \`hsl(var(--border))\`, etc. Do NOT invent colors.

### Palette: ${tokens.meta.paletteName} | Fonts: ${heading} / ${body} | Style: ${tokens.meta.styleProfileName}
- Primary: ${tokens.colors.primary} | Background: ${tokens.colors.background} | Text: ${tokens.colors.text}
- Heading font: ${heading} | Body font: ${body} | Border radius: ${tokens.style.borderRadius.default}

### Craft bar
- Every page must look like a polished product, not a Bootstrap default. Use generous
  whitespace, a clear typographic hierarchy, and the palette consistently.
- Interactive elements (buttons, links, inputs) get hover + focus states with smooth
  transitions. Cards get subtle shadows. Never leave an empty state blank — add a CTA.
- Ship plain, dependency-free CSS (you may add a little vanilla JS for interactivity).
  Do NOT pull in Tailwind, Bootstrap, or a JS framework — this is server-rendered HTML.
`;
}

const pythonProfile: BuildProfile = {
  type: "python",
  startupCommand: PYTHON_STARTUP_COMMAND,
  scaffoldSteps: [
    {
      message: "Setting up Python environment...",
      slow: true, // apt install python3-venv + pip upgrade can exceed the 524 window
      script: `
${PYTHON_ENV}
# Ensure python3 + pip + venv across BOTH bases: Mags 'python' type is Debian/glibc
# (apt, python usually preinstalled — Docling/torch install from manylinux wheels here),
# while pi/claude are Alpine/musl (apk). Use whichever package manager exists; no-op when
# the tools are already present.
PKG=""
command -v apt-get >/dev/null 2>&1 && PKG=apt
[ -z "$PKG" ] && command -v apk >/dev/null 2>&1 && PKG=apk
if ! command -v python3 >/dev/null 2>&1; then
  [ "$PKG" = apt ] && (apt-get update -y >/dev/null 2>&1; apt-get install -y python3 python3-venv python3-pip >/dev/null 2>&1)
  [ "$PKG" = apk ] && apk add --no-cache python3 py3-pip >/dev/null 2>&1
fi
# Debian ships venv as a SEPARATE package (python3-venv); install it if venv is missing.
if ! python3 -m venv --help >/dev/null 2>&1; then
  [ "$PKG" = apt ] && apt-get install -y python3-venv python3-pip >/dev/null 2>&1
  [ "$PKG" = apk ] && apk add --no-cache py3-pip >/dev/null 2>&1
fi
mkdir -p /data/project
cd /data/project
rm -rf /data/project/* /data/project/.venv 2>/dev/null; true

# Isolated venv (avoids PEP 668 "externally-managed-environment").
python3 -m venv /data/project/.venv 2>&1
/data/project/.venv/bin/pip install --upgrade pip 2>&1
`.trim(),
    },
    {
      message: "Installing Flask + CPU PyTorch (skips the 4GB CUDA download)...",
      slow: true, // ~200MB torch wheel — far exceeds Cloudflare's ~100s 524 window
      script: `
${PYTHON_ENV}
cd /data/project
PIP=/data/project/.venv/bin/pip
$PIP install flask 2>&1

# CRITICAL: pre-install CPU-ONLY torch. Docling (and most ML libs) depend on torch, and the
# DEFAULT torch wheel drags in ~4GB of NVIDIA CUDA packages (cublas 423MB, cudnn 366MB,
# nccl, triton, cusparselt…) that are USELESS on this CPU-only sandbox and fail flakily
# mid-download (killing the whole install). Installing the CPU build FIRST (~200MB, zero
# nvidia_* deps) means a later \`pip install docling\` finds torch already satisfied and
# skips the entire CUDA stack. Best-effort — a plain-Python app that never imports torch
# is unaffected (it's just a cached wheel).
$PIP install --index-url https://download.pytorch.org/whl/cpu torch 2>&1 || \
  echo "[scaffold] CPU torch pre-install failed (non-fatal) — a docling install may fall back to the CUDA wheel"
# Make the CPU index the default extra index for the venv, so ANY later torch-adjacent
# install also prefers CPU wheels. pip auto-reads \$VIRTUAL_ENV/pip.conf.
printf '[global]\\nextra-index-url = https://download.pytorch.org/whl/cpu\\n' > /data/project/.venv/pip.conf 2>/dev/null || true

mkdir -p templates static
`.trim(),
    },
  ],
  // Flask has no single global stylesheet to append to (design tokens are copied into
  // static/ by the agent per the design section), so no post-scaffold CSS append.
  globalCssPath: undefined,
  buildPrompt({ appName, requirements, feedback, shouldContinue, tokens, specSection, apiKeySection }) {
    const designSystem = pythonDesignSection(tokens);

    if (shouldContinue) {
      return `The user wants changes to the running Python (Flask) app.

## Feedback / New Requirements
${feedback}

## CRITICAL: Working Directory
- Your working directory is /data/project — ALL files are here (app.py, templates/,
  static/, .venv/). NEVER cd elsewhere.

${specSection}
${designSystem}
${PYTHON_MEMORY_RULES}

## Instructions
1. ${PYTHON_ENV}
2. Apply the requested changes (edit app.py / templates/ / static/, pip-install any new
   deps into the venv).
3. Restart the server using the sequence above. Ensure it serves on 0.0.0.0:8080.

${PYTHON_SERVER_RULES}`;
    }

    return `You are building a SINGLE-STACK Python web application inside a cloud sandbox.
The ENTIRE app is Python (Flask) serving server-rendered HTML — there is NO Next.js and
NO separate frontend. One process, one port (8080), one url.

## App: ${appName}

## Requirements
${requirements}

${specSection}
${designSystem}
${apiKeySection}

## CRITICAL: Working Directory
- Your CWD is /data/project — ALL work happens here. NEVER cd elsewhere.
- A Python venv is already at /data/project/.venv with Flask installed.

${PYTHON_MEMORY_RULES}

## Project Setup (ALREADY DONE — do NOT repeat)
- Python 3 + venv at /data/project/.venv (Flask installed)
- Empty templates/ and static/ directories

## Your Task
1. ${PYTHON_ENV}
2. Build the app:
   - \`app.py\` — the Flask app with all routes, ending in \`app.run(host="0.0.0.0", port=8080)\`.
   - \`templates/\` — Jinja2 templates (a base layout + per-page templates).
   - \`static/\` — CSS/JS/assets (copy design-tokens.css here per the design section).
   - Persist data with stdlib \`sqlite3\` in /data/project/app.db; create tables on startup.
   - pip-install any extra libraries the requirements need: \`.venv/bin/pip install <pkg>\`.
3. Write a real README.md: app name, what it does, tech stack (Python + Flask + SQLite),
   how to run (\`.venv/bin/python app.py\`). NOT a generic placeholder.
4. Start the server: nohup .venv/bin/python app.py > dev.log 2>&1 &
5. Verify: sleep 3 && curl -s http://localhost:8080/ || tail -50 dev.log

${PYTHON_SERVER_RULES}`;
  },
};

const PROFILES: Record<ProjectType, BuildProfile> = {
  webapp: webappProfile,
  landing: landingProfile,
  game: gameProfile,
  python: pythonProfile,
};

export function getBuildProfile(type: ProjectType): BuildProfile {
  return PROFILES[type] ?? webappProfile;
}
