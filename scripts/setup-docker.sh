#!/usr/bin/env bash
# Install & start Docker so the "docker" sandbox backend can run.
#
# Supports Linux (via Docker's official convenience script) and prints guidance
# for macOS/Windows (where Docker Desktop is the supported path).
#
#   ./scripts/setup-docker.sh
set -euo pipefail

if command -v docker >/dev/null 2>&1; then
  echo ">>> Docker is already installed: $(docker --version)"
  if docker info >/dev/null 2>&1; then
    echo ">>> Docker daemon is running. You're ready — set SANDBOX_BACKEND=docker."
    exit 0
  fi
  echo "!!! Docker is installed but the daemon isn't running. Start it and re-run this script."
  exit 1
fi

OS="$(uname -s)"
case "$OS" in
  Linux)
    echo ">>> Installing Docker Engine via get.docker.com (Linux)..."
    curl -fsSL https://get.docker.com | sh
    echo ">>> Enabling the Docker service..."
    sudo systemctl enable --now docker || true
    # Let the current user run docker without sudo (takes effect on next login).
    if getent group docker >/dev/null 2>&1; then
      sudo usermod -aG docker "$USER" || true
      echo ">>> Added $USER to the 'docker' group. Log out/in (or run 'newgrp docker') to apply."
    fi
    echo ">>> Done: $(docker --version 2>/dev/null || echo 'installed (re-login to use without sudo)')"
    ;;
  Darwin)
    echo ">>> On macOS, install Docker Desktop:"
    echo "    https://docs.docker.com/desktop/install/mac-install/"
    echo "    (or: brew install --cask docker) — then launch Docker Desktop."
    exit 1
    ;;
  *)
    echo ">>> Unsupported OS ($OS). Install Docker manually:"
    echo "    https://docs.docker.com/engine/install/"
    exit 1
    ;;
esac

echo ">>> Next: ./scripts/build-sandbox-image.sh youruser/lfg-sandbox:latest --push"
