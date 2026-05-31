// One-shot probe — runs the exact listConnectors call routes/agents.ts uses,
// outside the HTTP path, so we can see what Composio returns for this user
// without restarting the dev server or chasing renders.
import { listConnectors } from "../src/services/composio-manager.ts";

const userId = process.argv[2] ?? "pwz8nrH31tg3hv3Zv9CI7op94lRgaFfQ";

console.log(`[probe] calling listConnectors(${userId}, filter=all, limit=50)...`);
const result = await listConnectors(userId, { filter: "all", limit: 50 });
const connected = result.items.filter((t: any) => t.isConnected);

console.log(`[probe] total items returned: ${result.items.length}`);
console.log(`[probe] items with isConnected=true: ${connected.length}`);
console.log(`[probe] connected slugs: ${connected.map((t: any) => t.slug).join(", ") || "(none)"}`);
console.log(`[probe] first 5 items raw:`);
console.log(JSON.stringify(result.items.slice(0, 5), null, 2));

process.exit(0);
