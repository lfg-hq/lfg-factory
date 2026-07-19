/**
 * Live Mags test — MySQL (docker) data persistence across stop → respawn.
 *
 * Sandbox facts (probed): Alpine, no docker by default, no cgroups mounted,
 * /data is the only persistent volume (S3-synced). Docker DOES work once
 * cgroups are mounted. Since the rootfs is ephemeral, each wake re-installs
 * docker and re-loads the mysql image FROM /data (saved on first pull → no
 * re-pull). The DB data dir lives on /data so it survives reaping.
 *
 * Run:   bun scripts/test-db-persist.ts
 * Clean: bun scripts/test-db-persist.ts clean
 */
import { newWorkspace, execOnWorkspace, stopWorkspace, deleteWorkspace } from "../src/services/mags.ts";

const WS = "test-mysql-persist";
const PW = "Test1234Persist!";

// Idempotent bring-up: cgroups → docker → dockerd → mysql image (load from
// /data or pull+save) → run mysql on the persistent /root/mysql. Stored on
// /data so it survives respawn; run in the background with a done-marker.
const BRINGUP = `#!/bin/sh
echo "[bringup] $(date)"
if [ ! -e /sys/fs/cgroup/cgroup.procs ]; then mkdir -p /sys/fs/cgroup; mount -t cgroup2 none /sys/fs/cgroup 2>/dev/null || true; fi
command -v docker >/dev/null 2>&1 || { echo "[bringup] installing docker"; apk add --no-cache docker >/dev/null 2>&1; }
pgrep dockerd >/dev/null 2>&1 || { echo "[bringup] starting dockerd"; setsid dockerd --storage-driver=vfs --iptables=false >/root/dockerd.log 2>&1 & sleep 8; }
for i in $(seq 1 20); do docker info >/dev/null 2>&1 && break; sleep 2; done
docker info >/dev/null 2>&1 || { echo "[bringup] DOCKER_FAILED"; exit 1; }
if [ -f /root/mysql8.tar ]; then echo "[bringup] loading mysql image from /data"; docker load -i /root/mysql8.tar >/dev/null 2>&1 || true; fi
if ! docker image inspect mysql:8 >/dev/null 2>&1; then echo "[bringup] pulling mysql:8"; docker pull mysql:8 >/dev/null 2>&1 && docker save mysql:8 -o /root/mysql8.tar; fi
docker rm -f mydb >/dev/null 2>&1
echo "[bringup] starting mysql container"
docker run -d --name mydb -e MYSQL_ROOT_PASSWORD='${PW}' -e MYSQL_DATABASE=app -v /root/mysql:/var/lib/mysql -p 3306:3306 mysql:8 >/dev/null 2>&1
for i in $(seq 1 60); do docker exec mydb mysqladmin ping -uroot -p'${PW}' 2>/dev/null | grep -q alive && break; sleep 3; done
docker exec mydb mysqladmin ping -uroot -p'${PW}' 2>/dev/null | grep -q alive && echo BRINGUP_DONE || echo BRINGUP_MYSQL_TIMEOUT
`;

async function sh(cmd: string, timeout = 110_000): Promise<string> {
  const r = await execOnWorkspace(WS, cmd, { timeout }).catch((e: any) => ({ output: "", stderr: e.message, exitCode: -1 }));
  return ((r.output || "") + (r.stderr ? "\n[err] " + r.stderr : "")).trim();
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function bringUp(): Promise<void> {
  // write bringup script to /data (persists), launch in background
  await sh(`cat > /root/bringup.sh <<'EOSH'\n${BRINGUP}\nEOSH\nchmod +x /root/bringup.sh`);
  await sh(`: > /root/bringup.log; nohup sh /root/bringup.sh >> /root/bringup.log 2>&1 & echo launched`);
  console.log(">>> bring-up running in background, polling…");
  for (let i = 0; i < 40; i++) {
    await sleep(15_000);
    const log = await sh(`tail -3 /root/bringup.log`);
    const last = log.split("\n").pop() || "";
    console.log(`   [${(i + 1) * 15}s] ${last.slice(0, 90)}`);
    if (log.includes("BRINGUP_DONE")) { console.log(">>> MySQL up."); return; }
    if (log.includes("BRINGUP_MYSQL_TIMEOUT") || log.includes("DOCKER_FAILED")) throw new Error("bring-up failed: " + log);
  }
  throw new Error("bring-up timed out");
}

async function py(script: string): Promise<string> {
  await sh(`python3 -c "import pymysql" 2>/dev/null || pip3 install -q --break-system-packages pymysql 2>&1 | tail -1`, 120_000);
  return await sh(`python3 - <<'PY'\n${script}\nPY`, 60_000);
}

async function main() {
  if (process.argv[2] === "clean") {
    await stopWorkspace(WS).catch(() => {});
    await deleteWorkspace(WS).catch(() => {});
    console.log("cleaned " + WS);
    return;
  }

  console.log("=== PHASE 1: create sandbox + bring up MySQL ===");
  await deleteWorkspace(WS).catch(() => {});
  await newWorkspace(WS, { memGb: 4, diskGb: 20, keepAlive: true });
  await bringUp();

  console.log("\n=== PHASE 2: app inserts a row ===");
  console.log(
    await py(
      `import pymysql\n` +
        `c=pymysql.connect(host='127.0.0.1',port=3306,user='root',password='${PW}',database='app')\n` +
        `cur=c.cursor()\n` +
        `cur.execute("CREATE TABLE IF NOT EXISTS notes(id INT AUTO_INCREMENT PRIMARY KEY, body TEXT)")\n` +
        `cur.execute("INSERT INTO notes(body) VALUES(%s)", ("row-BEFORE-STOP",))\n` +
        `c.commit(); cur.execute("SELECT COUNT(*) FROM notes"); print("rows after insert:", cur.fetchone()[0])`
    )
  );

  console.log("\n=== PHASE 3: flush + stop sandbox ===");
  await sh(`docker exec mydb mysql -uroot -p'${PW}' -e "FLUSH TABLES" 2>/dev/null; docker stop mydb 2>/dev/null; sync; echo stopped-mysql`);
  await sleep(4000);
  await stopWorkspace(WS);
  console.log(">>> sandbox stopped. waiting 60s (idle-reap window)…");
  await sleep(60_000);

  console.log("\n=== PHASE 4: respawn same workspace (S3 remount) + bring up ===");
  await newWorkspace(WS, { memGb: 4, diskGb: 20, keepAlive: true });
  console.log("datadir after respawn:\n" + (await sh(`ls -la /root/mysql 2>/dev/null | head -5; echo; [ -f /root/mysql8.tar ] && echo "image tarball present (no re-pull)"`)));
  await bringUp();

  console.log("\n=== PHASE 5: read the row back ===");
  console.log(
    await py(
      `import pymysql\n` +
        `c=pymysql.connect(host='127.0.0.1',port=3306,user='root',password='${PW}',database='app')\n` +
        `cur=c.cursor(); cur.execute("SELECT id, body FROM notes"); rows=cur.fetchall()\n` +
        `print("rows after respawn:", rows)\n` +
        `print("\\n=== PERSISTENCE:", "PASS" if any('BEFORE-STOP' in (r[1] or '') for r in rows) else "FAIL", "===")`
    )
  );

  console.log("\nDone. Clean up: bun scripts/test-db-persist.ts clean");
}

main().catch((e) => { console.error("FATAL:", e.message || e); process.exit(1); });
