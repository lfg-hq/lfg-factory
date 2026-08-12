#!/usr/bin/env bash
# Build (and optionally push) the LFG sandbox image used by SANDBOX_BACKEND=docker.
#
# Usage:
#   ./scripts/build-sandbox-image.sh                         # builds lfg-sandbox:latest locally
#   ./scripts/build-sandbox-image.sh youruser/lfg-sandbox:1  # custom tag
#   ./scripts/build-sandbox-image.sh youruser/lfg-sandbox:1 --push   # build + push to a registry
#
# After building, set SANDBOX_IMAGE in your .env to the tag you used.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

TAG="${1:-lfg-sandbox:latest}"
PUSH="${2:-}"

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: docker is not installed. Run ./scripts/setup-docker.sh first." >&2
  exit 1
fi

echo ">>> Building sandbox image: $TAG"
docker build -f Dockerfile.sandbox -t "$TAG" .

if [ "$PUSH" = "--push" ]; then
  echo ">>> Pushing $TAG"
  docker push "$TAG"
fi

echo ">>> Done. Set this in your .env:"
echo "    SANDBOX_BACKEND=docker"
echo "    SANDBOX_IMAGE=$TAG"
