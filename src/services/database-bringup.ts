import { shellQuote as q } from './preview-plan.ts';

export function dockerBringup(o: {
  name: string; image: string; port: number; volume: string; env?: string[]; cmd?: string;
  readyProbe: string; readyGrep: string; authProbe?: string; authFailGrep?: string;
  prepareNewDirectory?: string;
}): string {
  const [dataDir, destination] = o.volume.split(':');
  if (!dataDir || !destination || !/^[a-z0-9-]+$/.test(o.name)) throw new Error('Invalid database container configuration');
  const run = `docker run -d --name ${q(o.name)} --restart unless-stopped ${(o.env ?? []).map(e => `-e ${q(e)}`).join(' ')} -p 127.0.0.1:${o.port}:${o.port} -v ${q(o.volume)} ${q(o.image)} ${o.cmd ?? ''}`;
  return `# Never remove a container, wipe a data directory, or kill a port owner here.
fail() {
  docker logs --tail 8 ${q(o.name)} 2>&1 || true
  printf 'ENGINE_FAILURE: %s; existing data preserved.\\n' "$1"
  echo ENGINE_ERROR
  exit 1
}
LOCK=${q(dataDir + '.lfg-start.lock')}
mkdir "$LOCK" 2>/dev/null || { echo 'ENGINE_FAILURE: another startup or an unresolved startup lock exists; existing data preserved.'; echo ENGINE_ERROR; exit 1; }
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
trap 'exit 1' HUP INT TERM
INFO=$(docker info 2>&1) || fail "Docker unavailable: $INFO"
CONTAINERS=$(docker ps -a --format '{{.Names}}' 2>&1) || fail "Cannot inspect containers: $CONTAINERS"
EXPECTED=$(readlink -f ${q(dataDir)} 2>/dev/null || printf '%s' ${q(dataDir)})
for container in $CONTAINERS; do
  MOUNTS=$(docker inspect --format '{{range .Mounts}}{{println .Source}}{{end}}' "$container" 2>&1) || fail "Cannot inspect $container: $MOUNTS"
  PORTS=$(docker inspect --format '{{range .HostConfig.PortBindings}}{{range .}}{{println .HostPort}}{{end}}{{end}}' "$container" 2>&1) || fail "Cannot inspect ports for $container: $PORTS"
  if [ "$container" != ${q(o.name)} ]; then
    for source in $MOUNTS; do
      CANONICAL=$(readlink -f "$source" 2>/dev/null || printf '%s' "$source")
      [ "$CANONICAL" != "$EXPECTED" ] || fail "Container $container already uses the database directory ${dataDir}"
    done
    printf '%s\\n' "$PORTS" | grep -qx ${q(String(o.port))} && fail "Container $container already reserves database port ${o.port}"
  fi
done
if printf '%s\\n' "$CONTAINERS" | grep -qx ${q(o.name)}; then
  MOUNT=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "${destination}"}}{{.Source}}{{end}}{{end}}' ${q(o.name)} 2>&1) || fail "Cannot verify database mount: $MOUNT"
  ACTUAL=$(readlink -f "$MOUNT" 2>/dev/null || printf '%s' "$MOUNT")
  [ "$ACTUAL" = "$EXPECTED" ] || fail "Existing ${o.name} container has an unexpected database mount"
  START=$(docker start ${q(o.name)} 2>&1) || fail "Container start failed: $START"
else
  if [ ! -d ${q(dataDir)} ]; then
    mkdir -p ${q(dataDir)} || fail 'Cannot create database directory'
    ${o.prepareNewDirectory ?? ':'}
  fi
  START=$(${run} 2>&1) || fail "Container creation failed: $START"
fi
READY=0
for i in $(seq 1 90); do
  STATE=$(docker inspect --format '{{.State.Status}}' ${q(o.name)} 2>&1) || fail "Cannot inspect database state: $STATE"
  [ "$STATE" = running ] || fail "Database container is $STATE"
  PROBE_OUT=$(${o.readyProbe} 2>&1)
  ${o.authFailGrep ? `printf '%s\\n' "$PROBE_OUT" | grep -qE ${q(o.authFailGrep)} && fail "Database authentication rejected: $PROBE_OUT"` : ':'}
  if printf '%s\\n' "$PROBE_OUT" | grep -q ${q(o.readyGrep)}; then READY=1; break; fi
  sleep 3
done
[ "$READY" = 1 ] || fail "Database readiness timed out: $PROBE_OUT"
${o.authProbe ? `AUTH_OUT=$(${o.authProbe} 2>&1) || fail "Database access check failed: $AUTH_OUT"` : ':'}
echo ENGINE_READY`;
}
