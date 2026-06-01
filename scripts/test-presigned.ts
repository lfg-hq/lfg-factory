// Smoke-test the presigned GET URL helper against real S3.
import { getPresignedGetUrl } from "../src/services/s3.ts";
import { db } from "../src/config/db.ts";
import { agentDataFiles } from "../src/db/schema/agents.ts";
import { isNotNull } from "drizzle-orm";

const [row] = await db
  .select()
  .from(agentDataFiles)
  .where(isNotNull(agentDataFiles.s3Key))
  .limit(1);

if (!row || !row.s3Key) {
  console.log("[probe] no S3-backed Data Room file to test with — upload one first");
  process.exit(0);
}

console.log(`[probe] presigning ${row.fileName} (${row.s3Key})`);
const url = await getPresignedGetUrl(row.s3Key, 60);
console.log(`[probe] url: ${url}\n`);

const proc = Bun.spawnSync(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}\\n%{size_download}\\n", url]);
const out = proc.stdout.toString().split("\n");
console.log(`[probe] HTTP status: ${out[0]}, size_download: ${out[1]} bytes`);

if (out[0] !== "200") {
  const body = Bun.spawnSync(["curl", "-s", url]);
  console.log(`[probe] body:`, body.stdout.toString());
}

process.exit(0);
