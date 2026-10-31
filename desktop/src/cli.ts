#!/usr/bin/env node
/**
 * Headless LFG runner, for a Linux box or a quick test without the desktop app.
 *
 *   lfg-runner --server https://lfg.example.com --token lfgr_… [--auto-approve] [--work-root ~/LFG]
 *
 * Without --auto-approve every job is declined, since there's nobody to ask.
 */
import { Runner, defaultWorkRoot } from "./runner.ts";
import { nodeSocketFactory } from "./socket.ts";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const server = flag("server") ?? process.env.LFG_SERVER_URL;
const token = flag("token") ?? process.env.LFG_RUNNER_TOKEN;
if (!server || !token) {
  console.error("Usage: lfg-runner --server <url> --token <lfgr_…> [--auto-approve] [--work-root <dir>]");
  process.exit(2);
}
const autoApprove = args.includes("--auto-approve");

const runner = new Runner({
  serverUrl: server,
  token,
  workRoot: flag("work-root") ?? defaultWorkRoot(),
  createSocket: nodeSocketFactory,
  appVersion: "cli",
  approve: async () => autoApprove ? { approved: true } : { approved: false, reason: "Headless runner without --auto-approve" },
  onState: (state, detail) => {
    console.log(`[lfg-runner] ${state}${detail ? `: ${detail}` : ""}`);
    if (state === "unauthorized") process.exit(1);
  },
  onJob: e => console.log(`[lfg-runner] ${e.phase}: ${e.title}${e.detail ? ` (${e.detail})` : ""}`),
  log: line => console.log(line),
});
runner.start();
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { runner.stop(); process.exit(0); });
