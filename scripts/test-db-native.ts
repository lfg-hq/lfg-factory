/**
 * Lean single-sandbox test: native MariaDB (no docker) co-located with a Python
 * app, data on the persistent workspace (/root), across stop → respawn.
 * Validates the single-sandbox-per-project model.
 *   bun scripts/test-db-native.ts        |  bun scripts/test-db-native.ts clean
 */
import { newWorkspace, execOnWorkspace, stopWorkspace, deleteWorkspace } from "../src/services/mags.ts";

const WS = "test-db-native";
const PW = "Test1234Persist!";
const DATADIR = "/root/dbdata";

async function sh(cmd: string, timeout = 110_000): Promise<string> {
  const r = await execOnWorkspace(WS, cmd, { timeout }).catch((e: any) => ({ output: "", stderr: e.message, exitCode: -1 }));
  const out = ((r.output || "") + (r.stderr ? "\n[err] " + r.stderr : "")).trim();
  return out;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startMaria(): Promise<void> {
  console.log(await sh(`apk add --no-cache mariadb mariadb-client 2>&1 | tail -1`, 180_000));
  await sh(`mkdir -p /run/mysqld ${DATADIR} && chmod 711 /root && chown -R mysql:mysql /run/mysqld ${DATADIR}`);
  console.log(await sh(
    `if [ -d ${DATADIR}/mysql ]; then echo EXISTING-DATADIR; else mariadb-install-db --user=mysql --datadir=${DATADIR} --auth-root-authentication-method=normal 2>&1 | tail -1; fi`,
    120_000
  ));
  await sh(`pkill mariadbd 2>/dev/null; sleep 1; (setsid mariadbd --user=mysql --datadir=${DATADIR} --socket=/run/mysqld/mysqld.sock --skip-networking=0 --bind-address=127.0.0.1 --port=3306 >/root/maria.log 2>&1 &); echo launched`);
  console.log(await sh(`for i in $(seq 1 30); do mariadb-admin ping --socket=/run/mysqld/mysqld.sock 2>/dev/null | grep -q alive && echo READY && break; sleep 2; done; tail -2 /root/maria.log`, 90_000));
  await sh(`mariadb --socket=/run/mysqld/mysqld.sock -e "CREATE DATABASE IF NOT EXISTS app; CREATE USER IF NOT EXISTS 'app'@'127.0.0.1' IDENTIFIED BY '${PW}'; GRANT ALL ON app.* TO 'app'@'127.0.0.1'; FLUSH PRIVILEGES;" 2>&1 | tail -1`);
}
async function py(script: string): Promise<string> {
  await sh(`python3 -c "import pymysql" 2>/dev/null || pip3 install -q --break-system-packages pymysql 2>&1 | tail -1`, 120_000);
  return await sh(`python3 - <<'PY'\n${script}\nPY`, 60_000);
}

async function main() {
  if (process.argv[2] === "clean") { await stopWorkspace(WS).catch(() => {}); await deleteWorkspace(WS).catch(() => {}); console.log("cleaned"); return; }

  console.log("=== PHASE 1: create sandbox + start MariaDB ===");
  await deleteWorkspace(WS).catch(() => {});
  await newWorkspace(WS, { memGb: 4, diskGb: 20, keepAlive: true });
  await startMaria();

  console.log("\n=== PHASE 2: app inserts a row ===");
  console.log(await py(
    `import pymysql\nc=pymysql.connect(host='127.0.0.1',port=3306,user='app',password='${PW}',database='app')\ncur=c.cursor()\n` +
    `cur.execute("CREATE TABLE IF NOT EXISTS notes(id INT AUTO_INCREMENT PRIMARY KEY, body TEXT)")\n` +
    `cur.execute("INSERT INTO notes(body) VALUES(%s)", ("row-BEFORE-STOP",))\nc.commit()\n` +
    `cur.execute("SELECT COUNT(*) FROM notes"); print("rows after insert:", cur.fetchone()[0])`));

  console.log("\n=== PHASE 3: shutdown + stop sandbox ===");
  await sh(`mariadb-admin --socket=/run/mysqld/mysqld.sock shutdown 2>/dev/null; sync; echo flushed`);
  await sleep(3000);
  await stopWorkspace(WS);
  console.log(">>> stopped. waiting 45s…");
  await sleep(45_000);

  console.log("\n=== PHASE 4: respawn + restart MariaDB on same datadir ===");
  await newWorkspace(WS, { memGb: 4, diskGb: 20, keepAlive: true });
  console.log("datadir after respawn:\n" + await sh(`ls ${DATADIR}/app 2>/dev/null; ls -la ${DATADIR} 2>/dev/null | head -3`));
  await startMaria();

  console.log("\n=== PHASE 5: read back ===");
  console.log(await py(
    `import pymysql\nc=pymysql.connect(host='127.0.0.1',port=3306,user='app',password='${PW}',database='app')\ncur=c.cursor()\n` +
    `cur.execute("SELECT id, body FROM notes"); rows=cur.fetchall()\nprint("rows after respawn:", rows)\n` +
    `print("\\n=== PERSISTENCE:", "PASS" if any('BEFORE-STOP' in (r[1] or '') for r in rows) else "FAIL", "===")`));

  console.log("\nDone. Clean: bun scripts/test-db-native.ts clean");
}
main().catch((e) => { console.error("FATAL:", e.message || e); process.exit(1); });
