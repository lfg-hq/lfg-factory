#!/bin/bash
set -e

# ── LFG Node app — Kamal deploy script ───────────────────────────────────────
# Usage:
#   ./node_deploy.sh              # full deploy
#   ./node_deploy.sh setup        # first-time server setup
#   ./node_deploy.sh rollback     # roll back to previous release

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Load production env vars (must export KAMAL_REGISTRY_PASSWORD, etc.)
if [ -f ".env.production" ]; then
  set -a
  source .env.production
  set +a
else
  echo "Warning: .env.production not found. Ensure secrets are exported in the environment."
fi

# Ensure required secrets are present
REQUIRED_VARS=(
  # KAMAL_REGISTRY_PASSWORD
  DOCKER_REGISTRY_PASSWORD
  BETTER_AUTH_SECRET
  BETTER_AUTH_URL
)
for var in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!var}" ]; then
    echo "Error: required env var '$var' is not set."
    exit 1
  fi
done

# Ensure persistent data/upload directories exist on the server
echo ">>> Ensuring remote directories exist..."
ssh "root@${DEPLOY_SERVER:?Set DEPLOY_SERVER to your server host/IP}" "mkdir -p /root/lfg-node/data /root/lfg-node/uploads"

CMD="${1:-deploy}"

echo ">>> Running: kamal $CMD"
kamal "$CMD"

# ── Purge Cloudflare cache after a deploy ────────────────────────────────────
# Static assets (CSS/JS) are served with long edge-cache headers, so Cloudflare
# would keep serving the previous build until it expires. Purge on every deploy
# so changes go live immediately. Requires (set in .env.production or env):
#   CLOUDFLARE_ZONE_ID     — the zone id for lfg.run
#   CLOUDFLARE_PURGE_TOKEN — an API token with "Zone → Cache Purge" permission
if [ "$CMD" = "deploy" ] || [ "$CMD" = "redeploy" ]; then
  if [ -n "$CLOUDFLARE_ZONE_ID" ] && [ -n "$CLOUDFLARE_PURGE_TOKEN" ]; then
    echo ">>> Purging Cloudflare cache for zone $CLOUDFLARE_ZONE_ID ..."
    CF_RESP=$(curl -sS -X POST \
      "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/purge_cache" \
      -H "Authorization: Bearer ${CLOUDFLARE_PURGE_TOKEN}" \
      -H "Content-Type: application/json" \
      --data '{"purge_everything":true}' || echo '{"success":false,"error":"curl failed"}')
    if echo "$CF_RESP" | grep -q '"success":true'; then
      echo ">>> Cloudflare cache purged."
    else
      echo "!!! Cloudflare purge did NOT succeed: $CF_RESP"
      echo "    (Deploy is live; purge the cache manually from the Cloudflare dashboard.)"
    fi
  else
    echo ">>> Skipping Cloudflare purge — set CLOUDFLARE_ZONE_ID + CLOUDFLARE_PURGE_TOKEN to enable."
  fi
fi
