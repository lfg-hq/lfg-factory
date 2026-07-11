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
 */

import type { DesignTokens } from "../config/design-tokens/index.ts";

export type ProjectType = "webapp" | "landing" | "game";

export interface ScaffoldStep {
  message: string; // broadcast to the user while it runs
  script: string; // shell script (run via execOnWorkspace)
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

/**
 * Resolve the project type. An explicit value (from the orchestrator's
 * `project_type` param or persisted metadata) always wins; otherwise fall back
 * to a keyword heuristic over the requirements.
 */
export function detectProjectType(requirements: string, explicit?: string | null): ProjectType {
  if (explicit === "webapp" || explicit === "landing" || explicit === "game") return explicit;
  const r = requirements || "";
  if (GAME_RE.test(r)) return "game";
  if (LANDING_RE.test(r)) return "landing";
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
npm run build 2>&1 && nohup npm start --hostname 0.0.0.0 -p 8080 > dev.log 2>&1 &
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
  `cd /data/project && ${PATH_PREAMBLE} && if [ -f package.json ]; then nohup npm start --hostname 0.0.0.0 -p 8080 > dev.log 2>&1 & fi`;

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

const PROFILES: Record<ProjectType, BuildProfile> = {
  webapp: webappProfile,
  landing: landingProfile,
  game: gameProfile,
};

export function getBuildProfile(type: ProjectType): BuildProfile {
  return PROFILES[type] ?? webappProfile;
}
