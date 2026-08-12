# Contributing to LFG

Thanks for your interest in improving LFG! This guide covers how to get set up and
what we look for in a contribution.

## Getting started

1. Fork and clone the repo.
2. Install [Bun](https://bun.sh) ≥ 1.2.
3. Install dependencies and set up your environment:
   ```bash
   bun install
   cp example.env .env      # fill in BETTER_AUTH_SECRET, BETTER_AUTH_URL, an AI key
   bun run dev
   ```
   The default config (SQLite + local file storage) needs no external services.

See the [README](README.md) for the full configuration and architecture overview.

## Development workflow

- **Branch** off `main` for your change: `git checkout -b fix/short-description`.
- **Type-check before every commit** — this is our primary gate:
  ```bash
  bun run typecheck
  ```
  The project uses a strict `tsconfig` (`noUncheckedIndexedAccess`, etc.). Please
  keep `as any` / `@ts-ignore` to a minimum and comment why when unavoidable.
- **Keep changes focused.** One logical change per PR is much easier to review.
- **Match the surrounding style** — naming, error handling, and comment density.
  Files use kebab-case; functions camelCase; interfaces are `PascalCase` with
  `Input`/`Result` suffixes where it helps.

## Database changes

Schema lives in `src/db/schema/` with **parallel SQLite and Postgres definitions**.
If you change one, change the other to match, then regenerate migrations:

```bash
bun run db:generate     # create a migration from schema changes
bun run db:push         # apply to your local DB
```

## Sandboxes

Code that executes AI-generated projects goes through the sandbox facade
(`src/services/mags.ts`), which dispatches to either the Mags or Docker backend in
`src/services/sandbox/`. If you add a capability, add it to **both** backends and to
the `SandboxBackend` interface in `src/services/sandbox/types.ts`.

⚠️ AI-generated / user-influenced code must only ever run **inside a sandbox**, never
on the host. Validate any value interpolated into a shell command.

## Submitting a pull request

1. Ensure `bun run typecheck` passes.
2. Write a clear PR description: what changed, why, and how you tested it.
3. Link any related issue.

## Reporting bugs & security issues

- **Bugs:** open an issue with reproduction steps, expected vs. actual behavior, and
  your environment (OS, Bun version, sandbox backend).
- **Security vulnerabilities:** please report privately rather than opening a public
  issue, so we can address them before disclosure.

## License

By contributing, you agree that your contributions will be licensed under the
project's [MIT License](LICENSE).
