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
  KAMAL_REGISTRY_PASSWORD
  DOCKER_REGISTRY_TOKEN
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
ssh root@5.161.59.97 "mkdir -p /root/lfg-node/data /root/lfg-node/uploads"

CMD="${1:-deploy}"

echo ">>> Running: kamal $CMD"
kamal "$CMD"
