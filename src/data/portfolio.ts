/**
 * Portfolio: client and product work LFG has delivered as a consultancy.
 *
 * Each entry is a full case study. Everything here is written from the real
 * project (its code, its git history, the client's own workflow). Numbers in
 * `glance` come from the repository (commits, migrations, tests) — never add an
 * outcome figure (hours saved, % accuracy) until it has been measured with the
 * client. Clients are described by type and region, never by name, unless they
 * have agreed to be named.
 */

export interface PortfolioPoint {
  title: string;
  text: string;
}

export interface PortfolioSection {
  title: string;
  points: string[];
}

export interface PortfolioProject {
  slug: string;
  /** Product or project name as shown on the card and page heading. */
  name: string;
  /** Who it was for, anonymised: "Multi-site retail operator, Australia". */
  client: string;
  /** Short label above the name (≤6 words). */
  tagline: string;
  /** One or two sentences for the card. */
  summary: string;
  /** The one-paragraph version that opens the case study. */
  overview: string;
  /** Lucide icon for the card visual when there is no screenshot. */
  icon: string;
  /** Tailwind gradient stops for the card visual, e.g. "from-emerald-500 to-teal-600". */
  gradient: string;
  image?: string;
  url?: string;
  stack: string[];
  glance: { label: string; value: string }[];
  challengeIntro: string;
  challenges: PortfolioPoint[];
  approach?: string;
  built: PortfolioSection[];
  security: string[];
  results: PortfolioPoint[];
  takeaways: PortfolioPoint[];
}

export const PORTFOLIO: PortfolioProject[] = [
  {
    slug: "software-factory",
    name: "Software Factory",
    client: "Software services firms and in-house engineering teams",
    tagline: "Your delivery pipeline, run by agents",
    summary:
      "A configurable software factory that takes a request from scope to a verified pull request, plugs into the repositories, trackers, models and tools a team already uses, and runs on their infrastructure or ours.",
    overview:
      "Coding agents make an individual developer faster at an individual task. They do not scope a project, hold the architecture, sequence dependent work, prove that a change does what was asked, or keep the trail a client expects. We built a software factory that runs that whole path as one pipeline: scope, plan, document, ticket, implement, test and QA, with a person approving every verified change. It orchestrates Claude Code, Codex and Pi sessions in parallel sandboxes, runs each change in an in-app preview with a recorded walkthrough, and keeps only tests that are proven to catch the change. It is built to fit the business rather than the other way round: it connects to GitHub or GitLab, Jira or Linear, MCP servers and the models and subscriptions a company already pays for, and we customise templates, definition of done, review gates and stack conventions for each team. It runs hosted, self-hosted on the customer's own infrastructure, or set up and operated for them.",
    icon: "factory",
    gradient: "from-indigo-600 to-pink-500",
    stack: ["TypeScript", "Bun", "Hono", "PostgreSQL / SQLite", "Docker sandboxes", "Firecracker microVMs", "Claude Code", "Codex", "MCP"],
    glance: [
      { label: "Built for", value: "Software services firms delivering for clients, and product teams that want more delivery capacity without growing headcount at the same rate" },
      { label: "Problem", value: "AI makes writing code cheap, but delivery is still bottlenecked on scoping, coordination, verification and review, and generic tools ask teams to change how they work" },
      { label: "Solution", value: "A seven-stage pipeline from request to verified pull request, customised to each team's process and connected to the systems it already runs" },
      { label: "Deployment", value: "Hosted, self-hosted on the customer's cloud or data centre, or set up and run for them; open-source core under MIT" },
      { label: "Engineering", value: "878 commits since March 2026, 154 test files, 25 database migrations" },
    ],
    challengeIntro:
      "Every company delivers software differently, and the ones with the most to gain from AI (services firms and busy product teams) are the least able to stop and rebuild their process around a new tool.",
    challenges: [
      { title: "Coding is not delivery", text: "Scoping, architecture, sequencing, regression checks and sign-off still sit with people, so faster code alone does not ship faster." },
      { title: "It has to fit what exists", text: "Repositories, trackers, branch protection, review rules and client vendor policies are already in place and can't be swapped out." },
      { title: "Proof, not confidence", text: "A model that wrote the code will happily write tests that pass. Teams need evidence that a change does what was asked." },
      { title: "Data and model control", text: "Some clients require code to stay on their infrastructure, or rule out particular model vendors." },
      { title: "Accountability", text: "Clients want to know why something was built and who approved it, long after the work is merged." },
    ],
    approach:
      "We built the factory as our own delivery engine first: the other products in this portfolio were taken from requirement to production through it. That kept it honest. Every stage leaves something a person can check, the human gates stay where judgment matters, and anything that slowed real client work became a change to the pipeline. For each customer we then shape it to their process instead of asking them to adopt ours.",
    built: [
      {
        title: "A seven-stage pipeline from request to verified change",
        points: [
          "Scope reads the request alongside the codebase, docs and connected tools, and asks the questions a good engineer would ask before building.",
          "Plan writes a technical analysis and sequence diagrams, failure paths included, so architecture is decided before code exists.",
          "Document produces a versioned PRD with acceptance criteria, which the verification stages later check against.",
          "Ticket breaks the plan into a dependency graph, each ticket linked back to the requirement that caused it.",
          "A person approves the finished, running, tested change, and the pull request lands under the team's own branch protection.",
        ],
      },
      {
        title: "Parallel agents in isolated sandboxes",
        points: [
          "Claude Code, Codex or Pi sessions run each ticket in its own sandbox, on its own branch, never against a main line.",
          "Independent tickets run in parallel; dependent ones wait, and context from finished tickets travels forward.",
          "Live logs and diffs for every session, with the option to steer, continue or restart at any point.",
          "Sandboxes run as Docker containers on the customer's own servers, or on hosted Firecracker microVMs with one setting.",
        ],
      },
      {
        title: "Verification that proves itself",
        points: [
          "A separate QA agent writes tests from the acceptance criteria, not from the diff.",
          "Each test runs before and after the change. Only tests that fail first and pass after are kept and committed.",
          "Every change is started in an in-app preview with its databases, migrations and seed data, and exercised in a real browser with a recorded walkthrough.",
        ],
      },
      {
        title: "Integrates with your existing services",
        points: [
          "GitHub and GitLab: reads repositories, works on branches and opens pull requests under existing protection rules.",
          "Jira and Linear: tickets and status stay in sync with the tracker the team already uses.",
          "MCP servers and app connectors give agents the same internal tools, docs and business systems engineers use.",
          "Any major model on the Claude and ChatGPT plans a company already pays for, or on API keys, with a model policy per project or client.",
        ],
      },
      {
        title: "Customised to how each team delivers",
        points: [
          "Document templates, definition of done, review gates and stack conventions configured per team or per client.",
          "Approval rules decide which stages need a person and who that person is.",
          "Can be delivered under the customer's own brand and domain as their own capability.",
          "We install it, connect it, train engineers to hold the gates, or keep running it and own the outcome.",
        ],
      },
    ],
    security: [
      "Runs entirely inside the customer's environment when required: their cloud or data centre, their compute, their database and storage.",
      "Secrets and subscription credentials are encrypted at rest and stay on the customer's infrastructure. Nothing phones home.",
      "Agents work on branches in isolated sandboxes; nothing merges without a named person approving it.",
      "Requirements, decisions, tickets, sessions, tests, recordings and approvals stay queryable after release.",
      "Admins decide which models and subscriptions each team or client project may use.",
    ],
    results: [
      { title: "Our own products ship through it", text: "KiteReach, Mags and Easylogs were built and are iterated on through the factory." },
      { title: "Seniors supervise, not hand-write", text: "Experienced engineers hold the architecture and review gates across several streams of work instead of writing each one." },
      { title: "Fits without a migration", text: "It attaches to the repositories, trackers and models a team already has, so adoption doesn't start with a rebuild." },
      { title: "A trail on every change", text: "Every merged change traces back to the requirement, ticket, tests and approval that produced it." },
    ],
    takeaways: [
      { title: "Build the whole path, not a faster step", text: "Delivery speeds up when scoping, sequencing and verification are part of the pipeline, not just code generation." },
      { title: "Fit the business, not the tool", text: "Configurable templates, gates and integrations are what let a team adopt the factory without changing how it works." },
      { title: "Keep the human gate", text: "Agents do the volume; a person approves a verified change. That is where judgment pays." },
    ],
  },
  {
    slug: "kitereach",
    name: "KiteReach",
    client: "SaaS product, built and run by our team",
    tagline: "Sentence in, on-brand video out",
    summary:
      "An AI content studio that turns a website and a sentence into on-brand reels, short films and carousels, with the user approving the script and the look before anything renders.",
    overview:
      "KiteReach is a content studio for founders, small businesses and marketing teams who need a steady flow of short-form video and social visuals but don't have a production team. A user pastes their website URL and KiteReach extracts the brand: colours, fonts, logo and tone of voice. From there it produces explainer and animated reels in 12 styles, director-planned short films, and carousels and single images, all in that brand. We built it as one Go codebase with server-rendered pages. Each reel or film is made by a coding agent running in its own disposable Mags sandbox VM, and nothing renders until the user has approved the script and the look. It also includes scheduled publishing, paid-ads support, Stripe billing and bring-your-own-key model access.",
    icon: "clapperboard",
    gradient: "from-orange-500 to-pink-600",
    image: "/public/images/screenshots/kitereach.png",
    url: "https://kitereach.com",
    stack: ["Go", "PostgreSQL", "S3", "Claude Code", "Mags sandboxes", "ElevenLabs", "Stripe", "Kamal"],
    glance: [
      { label: "Product type", value: "B2B SaaS: AI content studio for short-form video and social visuals" },
      { label: "Problem", value: "Each piece of short-form content is a small production (script, design, animation, voice, music, export), and generic AI tools give off-brand output that can't be edited" },
      { label: "Solution", value: "Brand extraction, then agent-built reels, films and carousels behind approval gates, rendered in isolated sandboxes" },
      { label: "Timeline", value: "About 12 months from first commit to the current public plan, with continuous releases" },
      { label: "Engineering", value: "188 commits, ~126,000 lines of Go, 34 feature packages, 18 provider integrations, 85 test files (259 test functions), CI with race tests against Postgres, English and Spanish" },
    ],
    challengeIntro:
      "Short vertical video is now the default format on every major social network, but for a small team each post means writing, design, animation, voice-over, music and export. Agencies are slow and expensive, and generic AI generators struggle with text inside images, characters that change between shots, and output nobody can edit.",
    challenges: [
      { title: "Brand consistency", text: "Every asset has to use the right colours, fonts and voice without the user re-entering them each time." },
      { title: "Legible design", text: "Image models paint text badly, and a reel full of garbled captions can't be published." },
      { title: "Long, fragile jobs", text: "A render takes minutes and calls several external models. It has to survive retries, deploys and restarts." },
      { title: "Control", text: "Users need to approve and correct the work at each stage, not just accept whatever comes out." },
      { title: "Many integrations", text: "Publishing, ads, billing, voice, video and image models each bring their own APIs and failure modes." },
    ],
    built: [
      {
        title: "Brand setup",
        points: [
          "A URL-to-brand extractor that pulls colours, fonts, logo, voice and tone, used as the default for everything generated afterwards.",
          "An optional deep brand-research step run by an agent in a sandbox.",
          "Brand profiles stored per account, with ownership checks on every read and write.",
        ],
      },
      {
        title: "Reels made by an agent, not an image model",
        points: [
          "12 reel styles, from 2D explainer and kinetic text to whiteboard sketch, isometric 3D, pixel art and comic book.",
          "Each frame is built in code (React) and rendered, so text stays sharp and layouts hold. Voice-over is timed word by word.",
          "Vertical, square and landscape output, with a choice of voice, format and length.",
          "The user reviews the script before anything renders; progress streams live and runs survive server restarts.",
        ],
      },
      {
        title: "Films with a director and continuity checks",
        points: [
          "An AI director turns an idea into a shot list, and the user approves the look before any shot is generated.",
          "A choice of video model per shot, generated at the lowest suitable resolution to keep cost down.",
          "Each clip is reviewed as it finishes and can be redone, re-prompted or moved to another model, with continuity carried between shots.",
          "Levelled audio, music score and narration, plus a content policy and a moderation queue.",
        ],
      },
      {
        title: "Visuals, publishing and ads",
        points: [
          "Images and carousels designed in HTML and exported for Instagram and LinkedIn feeds.",
          "Publishing to Instagram, Facebook, LinkedIn and TikTok, with a scheduler for timed posts.",
          "Meta ads support with auto-generated creatives and an autopilot mode with spend governance.",
        ],
      },
      {
        title: "Billing and bring-your-own-key",
        points: [
          "Stripe subscriptions with a free first reel and a first-run tour.",
          "Per-user API keys for model providers, so customers can run generation on their own accounts.",
        ],
      },
    ],
    security: [
      "User credentials and API keys encrypted with AES-256-GCM using a rotatable key ring.",
      "In production the server refuses to start without a strong session secret, an HTTPS base URL, credential keys and billing secrets.",
      "Ownership checks on every user resource, verified OAuth state, restricted redirects and timeouts on all outbound calls.",
      "Render jobs use idempotent keys and run in single-use sandbox VMs with per-job secrets that are never stored.",
      "Deployed with Kamal, with backup and restore-drill scripts and a written production-readiness checklist.",
    ],
    results: [
      { title: "Live and on sale", text: "Running at kitereach.com with public pricing and a free first reel." },
      { title: "Four content types, one brand", text: "Explainers, animated reels, films and carousels, all from one brand profile." },
      { title: "The user decides at each stage", text: "Script, look and per-shot approval gates mean nothing final is produced without sign-off." },
      { title: "Production-ready codebase", text: "CI with race tests, encrypted credentials and startup checks that refuse an unsafe configuration." },
    ],
    takeaways: [
      { title: "Have the agent write code, not pixels", text: "Building frames in HTML and React gave readable text and editable layouts that image models could not." },
      { title: "Approval gates save render time", text: "Approving the script and the look first stops expensive generation being wasted on the wrong idea." },
      { title: "One disposable VM per job", text: "Running every render in its own sandbox removed stray processes and cross-job interference as sources of failure." },
    ],
  },
  {
    slug: "mags",
    name: "Mags",
    client: "Developer platform, built and run by our team",
    tagline: "MicroVM sandboxes for AI agents",
    summary:
      "A cloud job runner that gives every agent run its own Firecracker microVM, started from a snapshot in milliseconds, with workspaces that persist between runs.",
    overview:
      "Mags is a cloud job runner and sandbox platform for teams whose AI agents run code they wrote themselves: shell commands, package installs, dev servers and headless browsers. Containers on a shared host aren't a strong enough boundary for that, and ordinary VMs boot too slowly to sit inside an agent loop. We built a Go control plane that schedules jobs across bare-metal hosts. Each run is a copy-on-write clone of a pre-booted \"golden\" Firecracker snapshot, with workspaces that persist between runs. The same platform runs cloud Chromium browsers, sleeps idle VMs and wakes them on demand, and deploys apps from an image or a repo. Developers use it through an npm CLI, Python and Node SDKs, a REST API or a web dashboard.",
    icon: "boxes",
    gradient: "from-slate-700 to-indigo-700",
    image: "/public/images/screenshots/mags.png",
    url: "https://mags.run",
    stack: ["Go", "gRPC", "PostgreSQL", "Redis", "Firecracker", "JuiceFS / NFS", "S3", "Chromium CDP"],
    glance: [
      { label: "Product type", value: "Developer infrastructure: sandboxes, a job runner, cloud browsers and app deploys on microVMs" },
      { label: "Problem", value: "Agents execute untrusted, generated code; containers don't isolate it well enough, and full VMs boot too slowly for an agent loop" },
      { label: "Solution", value: "Firecracker microVMs cloned from golden snapshots, persistent workspaces on object storage, and a scheduler that sends each job back to the host where its workspace is warm" },
      { label: "Timeline", value: "About 13 months of continuous development, live throughout" },
      { label: "Engineering", value: "229 commits in the core repo, ~81,000 lines of Go, 27 database migrations, 47 test files, a public npm CLI, Python and Node SDKs" },
    ],
    challengeIntro:
      "Coding agents, browser agents and data agents all do something risky: they run output they generated themselves. Teams building them kept running into the same problems.",
    challenges: [
      { title: "Isolation", text: "A shared container kernel isn't a safe boundary for untrusted code from many tenants." },
      { title: "Speed", text: "A VM that boots in tens of seconds is fine for CI and far too slow for an agent that runs a command every few seconds." },
      { title: "State", text: "Some runs should be thrown away; others need packages, databases and files still there tomorrow." },
      { title: "Operations", text: "VMs crash, hosts restart and images change, and the control plane must agree with what is actually running." },
      { title: "Regulated buyers", text: "Some customers need data residency, egress control and the option to run everything on their own servers." },
    ],
    built: [
      {
        title: "Control plane and scheduler",
        points: [
          "A Go orchestrator over REST and gRPC that validates and meters jobs and enforces per-user and per-key quotas.",
          "Memory- and disk-aware placement that prefers the host already holding the workspace, with fallback.",
          "Idempotent job submission, maximum lifetimes, timeouts and callback webhooks.",
        ],
      },
      {
        title: "Fast starts from golden snapshots",
        points: [
          "For each image type (base, Python, Chromium, coding agent, media), one VM boots and is snapshotted as a golden.",
          "New sandboxes are copy-on-write clones over a shared read-only base, with network identity rewritten and clocks resynced on restore.",
          "Each golden records a fingerprint of its source image and is rebuilt automatically when stale, then smoke-tested.",
        ],
      },
      {
        title: "Persistent workspaces, sleep and wake",
        points: [
          "Workspaces live in object storage with fast local writes on top.",
          "After a job the VM stays parked with its workspace mounted, and the next job for that workspace goes to the same host. In our benchmarks repeat runs dropped from about 4 s to about 0.1 s.",
          "Idle VMs are checkpointed and stopped; the next SSH connection restores them on a healthy host.",
        ],
      },
      {
        title: "Cloud browsers, deploys and interfaces",
        points: [
          "Chromium microVMs with a CDP endpoint that works with Playwright and Puppeteer.",
          "One-command deploys from a Docker image or repo to an HTTPS app, with rollbacks and a self-deploy mode for the customer's own servers.",
          "A CLI for runs, named workspaces, SSH-able VMs, cron and diagnostics, plus SDKs and a REST API.",
        ],
      },
      {
        title: "One execution path",
        points: [
          "The platform started with two engines, and fixes kept regressing between them.",
          "We removed the older engine completely, along with its API and CLI switches, leaving one path to test, secure and operate.",
        ],
      },
    ],
    security: [
      "Cross-tenant network isolation for sandboxes, on the control plane and on storage exports.",
      "Per-job egress allowlists, and scoped app keys with per-key job isolation and quotas.",
      "Per-job secrets masked in logs; browser sessions locked to a per-session secret.",
      "Self-healing: agents re-adopt VMs after a restart, a sweeper reaps crashed processes, and a two-way sync keeps the orchestrator and hosts in agreement.",
    ],
    results: [
      { title: "Live at mags.run", text: "A public CLI on npm, SDKs and a dashboard." },
      { title: "Used by our own products", text: "KiteReach renders every reel and film inside a Mags sandbox." },
      { title: "VM isolation, container-like starts", text: "Golden-snapshot cloning and workspace-aware scheduling make sandboxes fast enough for an agent loop." },
      { title: "A simpler core", text: "Removing the second engine left one execution path to test, secure and operate." },
    ],
    takeaways: [
      { title: "The fastest boot is no boot", text: "Cloning a pre-booted snapshot, not booting faster, is what makes sub-second starts possible." },
      { title: "Treat the scheduler as part of the cache", text: "Sending a job back to the host where its workspace is warm turned a simple pool into a large speed-up for repeat runs." },
      { title: "Delete the second path", text: "Two execution engines doubled the bugs. Removing one was worth more than any new feature." },
    ],
  },
  {
    slug: "easylogs",
    name: "Easylogs",
    client: "SaaS product, built and run by our team",
    tagline: "Logs, metrics and alerts, simplified",
    summary:
      "Hosted log search, server metrics and alerting for small engineering teams, with an AI agent that answers questions by running real queries on your logs.",
    overview:
      "Easylogs is a hosted observability product for small engineering teams who want to search logs, watch their servers and get alerted without running an ELK or Prometheus stack themselves. We built the whole pipeline. A multi-tenant ingestion service accepts JSON and NDJSON logs over HTTP and buffers them before they reach OpenSearch. A web app supports familiar query syntax, field management and saved searches. Server metrics come from a one-line installer that registers the host with VictoriaMetrics. Alert rules notify Slack or Telegram, and an AI agent calls a log-search tool to answer questions in plain language. The product began as a Django and React app and was later rewritten as a single Go service, and it ships a cross-platform CLI with a macOS menu-bar mode.",
    icon: "scroll-text",
    gradient: "from-cyan-500 to-blue-600",
    image: "/public/images/screenshots/easylogs.png",
    url: "https://easylogs.co",
    stack: ["Go", "PostgreSQL", "Redis", "OpenSearch", "VictoriaMetrics", "node_exporter", "Stripe", "Gemini"],
    glance: [
      { label: "Product type", value: "B2B SaaS: hosted logging, infrastructure metrics and alerting" },
      { label: "Problem", value: "Self-hosting ELK or Prometheus is heavy for a small team, while hosted tools are expensive and hard to query under pressure" },
      { label: "Solution", value: "Per-tenant log storage behind a buffered Go ingestor, a focused search UI, server metrics, alert rules and an AI log agent" },
      { label: "Timeline", value: "First version in late 2024, a dedicated Go ingestor in early 2025, and a full Go rewrite of the app later that year" },
      { label: "Engineering", value: "141 commits across four repos, ~20,000 lines of Go across app and ingestor, ~90 HTTP routes, 28 data models" },
    ],
    challengeIntro:
      "Observability tools are only useful if logs arrive reliably and a problem is easy to find at the moment someone is under pressure. For a small team the usual choices are a heavy self-hosted stack or a hosted tool whose cost and query language get in the way.",
    challenges: [
      { title: "Ingestion that doesn't drop data", text: "Logs must keep flowing when the search cluster slows down or restarts." },
      { title: "Multi-tenancy", text: "Each customer's logs and credentials kept separate on a shared cluster." },
      { title: "Messy data", text: "Nested JSON, inconsistent field types and changing timestamp fields all have to be searchable." },
      { title: "Metrics without the setup", text: "Server monitoring that doesn't require configuring Prometheus." },
      { title: "Alerts where the team is", text: "Notifications in the tools the team already uses." },
    ],
    built: [
      {
        title: "A buffered, multi-tenant ingestor",
        points: [
          "A Go service accepting JSON and NDJSON logs over HTTP, with token authentication and cached credentials.",
          "A two-tier buffer, memory with overflow to disk, plus a write-ahead log so logs survive slowdowns and restarts.",
          "Adaptive throttling based on cluster response times, daily per-tenant indices and horizontal scaling.",
        ],
      },
      {
        title: "Log search for when it matters",
        points: [
          "A KQL-style query language translated into OpenSearch queries.",
          "Field mappings with type conversion and reindexing, and a selectable timestamp field.",
          "Autocomplete, saved searches, history, collapsible nested data and a side panel for a single log.",
          "Volume and error trend charts on the dashboard.",
        ],
      },
      {
        title: "Server metrics and alerting",
        points: [
          "A per-user one-line installer that starts node_exporter and registers the host for scraping.",
          "Metric queries filtered to each user's own hosts.",
          "A background evaluator runs threshold rules and notifies Slack or Telegram, with a test-send button and event history.",
        ],
      },
      {
        title: "AI log agent, CLI and menu bar",
        points: [
          "A streaming chat agent with a log-search tool that runs real queries against the user's own indices.",
          "A CLI for macOS and Linux with login, logs, metrics, alerts, agent and an interactive shell.",
          "A macOS menu-bar mode showing live status.",
        ],
      },
      {
        title: "Accounts and billing",
        points: [
          "Email signup with verification, Google sign-in and revocable API tokens.",
          "Stripe subscriptions with webhooks, payment-method updates and invoices.",
        ],
      },
    ],
    security: [
      "Passwords hashed with bcrypt; API tokens generated from cryptographically random bytes and revocable.",
      "Each tenant gets its own search account and index prefix, and API routes require authentication and a verified email.",
      "The ingestor never blocks callers on cluster health: the buffer, disk queue and write-ahead log absorb backpressure.",
      "Health checks and Docker-based deploys with Kamal.",
    ],
    results: [
      { title: "A complete observability product", text: "Ingestion, storage, search, metrics, alerts, billing and a CLI, built and operated by a small team." },
      { title: "A clean move from Django to Go", text: "The app was rewritten as one Go service while keeping its data model and features." },
      { title: "Live at easylogs.co", text: "With a separate app, ingestion endpoint and docs site." },
      { title: "One step to get started", text: "A single install command connects a server's metrics, and logs arrive over plain HTTP." },
    ],
    takeaways: [
      { title: "Buffer before you index", text: "A memory-to-disk buffer with a write-ahead log decides whether logs get dropped when the cluster has a bad minute." },
      { title: "Make the query language familiar", text: "KQL-style syntax let users search the way they already know." },
      { title: "Give the AI agent real tools", text: "The agent is useful because it runs actual searches on the user's data rather than guessing." },
    ],
  },
  {
    slug: "accounts-payable-automation",
    name: "AI-Assisted Accounts Payable",
    client: "Multi-site retail operator, Australia",
    tagline: "Invoices, inbox to accounting system",
    summary:
      "A rules-first platform that reads every supplier invoice from a shared inbox, checks it, and sends it to the accounting system as a draft bill, so the accounts team verifies instead of retyping.",
    overview:
      "A multi-site retail operator in Australia was receiving hundreds of supplier invoices, credit notes and statements every week into a shared Gmail inbox: PDFs, scanned cash receipts, invoices typed into the email body, and \"click here to download\" links. Their accounts team keyed each one into their accounting system by hand, matched it to the right site, and chased invoices that appeared on statements but never arrived. In three weeks we had a secure, rules-first invoice platform in production. It scans the inbox on a schedule, finds every accounting document (including ones inside links, combined PDFs and photographed receipts), uses AI to classify each document and extract the key fields with evidence quoted from the source, checks them against deterministic rules, and sends them to the accounting system as draft bills, with an optional human review step. It also reconciles supplier statements line by line, so missing invoices surface on their own instead of at month-end.",
    icon: "receipt-text",
    gradient: "from-emerald-500 to-teal-600",
    stack: ["Next.js 16", "TypeScript", "PostgreSQL", "pg-boss", "Gmail API", "Xero / QuickBooks API", "Azure AI Foundry", "Kamal", "Azure"],
    glance: [
      { label: "Client", value: "Multi-site retail operator (fuel and convenience), Australia" },
      { label: "Problem", value: "Manual entry of a high volume of supplier invoices from a shared inbox into the accounting system" },
      { label: "Solution", value: "Email-to-accounting invoice platform: AI classification and extraction, rule checks, optional human review and statement reconciliation" },
      { label: "Timeline", value: "3 weeks from first commit to production, then weekly iteration with the accounts team" },
      { label: "Engineering", value: "150+ shipped iterations, 46 database migrations, 600+ automated tests" },
    ],
    challengeIntro:
      "The client runs several retail sites, and each one buys from dozens of suppliers: fuel, groceries, beverages, newspapers, utilities, maintenance and services. Almost all of them send their paperwork to one shared accounts inbox, and no two do it the same way.",
    challenges: [
      { title: "Format chaos", text: "Clean PDFs, multi-invoice PDFs, photographed cash receipts with handwritten lines, invoices written in the email body, and emails holding nothing but a download link." },
      { title: "Mixed document types", text: "Invoices arrive alongside credit notes, statements, remittances, order confirmations, direct-debit notices and marketing. Only some belong in accounts payable." },
      { title: "Right site, every time", text: "One supplier can deliver to several sites, so each invoice must reach the correct site and accounting entity, usually from a \"Ship to\" block that varies by supplier." },
      { title: "Exclusions", text: "Some suppliers and bill types are paid another way and must never be entered as bills, but they still land in the inbox." },
      { title: "Statements and missing invoices", text: "Monthly statements list invoices the team may never have received. Finding those gaps meant cross-checking each line by hand." },
      { title: "Duplicates and credits", text: "The same invoice often arrives twice, and credit notes sometimes look like invoices with a negative total." },
    ],
    approach:
      "We treated this as a rules-first system rather than \"AI that posts bills\". The AI does the reading, deterministic code does the judging, and people stay in control: review is optional, and the team decides how much to check. We built it closely with the accounts team. Real supplier examples drove each iteration, and every edge case they flagged became a rule and a regression test.",
    built: [
      {
        title: "Reliable mailbox intake",
        points: [
          "Connects to the shared Gmail inbox with OAuth on the narrowest workable scope; refresh tokens are encrypted at rest.",
          "Per-site scan schedules with incremental watermarks, so a delayed or failed scan catches up and never skips mail. Leases and checkpoints recover interrupted runs without double-processing.",
          "Pause and resume, date-range rescans, and a run history that explains every email: processed, skipped (and why) or failed.",
          "Handled emails get a Gmail label, so the inbox shows at a glance what has been done.",
        ],
      },
      {
        title: "Document discovery",
        points: [
          "Inventories every nested attachment, inline image, email body and invoice link before analysis.",
          "Follows supplier download links safely: HTTPS only, every redirect re-validated, private network addresses blocked, login and CAPTCHA pages never bypassed.",
          "Splits combined PDFs into individual invoices and crops each receipt out of a scanned page of cash receipts.",
          "Skips non-accounting content and records why, so scan counts always add up.",
        ],
      },
      {
        title: "AI classification and extraction with evidence",
        points: [
          "Original PDFs and images go to a vision-capable model with strict structured output: first classify (invoice, credit note, statement, receipt, payment advice, not accounting), then extract supplier, number, dates, totals, tax, ship-to, line items and statement rows.",
          "Every extracted value must quote where it came from, and the platform checks those quotes. Answers it cannot verify are rejected rather than trusted.",
          "Document text is treated as untrusted data; the model has no tools and no access to the mailbox or accounting system.",
          "Admins choose the model per site, and every analysis is fingerprinted and audited so runs can be compared.",
        ],
      },
      {
        title: "Deterministic rules engine",
        points: [
          "Readiness checks for invoice number, real date, currency and a non-zero total, using exact decimal arithmetic. No floating-point money anywhere.",
          "Site matching: the Ship-To block wins when present, billing details are the fallback, and mismatches are held for a decision.",
          "Credit notes detected from headings, negative or \"CR\" totals, and sent as credits with the correct sign.",
          "Identity-based duplicate protection across copies, forwards and links, backed by a database constraint that makes a second send impossible.",
          "Site-specific supplier and sender exclusions, checked before analysis and again before export.",
        ],
      },
      {
        title: "Optional human review",
        points: [
          "Ready invoices can flow straight through; the team reviews as much or as little as it wants.",
          "One queue grouped by source email, with the original document side by side with the extracted fields.",
          "Reviewers verify, correct, retype a document, mark it \"not an invoice\" or reanalyse. Corrections are audited as reviewer input, never shown as source evidence.",
          "Bulk send for many ready invoices at once, each still checked on its own.",
        ],
      },
      {
        title: "Accounting system delivery",
        points: [
          "Per-site connections to the accounting system (Xero, QuickBooks or similar), sending draft bills or credits with the original PDF attached.",
          "Automatic contact matching, with a safe fallback when no supplier contact exists yet.",
          "Clear status for every invoice (pending, sent, failed, retryable), with safe retries and manual resolution.",
        ],
      },
      {
        title: "Statement reconciliation",
        points: [
          "Each supplier statement is broken into lines; every referenced invoice is checked in the accounting system, then searched for across the whole mailbox.",
          "Originals found are imported and run through the normal rules. Unmatched lines become pending invoices to request, or a placeholder bill that is flagged when the real one arrives.",
          "A credit-note register tracks credits on statements that are missing from the books.",
        ],
      },
    ],
    security: [
      "Role-based access per organisation and site. Public sign-up is disabled and only administrators change policy.",
      "Every review action, correction, send and setting change is audit-logged with before and after values.",
      "Evidence lives in private storage scoped to each site, with retention and legal-hold rules.",
      "AI requests use no-storage settings; secrets live in a cloud key vault, never in source control.",
      "Runs on Azure VMs, deployed with Kamal through CI over a private Tailscale network. Only HTTPS is public; the database is private and backed up nightly.",
    ],
    results: [
      { title: "From typing to verifying", text: "The accounts team works from one queue and confirms extracted data against the original instead of keying each invoice." },
      { title: "Correct site, by default", text: "Ship-To matching and per-site connections route each bill to the right entity; anything ambiguous goes to a person." },
      { title: "Missing invoices surface early", text: "Statement reconciliation turns month-end detective work into a list of specific invoices to chase." },
      { title: "No silent duplicates or excluded bills", text: "Duplicate and exclusion checks run before anything reaches the books, and the database enforces one send per document." },
      { title: "Full traceability", text: "Every number in the books traces back to a quoted source, an email and an auditable decision." },
    ],
    takeaways: [
      { title: "Let AI read and let code decide", text: "Extraction is probabilistic, so site, duplicate, credit and exclusion decisions are deterministic, testable and auditable." },
      { title: "Make evidence a requirement", text: "Requiring every field to quote its source made AI output checkable and gave reviewers instant context." },
      { title: "Build with the people who use it", text: "Real supplier documents drove each iteration, and every edge case became a permanent test." },
      { title: "Fail closed", text: "When the system is unsure, it holds the document for a decision. It never guesses its way into the ledger." },
    ],
  },
  {
    slug: "ringdesk",
    name: "RingDesk",
    client: "Dental practice, United States",
    tagline: "AI front desk for clinics",
    summary:
      "A voice agent that answers the clinic phone when the desk is closed or busy, books real appointments into the calendar, takes messages and sends emergencies to the right place.",
    overview:
      "A US dental practice was losing calls when its front desk was closed or busy. It had already proved, with a set of deployment scripts, that a voice agent could check a calendar and book a slot. What it lacked was a product: something a clinic could sign up for, configure without touching an API, and trust with patient calls. We built RingDesk, a multi-tenant web app in which each clinic onboards in four steps, connects its Cal.com calendar and gets a provisioned phone number answered by a voice agent. Mid-call, the agent checks real availability, books confirmed appointments, takes messages and directs emergencies to 911 and the clinic's emergency line. Every call lands in a dashboard with its transcript, outcome and any booking, and urgent messages trigger an email alert to staff. The working product was built in five days of active development, from scaffold to live phone number.",
    icon: "phone-call",
    gradient: "from-sky-500 to-indigo-600",
    stack: ["Next.js 16", "TypeScript", "Postgres (Neon)", "Drizzle ORM", "Better Auth", "Retell AI", "Cal.com API", "Resend"],
    glance: [
      { label: "Client", value: "A dental practice in the United States (after-hours phone coverage)" },
      { label: "Problem", value: "Calls outside front-desk hours went unanswered, and an earlier scripted voice-agent setup could not be configured or monitored by clinic staff" },
      { label: "Solution", value: "A multi-tenant web app that provisions a voice agent and phone number per clinic, books into Cal.com, takes and escalates messages, and logs every call" },
      { label: "Timeline", value: "Five days of active development, from scaffold to a live phone number" },
      { label: "Engineering", value: "28 commits, 5 database migrations, 3 signed agent-tool endpoints, 2 verified webhooks" },
    ],
    challengeIntro:
      "Clinics get a large share of booking and \"please call me back\" calls when nobody is at the desk. The practice's proof of concept showed the idea worked, but every change meant re-running scripts, there was no record staff could review, and nothing scaled past one clinic.",
    challenges: [
      { title: "No self-service setup", text: "Clinic name, hours, emergency number and the agent's persona were baked into scripts, not editable by staff." },
      { title: "Bookings had to be real", text: "The agent could only offer genuinely free times, and failures had to come back as something it could say, not a stack trace." },
      { title: "Emergencies are not appointments", text: "A caller describing a medical emergency must be sent to 911 immediately, never routed into scheduling." },
      { title: "Staff need visibility", text: "Every call, transcript, booking and message needed to be visible the next morning, with urgent items first." },
      { title: "Secrets and public callbacks", text: "The app holds each clinic's calendar key and receives calls from two providers over the internet, so storage and inbound requests both had to be secured." },
      { title: "Prompt drift", text: "When a clinic changes its hours or greeting, the live phone agent has to pick that up without a manual redeploy." },
    ],
    approach:
      "We treated the existing scripts as the specification and rebuilt them as a product, one layer at a time: auth and multi-tenancy first (a clinic is an organisation), then onboarding and settings, the calendar service layer, the call log, appointments and messages, and finally the voice agent wired to the app's own endpoints. Every layer returns typed results rather than throwing, because the final consumer is a voice agent mid-conversation that always needs a sentence to say.",
    built: [
      {
        title: "Multi-tenant clinic accounts and onboarding",
        points: [
          "Email/password and Google sign-in, with every clinic its own tenant, created on signup with the user as owner.",
          "A four-step onboarding wizard: clinic profile and timezone, front-desk hours per weekday, emergency contact, agent persona.",
          "Every dashboard query is scoped to the signed-in clinic, and all clinic data is removed with the clinic.",
        ],
      },
      {
        title: "Voice agent provisioning and live prompt sync",
        points: [
          "One click creates the clinic's voice agent and buys a phone number bound to it for inbound calls.",
          "The system prompt is generated from clinic settings: tone, hours, tools, booking rules, \"never give medical advice\" and an explicit emergency section.",
          "Saving settings re-pushes the prompt, greeting and tools to the live agent, with sync status and errors shown on the Integrations page.",
        ],
      },
      {
        title: "Mid-call tools: availability, booking, messages",
        points: [
          "Three signed endpoints the agent calls during a conversation: check availability, book appointment and take message.",
          "Availability follows what the caller actually said (\"tomorrow\", \"Tuesday\", \"the 19th\", \"morning\"); the date parser is deliberately strict so a vague phrase never becomes the wrong date.",
          "Slots are spoken in the clinic's timezone (\"Tuesday August 19th at 2:30 PM\"), with up to three options.",
          "Every failure returns a reason the agent can voice, such as asking for a callback number or offering to take a message.",
        ],
      },
      {
        title: "Calendar integration",
        points: [
          "Clinics paste a Cal.com API key; it is validated, encrypted and stored with the chosen event type.",
          "Typed outcomes (not connected, no availability, invalid slot, booking rejected, calendar unavailable) for the voice layer to translate.",
          "A booking webhook keeps created, cancelled and rescheduled appointments in sync with the dashboard.",
        ],
      },
      {
        title: "Call lifecycle and outcome tracking",
        points: [
          "Call started, ended and analysed events store caller number, duration, transcript, caller name and reason.",
          "Every event is an upsert on the provider's call id, so out-of-order events never lose data.",
          "Outcomes (booked, message, emergency, abandoned) are never overwritten by the end-of-call default once set mid-call.",
        ],
      },
      {
        title: "Staff dashboard",
        points: [
          "Call log with outcome filters and a per-call page with the full transcript.",
          "Upcoming and past appointments in the clinic's timezone, with live status badges.",
          "A messages inbox with urgent items pinned, each linked to its transcript, plus an email alert that never holds up a live call.",
        ],
      },
    ],
    security: [
      "Each clinic's calendar API key is encrypted at rest with AES-256-GCM and never leaves the server.",
      "Voice-provider webhooks and all agent-tool endpoints verify an HMAC-SHA256 signature over the raw body, with a five-minute window and constant-time comparison.",
      "Calendar webhooks are signature-verified when a secret is configured.",
      "Logs are written to avoid secrets; provider errors are extracted and capped rather than dumped.",
      "The agent prompt forbids medical advice and booking emergencies, and requires reading back name, date, time and email before booking.",
    ],
    results: [
      { title: "A product, not a script", text: "Clinic staff sign up, set hours and persona, connect a calendar and get a live number without touching an API." },
      { title: "Real bookings from phone calls", text: "The agent offers only times the calendar reports as free and creates confirmed bookings that appear in the dashboard." },
      { title: "Safer emergency handling", text: "Emergency instructions are part of every generated prompt, and emergency callers are steered to 911 and the clinic line." },
      { title: "Next-morning visibility", text: "Every call is logged with transcript and outcome, and urgent messages reach staff by email as well as the dashboard." },
    ],
    takeaways: [
      { title: "Design tool responses for speech", text: "Typed, sentence-ready results from every integration let the voice agent recover gracefully instead of going silent." },
      { title: "Assume webhooks arrive out of order", text: "Upserting on the call id and never overwriting a set outcome kept records correct whatever order events came in." },
      { title: "Turn a proof of concept into a product", text: "Moving every hard-coded value into per-clinic settings, with automatic re-sync, is what made it usable by clinic staff." },
    ],
  },
  {
    slug: "screenline",
    name: "Screenline",
    client: "Recruiting firm, India",
    tagline: "AI first-round phone screening",
    summary:
      "A recruiter workspace where a voice agent holds the first screening call and the recruiter gets notes backed by the candidate's own words. Nothing is ranked or rejected automatically.",
    overview:
      "A recruiting firm in India wanted to take the repetitive first screening call off its recruiters' plates without handing hiring judgement to a machine. We built Screenline, a private recruiter workspace. A recruiter uploads a job description and a resume, reviews an AI-prepared brief and the candidate's phone number, and only then confirms a call. A voice agent phones the candidate using native realtime audio: it confirms it is speaking to the right person, says it is an AI, asks permission, and then works through the approved topics and practical questions such as notice period and availability. After the call, the recruiter sees each answer marked as self-reported, uncertain or unanswered, with the exact candidate quote behind it. Over 12 days the work moved through 19 scoped tickets to a pilot that is safe by default: live calling stays blocked until every approval, cost cap and provider check is in place.",
    icon: "user-search",
    gradient: "from-violet-500 to-fuchsia-600",
    stack: ["Next.js 16", "TypeScript", "PostgreSQL", "Better Auth", "OpenAI Realtime", "Exotel", "WebSockets", "libphonenumber"],
    glance: [
      { label: "Client", value: "A recruiting firm in India running an English-first hiring pilot, with international numbers added later" },
      { label: "Problem", value: "First-round phone screens take up recruiter time, and the notes they produce are inconsistent and hard to check against what the candidate said" },
      { label: "Solution", value: "A restricted workspace that runs reviewed, consented AI voice screening calls and returns quote-backed results for a person to decide on" },
      { label: "Timeline", value: "12 days, 19 tickets, from first commit to a working pilot" },
      { label: "Engineering", value: "62 commits, 9 database migrations, 42 test files (113 test cases) plus 12 runtime and provider check scripts" },
    ],
    challengeIntro:
      "Phone screening is a good fit for a voice agent, but it is also where automation does the most damage when it gets something wrong. A call to the wrong person, a call nobody approved, or a summary that invents a skill all land on real candidates and on the firm's reputation.",
    challenges: [
      { title: "No accidental calls", text: "Uploading or parsing a resume could never start a paid call. Every call needed an explicit, reviewed and confirmed action." },
      { title: "Telephony is unforgiving", text: "Real-time audio, interruptions, socket drops, retried webhooks and ambiguous timeouts all had to be handled without double-dialling anyone." },
      { title: "Identity and consent first", text: "The agent confirms it has the right person before mentioning the resume, says it is an AI, and respects a refusal immediately." },
      { title: "Results must be checkable", text: "No scores, no \"verified skill\" labels, and no summary prose the candidate never said." },
      { title: "Hard limits on spend and hours", text: "Per-call duration and cost, total pilot spend and calling hours all enforced, with no defaults made up in code." },
      { title: "A safe place to rehearse", text: "Recruiters wanted to try the agent on realistic test candidates without touching real candidate data." },
    ],
    approach:
      "We split the system into a Next.js web app for recruiters and a single persistent worker that owns the job queue, the audio bridge and data retention. Each capability arrived as its own ticket on its own branch, with written acceptance evidence recording what was proven locally and what still needed live verification. The code enforces that distinction too: live calling is gated behind explicit approval flags, and a readiness panel shows every remaining blocker on screen.",
    built: [
      {
        title: "A restricted recruiter workspace",
        points: [
          "Public signup disabled; every API checks company membership and returns 404 for another company's records.",
          "Jobs, Candidates, Screening Results and Test Call in one workspace.",
          "A readiness panel checks the database and worker heartbeat and lists each configuration and safety blocker in plain language.",
        ],
      },
      {
        title: "Resume and job-description intake with human review",
        points: [
          "JDs as text, PDF or DOCX; one private resume per candidate application.",
          "Parsing runs in an isolated process with a timeout and memory cap.",
          "An AI brief lists requirements, resume claims (each tied to a resume and JD quote), gaps and topics. Any quote not found in the source is rejected.",
          "The recruiter confirms identity, phone number and topics. Replacing a document invalidates the review.",
        ],
      },
      {
        title: "Reviewed, one-at-a-time calling",
        points: [
          "A database lock and unique index allow only one active call at a time; idempotency keys stop double submissions.",
          "Eligibility is checked at submission and again just before dialling: review freshness, opt-outs, JD expiry, calling hours and unchanged inputs.",
          "An ambiguous telephony timeout triggers read-only reconciliation, never a blind redial.",
        ],
      },
      {
        title: "A native-audio voice agent on the phone line",
        points: [
          "The worker bridges the telephony media stream straight to a realtime speech model, with no text-to-speech chain in between.",
          "Natural interruptions: the agent stops, clears playback and keeps track of what the caller actually heard.",
          "Identity check, then AI disclosure, then a willingness question, all before any screening. Documents are passed in as untrusted data.",
          "The model gets only narrow tools, and ending a call for opt-out or wrong number must cite validated candidate evidence.",
        ],
      },
      {
        title: "Evidence-based screening results",
        points: [
          "Each topic, resume claim and practical question is marked self-reported, uncertain or unanswered.",
          "Every answer carries exact candidate quotes, checked against the transcript in code.",
          "Results record the model, config version and input hash, and call state is tracked separately from screening outcome.",
        ],
      },
      {
        title: "Test Call: rehearsal without real candidates",
        points: [
          "Recruiters generate a paired synthetic JD and resume, both editable.",
          "Browser simulation uses the same realtime session and policy, with a single-use, 60-second token and no spend.",
          "A comparison view lines up each requirement with resume quotes and candidate answers, never ranking the candidate.",
        ],
      },
    ],
    security: [
      "Live calling is off by default and needs separate approval flags plus sponsor-set duration, cost, spend and calling-hour limits.",
      "Provider keys stay on the server; media connections need authentication plus a short-lived, single-use signed token.",
      "Telephony webhooks are checked by source and shared secret, deduplicated, and can only move state forward.",
      "Resumes and JDs sit in private storage, and a worker deletes expired documents and conversation evidence on a set retention period.",
      "Logs are allowlisted and sanitised: no documents, transcripts, audio, phone numbers or emails.",
      "Opt-outs and wrong numbers write suppression records that are checked before every dial. Hiring decisions stay with the recruiter.",
    ],
    results: [
      { title: "An end-to-end pilot path", text: "Intake, review, confirmed dialling, a natural voice conversation and quote-backed results run in one system, and live test calls have connected end to end." },
      { title: "Safe by construction", text: "One active call, no blind redials, cost caps and approval gates are enforced in the database and code, not left to operator discipline." },
      { title: "Evidence a recruiter can check", text: "Every screening note links to the candidate's own words, and gaps show as \"unanswered\" instead of weaknesses." },
      { title: "Honest readiness", text: "The workspace separates what is proven from what still needs live verification, giving the client a clear checklist before rollout." },
    ],
    takeaways: [
      { title: "Put the gates in the data layer", text: "Unique indexes, locks and idempotency keys did more for call safety than any confirmation dialog could." },
      { title: "Make AI output extractive", text: "Requiring every answer to cite an exact transcript quote kept summaries trustworthy and easy to audit." },
      { title: "Build to the provider's real behaviour", text: "Live test calls exposed behaviour the documentation did not, and each defect became a regression test before it was fixed." },
    ],
  },
];

export const getPortfolioProject = (slug: string) => PORTFOLIO.find((p) => p.slug === slug);
