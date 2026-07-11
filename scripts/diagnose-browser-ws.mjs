/**
 * Diagnose the QA cloud-browser connection from THIS machine/network.
 * Distinguishes "egress proxy blocking WS upgrades" from "dead VM".
 *
 *   set -a; . ./.env; set +a; bun scripts/diagnose-browser-ws.mjs
 *
 * Interpretation:
 *   - HTTP ok + WSS OPEN     → network fine; issue is Playwright-specific.
 *   - HTTP ok + WSS hang/fail → egress proxy blocking the WS Upgrade (network fix).
 *   - both fail              → the browser VM is dead/slept (lifecycle).
 */
import Mags from "@magpiecloud/mags";

if (!process.env.MAGS_API_TOKEN) {
  console.error("MAGS_API_TOKEN not set — run: set -a; . ./.env; set +a; bun scripts/diagnose-browser-ws.mjs");
  process.exit(1);
}

const c = new Mags({ apiToken: process.env.MAGS_API_TOKEN });
console.log("Booting browser session…");
const { requestId, wsEndpoint, cdpHttpUrl } = await c.browser({ timeout: 120_000 });
console.log("resolved wsEndpoint:", wsEndpoint);

// 1) HTTPS reachable?
try {
  const r = await fetch(cdpHttpUrl.replace(/\/+$/, "") + "/json/version").then((x) => x.json());
  console.log("✅ HTTP ok — Browser:", r.Browser);
} catch (e) {
  console.log("❌ HTTP failed:", e.message, "→ VM likely dead/slept");
}

// 2) WSS upgrade reachable?
await new Promise((resolve) => {
  const ws = new WebSocket(wsEndpoint);
  const finish = (msg) => { console.log(msg); try { ws.close(); } catch {} resolve(); };
  const t = setTimeout(() => finish("❌ WSS TIMEOUT (no open in 30s) → egress proxy blocking WS upgrade, or VM not listening"), 30_000);
  ws.addEventListener("open", () => { clearTimeout(t); finish("✅ WSS OPEN — network is fine; issue is Playwright-specific"); });
  ws.addEventListener("error", (e) => { clearTimeout(t); finish("❌ WSS FAILED: " + (e.message || e.type) + " → egress proxy or dead VM"); });
});

await c.stop(requestId).catch(() => {});
console.log("Browser VM stopped.");
process.exit(0);
