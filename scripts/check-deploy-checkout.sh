#!/bin/bash
set -euo pipefail
# Called before loading credentials or contacting the deployment server.
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo 'Deployment stopped: this folder is missing its Git checkout metadata.' >&2
  exit 1
fi
missing=$(git ls-files --deleted -- src scripts Dockerfile package.json bun.lock)
if [ -n "$missing" ]; then
  echo 'Deployment stopped: committed application files are missing from this checkout:' >&2
  printf '%s\n' "$missing" >&2
  echo 'Restore the missing files or complete and verify their intended removal before deploying.' >&2
  exit 1
fi
