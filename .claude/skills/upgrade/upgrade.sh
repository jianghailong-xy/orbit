#!/usr/bin/env bash
# Upgrade the Orbit Docker Compose stack: rebuild the locally-built images
# (apiserver, web) from the current source, refresh the pinned base images
# (postgres, gateway/nginx), then recreate every service and wait for health.
#
# Database migrations are NOT a separate step: the apiserver container runs
# `prisma migrate deploy` on boot (see src/apiserver/Dockerfile CMD), so
# recreating it applies any new migrations against the persisted volume.
set -euo pipefail

GIT_PULL=0
NO_CACHE=0
PRUNE=0

usage() {
  cat <<'EOF'
Usage: upgrade.sh [--pull] [--no-cache] [--prune]

  --pull       git pull --ff-only before building (get the latest source)
  --no-cache   rebuild apiserver/web images without the Docker layer cache
  --prune      docker image prune -f after a successful upgrade
  -h, --help   show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --pull)     GIT_PULL=1 ;;
    --no-cache) NO_CACHE=1 ;;
    --prune)    PRUNE=1 ;;
    -h|--help)  usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# Run from the repo root, where docker-compose.yml lives.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

# Prefer Compose v2 (`docker compose`); fall back to the legacy v1 binary.
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  echo "error: docker compose is not available on PATH" >&2
  exit 1
fi

if [ "$GIT_PULL" -eq 1 ]; then
  echo "==> git pull --ff-only"
  git pull --ff-only
fi

echo "==> Pulling updated base images (postgres, gateway)"
$DC pull postgres gateway

echo "==> Building images from source (apiserver, web)"
if [ "$NO_CACHE" -eq 1 ]; then
  $DC build --no-cache apiserver web
else
  $DC build apiserver web
fi

echo "==> Recreating the stack (apiserver applies DB migrations on boot)"
$DC up -d --wait

echo "==> Stack status"
$DC ps

if [ "$PRUNE" -eq 1 ]; then
  echo "==> Pruning dangling images"
  docker image prune -f
fi

echo "✓ Upgrade complete — all services healthy."
