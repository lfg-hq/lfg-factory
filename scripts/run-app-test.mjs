/**
 * Run the Instant App Tester against an EXISTING live app (no rebuild needed).
 *
 *   set -a; . ./.env; set +a; bun scripts/run-app-test.mjs <appId>
 *
 * <appId> is the id in the URL: /instant/app/<appId>.
 * Visits every static screen via a Mags cloud browser, screenshots each, prints
 * pass/fail, saves shots to uploads/instant-tests/<appId>/, and writes the report
 * to instantApps.metadata.testReport. (WS broadcasts no-op from a script — that's
 * expected; check the console output + uploads + DB.)
 */
import { eq } from "drizzle-orm";
import { db } from "../src/config/db.ts";
import { instantApps } from "../src/db/schema/instant.ts";
import { sandboxes } from "../src/db/schema/sandbox.ts";
import { testInstantApp } from "../src/services/instant-tester.ts";

const appId = process.argv[2];
if (!appId) {
  console.error("usage: set -a; . ./.env; set +a; bun scripts/run-app-test.mjs <appId>");
  process.exit(1);
}

const [row] = await db
  .select({ app: instantApps, sandbox: sandboxes })
  .from(instantApps)
  .leftJoin(sandboxes, eq(instantApps.sandboxId, sandboxes.id))
  .where(eq(instantApps.appId, appId))
  .limit(1);

if (!row?.app) { console.error(`App ${appId} not found`); process.exit(1); }
if (!row.sandbox?.magsWorkspaceId) { console.error("App has no live workspace — build it first"); process.exit(1); }
if (!row.app.previewUrl) { console.error("App has no preview URL — build it first"); process.exit(1); }

console.log(`Testing ${row.app.name} (${appId}) at ${row.app.previewUrl} …`);
await testInstantApp({
  appId: row.app.appId,
  appDbId: row.app.id,
  userId: row.app.userId,
  conversationId: row.app.conversationId,
  appName: row.app.name,
  previewUrl: row.app.previewUrl,
  buildWorkspaceId: row.sandbox.magsWorkspaceId,
});

console.log(`\nDone. Screenshots: uploads/instant-tests/${row.app.appId}/  |  report: instantApps.metadata.testReport`);
process.exit(0);
