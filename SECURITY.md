# Security policy

## Reporting a vulnerability

Please report security issues **privately** to <hello@lfg.run> rather than opening
a public issue. Include what you found, how to reproduce it, and the impact you
think it has. We will acknowledge your report and keep you updated on the fix.

Please give us reasonable time to ship a fix before disclosing publicly. We are
happy to credit you in the release notes unless you would rather stay anonymous.

## Supported versions

LFG is actively developed and released from `main`. Security fixes land on `main`;
there are no long-term support branches today.

## Deploying LFG safely

If you self-host, these are the settings that matter most:

- **Set `ENCRYPTION_KEY`.** Per-user secrets (API keys, OAuth tokens, agent env
  vars) are encrypted with AES-256-GCM. Without the key the app refuses to store
  them in production at all.
- **Set a strong `BETTER_AUTH_SECRET`** (`openssl rand -hex 32`) and a correct
  `BETTER_AUTH_URL`. The URL is the trusted origin for authenticated requests.
- **Terminate TLS and rate-limit at a reverse proxy.** The app rate-limits only
  its public landing-page endpoints; authentication and AI endpoints are not
  rate-limited in-process.
- **Treat sandboxes as the trust boundary.** AI-generated code runs inside a Mags
  micro-VM or a Docker container, never on the host. Don't relax that.
- **The `/preview-proxy/*` "in-app links" mode is same-origin by design** — the
  previewed app's JavaScript runs on the LFG origin. It is restricted to project
  members; prefer the direct preview for code you don't trust.
- **Uploaded files under `/uploads` and `/storage` are served without an auth
  check**, addressed by unguessable random keys. If you need per-user
  authorization on binaries, front them with `/api/files/:id`, which does check
  conversation ownership, and don't expose the static mounts publicly.
- **Never commit real secrets.** `.env`, `config/deploy.yml`, and `.kamal/secrets`
  are gitignored; copy the `example.env` / `*.example` templates instead.
