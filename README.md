# LFG

**LFG** is an AI product-development platform. You describe what you want; AI agents
scaffold, build, and iterate on real applications inside isolated sandboxes — with
live previews, a ticket-based execution workflow, and real-time streaming of every
step. It ships two flagship flows:

- **Instant** — go from a prompt to a running, previewable web app in a single pass.
- **Tickets** — break work into tickets and let coding agents (Claude Code / pi)
  execute them in sandboxes, with human review between the steps that matter.

The intent is a delivery pipeline you can watch, not a black box: requirements,
plan, tickets, and every agent step are visible and reviewable, the code lands in
your own repositories, and a human approves the decisions that count.

It runs on **Bun + Hono + TypeScript**, server-renders its UI, streams over
WebSockets, and speaks to Anthropic / OpenAI / Google models via the Vercel AI SDK.

### Scope — what this is and isn't

Being straight with you, because it matters more than a pitch:

- Agents write **real, runnable code** and you get a live preview. What they
  produce still needs human review before it ships — the ticket flow is built
  around that assumption, not around removing it.
- Output quality tracks the **underlying model** and the clarity of the request.
  This is orchestration, sandboxing, and workflow around frontier models; it is
  not a model of our own.
- It is **actively developed**. Expect rough edges, and read the code before you
  put it in front of a customer.
- Your code, repositories, and model accounts stay yours. LFG has no telemetry
  and does not phone home.

---

## Table of contents

- [Stack](#stack)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Sandbox backends (Docker for local, Mags for hosted)](#sandbox-backends)
- [File storage (local vs S3)](#file-storage)
- [Email & integrations](#email--integrations)
- [Deployment](#deployment)
- [Project structure](#project-structure)
- [Security](#security)
- [Contributing](#contributing)
- [License](#license) · [Trademark policy](TRADEMARK.md)

## Stack

| Concern            | Choice                                             |
| ------------------ | -------------------------------------------------- |
| Runtime            | [Bun](https://bun.sh)                              |
| Web framework      | [Hono](https://hono.dev)                           |
| ORM / migrations   | [Drizzle](https://orm.drizzle.team) (SQLite + Postgres) |
| Auth               | [better-auth](https://www.better-auth.com)        |
| AI                 | [Vercel AI SDK](https://sdk.vercel.ai) + `@ai-sdk/{anthropic,openai,google}` |
| Sandboxes          | [Magpie Cloud (mags)](https://www.npmjs.com/package/@magpiecloud/mags) **or** Docker |
| Browser automation | Playwright (CDP)                                   |

## Quick start

**Prerequisites:** [Bun](https://bun.sh) ≥ 1.2 to run the server — the default config
uses SQLite and local file storage, so no external database is required. To actually
*build* apps you also need Docker (for local sandboxes) and at least one AI provider
key; see [Sandbox backends](#sandbox-backends).

```bash
git clone <your-fork-url> lfg && cd lfg
bun install

cp example.env .env
# Edit .env — the minimum to boot:
#   BETTER_AUTH_SECRET   (openssl rand -hex 32)
#   BETTER_AUTH_URL      (http://localhost:3000)
#   ANTHROPIC_API_KEY    (or another AI provider key)
#
# For local development, also switch the sandbox backend to Docker:
#   SANDBOX_BACKEND=docker
# The default is `mags`, a hosted service that needs an API token. Docker runs
# sandboxes on your own machine with no third-party account. See below.

bun run dev
```

`bun run dev` runs Drizzle migrations against the SQLite DB (`./data/lfg.db`) and
starts the server with hot reload on <http://localhost:3000>.

Useful scripts:

```bash
bun run typecheck     # tsc --noEmit
bun run db:studio     # Drizzle Studio (browse the DB)
bun run db:push       # apply schema to the DB
```

> **Note:** the app writes to `./data` (SQLite DB + local uploads) and `./uploads`.
> Make sure the process has **write permissions** to the working directory.

## Configuration

All configuration is via environment variables — see **[`example.env`](example.env)**
for the fully-annotated list. Config is validated at startup by
[`src/config/env.ts`](src/config/env.ts) (Zod); a missing required value fails fast.

The only hard-required values are `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`.
Everything else is optional and feature-gated — the corresponding feature simply
stays off until you provide its key.

## Sandbox backends

Instant builds and ticket execution run coding agents inside **isolated sandboxes**.
Pick a backend with `SANDBOX_BACKEND`:

| Backend  | Default | Use it for                        | Needs                       |
| -------- | ------- | --------------------------------- | --------------------------- |
| `docker` |         | **local dev and self-hosting**    | Docker installed locally    |
| `mags`   | ✓       | hosted deploys you don't operate  | a Magpie Cloud API token    |

> **Running locally? Set `SANDBOX_BACKEND=docker`.** The built-in default is `mags`,
> which calls a hosted third-party service and will fail without `MAGS_API_TOKEN`.
> Docker keeps everything on your own machine and needs no external account.

### `docker` (local dev + self-hosting)

Runs each sandbox as a local **Docker container** — ideal for running LFG entirely
on your own machine or server, with no third-party sandbox provider.

1. **Install Docker** (if needed): `./scripts/setup-docker.sh` (or
   <https://docs.docker.com/engine/install/>). The app also prints setup guidance if
   it can't find Docker at runtime.
2. **Build the sandbox image** once — it bundles Node 22, Python 3, and the coding
   agents (`claude-code` + `pi`) so container starts are fast:
   ```bash
   ./scripts/build-sandbox-image.sh youruser/lfg-sandbox:latest --push
   ```
3. **Configure `.env`:**
   ```bash
   SANDBOX_BACKEND=docker
   SANDBOX_IMAGE=youruser/lfg-sandbox:latest
   SANDBOX_DOCKER_NETWORK=bridge        # default (macOS + Linux)
   SANDBOX_APP_PORT=8080                # app's port inside the container
   SANDBOX_PREVIEW_HOST=http://localhost
   ```

Each sandbox is a network-isolated container (like a VM): the app binds
`SANDBOX_APP_PORT` (8080) *inside* its own container, and Docker publishes that to a
**unique auto-assigned host port**, so many apps run concurrently with no collisions.
Preview URLs look like `http://localhost:49153` — reachable from the LFG host / a
browser on the same machine, and shareable off-host only via a tunnel. (Set
`SANDBOX_DOCKER_NETWORK=host` for direct host-port binding on Linux; use the `mags`
backend if you need public preview URLs out of the box.)

The image is defined in [`Dockerfile.sandbox`](Dockerfile.sandbox) — add language
runtimes there as your generated stacks require.

### `mags` (hosted — the built-in default)

Uses [Magpie Cloud](https://www.npmjs.com/package/@magpiecloud/mags) Firecracker
micro-VMs. Set `MAGS_API_TOKEN`. Best for a hosted deployment where you don't want
to manage compute, and it gives you public preview URLs without a tunnel. It is a
third-party paid service and is **not** required to run LFG — use `docker` if you
would rather keep sandboxes on your own hardware.

```bash
SANDBOX_BACKEND=mags
MAGS_API_TOKEN=your_token_here
```

## File storage

Set with `FILE_STORAGE_TYPE`:

- **`local`** (default) — binary uploads are written under `LOCAL_STORAGE_DIR`
  (default `./data/uploads`, **must be writable**) and served back at `/storage/<key>`.
  Text content lives in the database. Zero setup.
- **`s3`** — uploads go to AWS S3. Set `AWS_S3_BUCKET_NAME`, `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `AWS_S3_REGION`.

## Email & integrations

- **Email — SendGrid.** Transactional email (verification, invitations) is sent via
  SendGrid. Create a free account at <https://signup.sendgrid.com>, then
  **Settings → API Keys → Create API Key** (with *Mail Send* permission) and set
  `SENDGRID_API_KEY`. Verify a sender or domain under **Settings → Sender
  Authentication**, and set `EMAIL_FROM` to that address. Without a key, emails are
  logged to the console in development instead of being sent.
### Composio — required for agent integrations

LFG's agents use [**Composio**](https://composio.dev) to call third-party tools
(Gmail, Slack, GitHub, Notion, Linear, …). If you want your agent to act on
external apps, you'll need a Composio key — it has a **free tier**.

1. Sign up at <https://app.composio.dev> (free).
2. Create an API key under **Settings → API Keys** and set it in `.env`:
   ```bash
   COMPOSIO_API_KEY=your_key_here
   ```
3. **Connect the apps** your agent should use from the Composio dashboard
   (**Apps → Connect**, e.g. authorize Gmail/Slack). Your agent can then invoke
   those tools during a run. Without a key, the core build/ticket flows still work —
   only the external-integration tool-calls are disabled.

## Deployment

Production uses [Kamal](https://kamal-deploy.org) with the app `Dockerfile` (Postgres
recommended: `DATABASE_DRIVER=postgresql`). Templates are provided:

```bash
cp config/deploy.yml.example config/deploy.yml   # fill in your server IP / registry
cp .kamal/secrets.example .kamal/secrets         # pulls values from your env
./node_deploy.sh setup                           # first-time
./node_deploy.sh                                 # deploy
```

The real `config/deploy.yml` and `.kamal/secrets` are gitignored so your infra stays
private.

## Project structure

```
src/
  index.ts        # server entrypoint — middleware, routes, WS, static, workers
  routes/         # page routes (SSR) and routes/api/* (JSON APIs)
  services/       # domain logic (git, instant-app, dev-preview, sandbox, storage…)
    sandbox/      # sandbox backends: mags-backend.ts, docker-backend.ts, types.ts
  ai/             # providers, prompts, tools, and design/impl knowledge base
  db/schema/      # Drizzle schemas (parallel sqlite/ and pg/ definitions)
  ws/             # WebSocket chat handlers
  templates/      # server-rendered pages/components (hono/html)
  workers/        # background workers (ticket execution)
scripts/          # dev/build helpers (build-sandbox-image.sh, setup-docker.sh, …)
drizzle/          # generated migrations
```

## Security

- Never commit real secrets. `.env`, `config/deploy.yml`, and `.kamal/secrets` are
  gitignored; use the `example.env` / `*.example` templates.
- Set `ENCRYPTION_KEY` in production — the app refuses to store per-user secrets
  unencrypted when `NODE_ENV=production`.
- AI-generated code only ever runs **inside a sandbox** (Mags micro-VM or Docker
  container), never on the host.
- **The "in-app links" preview proxy is same-origin by design.** `/preview-proxy/*`
  serves the sandboxed app from LFG's own origin so links stay inside the panel,
  which means that app's JavaScript runs on the LFG origin. It is access-controlled
  to project members, but treat it as trusted-user-only and prefer the direct
  (non-proxied) preview when previewing code you don't trust.
- Multi-tenant deployments should sit behind a reverse proxy that terminates TLS
  and applies rate limiting; the app itself only rate-limits the public
  landing-page endpoints.

Found a vulnerability? Please report it privately to <hello@lfg.run> rather than
opening a public issue.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). PRs welcome — please run `bun run typecheck`
before submitting.

## License

LFG is **[MIT licensed](LICENSE)**.

**Self-use is free and ungated.** Run it for yourself, your team, or your company,
on any infrastructure, commercially, with no seat limit and no call-home. Read it,
fork it, modify it, and redistribute it under the MIT terms. You do not need to ask
us, and there is nothing to sign.

**The LFG name and logo are trademarks and are not covered by the MIT grant** —
MIT licenses copyright, not brand. If you ship LFG to other people under *your* own
branding, that is fine and needs no permission: remove our marks and use yours.
What needs written permission is presenting a product or service as "LFG", or
implying that your build is official or endorsed. See **[TRADEMARK.md](TRADEMARK.md)**
for the full policy, including the nominative uses ("built on LFG") that are always
allowed.

**White-label.** If you want to deliver LFG to your customers under your own brand
*with our involvement* — branded builds, a managed instance we operate, written
trademark permission, upgrade support, and commercial terms your procurement team
can sign — that arrangement is available on request:
<hello@lfg.run> or <https://lfg.run/white-label/>.

Third-party dependencies keep their own licenses; see `package.json` and the
lockfile.
