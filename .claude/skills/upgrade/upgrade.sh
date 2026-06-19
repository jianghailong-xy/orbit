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
PULL_BASE=0

usage() {
  cat <<'EOF'
Usage: upgrade.sh [--pull] [--pull-base] [--no-cache] [--prune]

  --pull       git pull --ff-only before building (get the latest source)
  --pull-base  also refresh the pinned base images (postgres, gateway). This is
               the only path that may recreate/restart postgres — omit it and an
               unchanged postgres is left running untouched.
  --no-cache   rebuild apiserver/web images without the Docker layer cache
  --prune      docker image prune -f after a successful upgrade
  -h, --help   show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --pull)      GIT_PULL=1 ;;
    --pull-base) PULL_BASE=1 ;;
    --no-cache)  NO_CACHE=1 ;;
    --prune)     PRUNE=1 ;;
    -h|--help)   usage; exit 0 ;;
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

# Serialize upgrades — only one upgrade.sh may run against this deployment at a
# time. flock -n grabs the lock non-blocking; if another upgrade already holds
# it, fail fast instead of queueing a redundant rebuild. fd 9 is released
# automatically when the script exits (normally or via set -e), so no stale lock.
LOCK_FILE="/tmp/orbit-upgrade.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "error: another upgrade is already in progress (lock: $LOCK_FILE)" >&2
  echo "       wait for it to finish, or check: docker compose ps" >&2
  exit 1
fi

if [ "$GIT_PULL" -eq 1 ]; then
  echo "==> git pull --ff-only"
  git pull --ff-only
fi

echo "==> Building images from source (apiserver, web)"
if [ "$NO_CACHE" -eq 1 ]; then
  $DC build --no-cache apiserver web
else
  $DC build apiserver web
fi

# `up -d` only recreates containers whose image or config changed. The locally
# built images (apiserver, web) change here; gateway changes only when its image
# or mounted nginx.conf does. Scoping `up` to those services means an unchanged
# postgres is never recreated (nor polled by --wait). Refreshing the base images —
# the only thing that could mark postgres/gateway "changed" — is opt-in via
# --pull-base, which then needs a full recreate to apply.
if [ "$PULL_BASE" -eq 1 ]; then
  echo "==> Refreshing base images (postgres, gateway)"
  $DC pull postgres gateway
  echo "==> Recreating the stack (apiserver applies DB migrations on boot)"
  $DC up -d --wait
else
  echo "==> Recreating changed services (apiserver applies DB migrations on boot)"
  $DC up -d --wait apiserver web gateway
fi

echo "==> Stack status"
$DC ps

if [ "$PRUNE" -eq 1 ]; then
  echo "==> Pruning dangling images"
  docker image prune -f
fi

echo "✓ Upgrade complete — all services healthy."
