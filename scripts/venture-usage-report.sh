#!/bin/bash
# Read-only report of AI token usage for named venture founders in production.
#   scripts/venture-usage-report.sh "Anshul" "MD Sadik"
# Matches founder name or email (case-insensitive substring). Reads the
# production database and the app containers' logs over SSH; changes nothing.
# Token counts exist for calls since usage logging shipped (2026-11-03);
# earlier turns are counted and estimated from message sizes.
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$#" -ge 1 ] || { echo 'Usage: scripts/venture-usage-report.sh "Name" ["Name" ...]' >&2; exit 1; }
for name in "$@"; do
  [[ "$name" =~ ^[A-Za-z0-9\ @._-]+$ ]] || { echo "Unsupported characters in: $name" >&2; exit 1; }
done
set -a; source .env.prod >/dev/null 2>&1; set +a
: "${DEPLOY_SERVER:?DEPLOY_SERVER missing from .env.prod}"

where=""
for name in "$@"; do
  where+="${where:+ OR }u.name ILIKE '%${name}%' OR u.email ILIKE '%${name}%'"
done
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT

# Messages (request IDs link log lines to founders), with content sizes for estimates.
cat > "$work/query.sql" <<SQL
\pset footer off
-- One tab-separated column, so no separator has to survive SSH quoting.
SELECT concat_ws(chr(9), u.name, u.email, c.id, replace(c.title, chr(9), ' '), m.request_id, m.role, m.status, length(m.content),
  (SELECT count(*) FROM venture_source s WHERE s.conversation_id = c.id),
  (SELECT count(*) FROM venture_assessment a WHERE a.conversation_id = c.id))
FROM venture_message m
JOIN venture_conversation c ON c.id = m.conversation_id
JOIN "user" u ON u.id = c.user_id
WHERE ${where}
ORDER BY u.email, c.created_at, m.created_at;
SQL
# The app's database (POSTGRES_DB in .env.prod), not the accessory's default one.
[[ "${POSTGRES_DB:-}" =~ ^[A-Za-z0-9_]+$ ]] || { echo "POSTGRES_DB missing or unexpected in .env.prod" >&2; exit 1; }
ssh -o ConnectTimeout=15 "root@${DEPLOY_SERVER}" "
  pg=\$(docker ps --format '{{.Names}}' | grep -m1 postgres)
  docker exec -i \"\$pg\" sh -c 'psql -U \"\$POSTGRES_USER\" -d ${POSTGRES_DB} -At'
" < "$work/query.sql" > "$work/messages.tsv"

# Usage lines from every app container still on the host (current and previous releases).
ssh -o ConnectTimeout=15 "root@${DEPLOY_SERVER}" '
  for c in $(docker ps -a --filter label=service=lfg-node --format "{{.Names}}" | grep web); do
    docker logs "$c" 2>&1 | grep -E "\"event\":\"venture\.(provider\.step|research\.digest|assessment\.provider_response|history\.summarized)\"" || true
  done
' > "$work/usage.log"

python3 scripts/venture-usage-report.py "$work/messages.tsv" "$work/usage.log"
