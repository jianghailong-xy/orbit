#!/usr/bin/env bash
# Upgrade the Orbit Docker Compose stack. The default path rebuilds local images and leaves
# postgres running; --pull-base opts into refreshing and potentially recreating base services.
set -euo pipefail

GIT_PULL=0
NO_CACHE=0
PRUNE=0
PULL_BASE=0

usage() {
  cat <<'EOF'
Usage: upgrade.sh [--pull] [--pull-base] [--no-cache] [--prune]

  --pull       git pull --ff-only before building
  --pull-base  refresh postgres and gateway base images; may restart postgres
  --no-cache   rebuild apiserver/web images without Docker layer cache
  --prune      prune dangling images after a successful upgrade
  -h, --help   show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --pull) GIT_PULL=1 ;;
    --pull-base) PULL_BASE=1 ;;
    --no-cache) NO_CACHE=1 ;;
    --prune) PRUNE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
cd "$REPO_ROOT"

if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  echo "error: docker compose is not available on PATH" >&2
  exit 1
fi

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

if [ "$PULL_BASE" -eq 1 ]; then
  echo "==> Refreshing base images (postgres, gateway)"
  $DC pull postgres gateway
  echo "==> Recreating the stack (apiserver applies DB migrations on boot)"
  $DC up -d --wait
else
  echo "==> Recreating changed services (apiserver applies DB migrations on boot)"
  # All three app-layer services are named explicitly, so dependency traversal is unnecessary.
  # Suppress it to keep Compose from recreating postgres when this checkout's relative bind-mount
  # path differs from the deployment checkout (for example, when upgrading from a git worktree).
  $DC up -d --wait --no-deps apiserver web gateway
fi

echo "==> Stack status"
$DC ps

if [ "$PRUNE" -eq 1 ]; then
  echo "==> Pruning dangling images"
  docker image prune -f
fi

echo "✓ Upgrade complete — all services healthy."
