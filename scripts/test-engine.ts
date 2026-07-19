/**
 * Live validation of the project-sandbox engine recipes (always-on model):
 * bring up mysql + redis in one sandbox and connect to each over localhost.
 *   bun scripts/test-engine.ts   |   bun scripts/test-engine.ts clean
 */
import { newWorkspace, execOnWorkspace, deleteWorkspace } from "../src/services/mags.ts";
import { ENGINES } from "../src/services/project-sandbox.ts";

const WS = "env-livetest";
const PW = "Lptestpassword1234x";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function sh(c: string, t = 100_000) { const r = await execOnWorkspace(WS, c, { timeout: t }).catch((e: any) => ({ output: "", stderr: e.message })); return ((r.output || "") + (r.stderr ? "\n[err]" + r.stderr : "")).trim(); }

async function bring(engine: "mysql" | "redis" | "postgres") {
  const script = ENGINES[engine].bringup(PW);
  await sh(`cat > /root/bu-${engine}.sh <<'EOSH'\n${script}\nEOSH\n: > /root/bu-${engine}.log; nohup sh /root/bu-${engine}.sh >> /root/bu-${engine}.log 2>&1 & echo launched`, 60_000);
  for (let i = 0; i < 24; i++) {
    await sleep(8000);
    const tail = await sh(`tail -1 /root/bu-${engine}.log`, 30_000);
    console.log(`  [${engine} ${(i + 1) * 8}s] ${tail.slice(0, 70)}`);
    if (tail.includes("ENGINE_READY")) return true;
    if (tail.includes("ENGINE_ERROR")) return false;
  }
  return false;
}

async function main() {
  if (process.argv[2] === "clean") { await deleteWorkspace(WS).catch(() => {}); console.log("cleaned"); return; }
  await deleteWorkspace(WS).catch(() => {});
  console.log("=== create always-on sandbox ===");
  await newWorkspace(WS, { memGb: 4, diskGb: 20, keepAlive: true });

  console.log("\n=== bring up mysql ===");
  const okMy = await bring("mysql");
  console.log("mysql ready:", okMy);
  if (okMy) {
    await sh(`python3 -c "import pymysql" 2>/dev/null || pip3 install -q --break-system-packages pymysql 2>&1 | tail -1`, 120_000);
    console.log(await sh(`python3 - <<'PY'\nimport pymysql\nc=pymysql.connect(host='127.0.0.1',port=3306,user='app',password='${PW}',database='app')\ncur=c.cursor();cur.execute("CREATE TABLE IF NOT EXISTS t(x INT); INSERT INTO t VALUES(42)");c.commit();cur.execute("SELECT x FROM t");print("MYSQL_OK rows:",cur.fetchall())\nPY`, 60_000));
  }

  console.log("\n=== bring up redis ===");
  const okR = await bring("redis");
  console.log("redis ready:", okR);
  if (okR) console.log(await sh(`redis-cli -a '${PW}' set k hello 2>/dev/null; redis-cli -a '${PW}' get k 2>/dev/null | sed 's/^/REDIS_OK: /'`));

  console.log(`\n=== SUMMARY: mysql=${okMy ? "PASS" : "FAIL"} redis=${okR ? "PASS" : "FAIL"} ===`);
  console.log("Clean: bun scripts/test-engine.ts clean");
}
main().catch((e) => { console.error("FATAL:", e.message || e); process.exit(1); });
