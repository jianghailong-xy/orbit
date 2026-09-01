#!/usr/bin/env bash
# Upgrade the Orbit Docker Compose stack. The default path rebuilds local images and leaves
# postgres running; --pull-base opts into refreshing and potentially recreating base services.
set -euo pipefail

GIT_PULL=0
NO_CACHE=0
PRUNE=0
PULL_BASE=0
ALLOW_DIRTY=0

usage() {
  cat <<'EOF'
Usage: upgrade.sh [--pull] [--pull-base] [--no-cache] [--prune] [--allow-dirty]

  --pull       git pull --ff-only before building
  --pull-base  refresh postgres and gateway base images; may restart postgres
  --no-cache   rebuild apiserver/web images without Docker layer cache
  --prune      prune dangling images after a successful upgrade
  --allow-dirty
               build anyway when the checkout has uncommitted changes (they are
               baked into the image and exist in no commit)
  -h, --help   show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --pull) GIT_PULL=1 ;;
    --pull-base) PULL_BASE=1 ;;
    --no-cache) NO_CACHE=1 ;;
    --prune) PRUNE=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# Compose otherwise derives its project from the checkout directory. Orbit upgrades commonly run
# from UUID-named worktrees, while the installed stack is the stable `orbit` project; letting that
# name drift creates a second network and then collides with the intentionally fixed container
# names. Operators may still override the project explicitly for an isolated deployment.
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-orbit}"

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

# The image is built from the WORKING TREE, not from HEAD: `docker compose build` copies whatever
# is on disk. Uncommitted edits therefore ship into production while existing in no commit — the
# running deployment can't be reproduced from git, and the next clean rebuild reverts them with no
# warning. That is not hypothetical: a hotfix that lived only in this checkout served production
# for hours, invisible to every branch. Refuse by default; --allow-dirty is the deliberate escape.
DIRTY="$(git -C "$REPO_ROOT" status --porcelain --untracked-files=no 2>/dev/null || true)"
if [ -n "$DIRTY" ]; then
  if [ "$ALLOW_DIRTY" -eq 0 ]; then
    echo "error: uncommitted changes in $REPO_ROOT — they would be baked into the image:" >&2
    echo "$DIRTY" | sed 's/^/       /' >&2
    echo "" >&2
    echo "       Commit or stash them so what runs matches a commit, or pass --allow-dirty to" >&2
    echo "       deploy them anyway (the next clean rebuild will silently revert them)." >&2
    exit 1
  fi
  echo "!!  --allow-dirty: building uncommitted changes into the image. They exist in no commit," >&2
  echo "!!  so the next clean rebuild reverts them. Commit them if they are meant to stay:" >&2
  echo "$DIRTY" | sed 's/^/!!    /' >&2
fi
# Untracked files ride along too (minus .dockerignore), but they are additive and usually scratch,
# so they warn rather than block — a stray file is not a silent divergence from HEAD.
UNTRACKED="$(git -C "$REPO_ROOT" ls-files --others --exclude-standard 2>/dev/null | head -10 || true)"
if [ -n "$UNTRACKED" ]; then
  echo "warning: untracked files are in the build context and in no commit:" >&2
  echo "$UNTRACKED" | sed 's/^/         /' >&2
fi

if [ "$GIT_PULL" -eq 1 ]; then
  echo "==> git pull --ff-only"
  git pull --ff-only
fi

# The web image builds the downloadable runner from a context that carries no Git metadata, so the
# commit has to be handed to Compose before it renders the build arguments.
DEPLOY_SHA="$(git rev-parse HEAD)"
export ORBIT_SOURCE_SHA="${ORBIT_SOURCE_SHA:-$DEPLOY_SHA}"

echo "==> Building images from source (apiserver, web)"
if [ "$NO_CACHE" -eq 1 ]; then
  $DC build --no-cache apiserver web
else
  $DC build apiserver web
fi

echo "==> Applying migrations before recreating services"
$DC run --rm --no-deps apiserver /bin/sh -c \
  'cd src/apiserver && node node_modules/prisma/build/index.js migrate deploy'

if [ "$PULL_BASE" -eq 1 ]; then
  echo "==> Refreshing base images (postgres, gateway)"
  $DC pull postgres gateway
  echo "==> Recreating refreshed database services"
  $DC up -d --wait postgres pgbackup
fi

# --no-deps is deliberate: an upgrade launched from a worktree must not recreate postgres, whose
# relative bind-mount path differs from the installed checkout — that has already once served
# production an empty database.
echo "==> Recreating apiserver and presentation services"
$DC up -d --wait --no-deps apiserver web gateway

echo "==> Stack status"
$DC ps

if [ "$PRUNE" -eq 1 ]; then
  echo "==> Pruning dangling images"
  docker image prune -f
fi

echo "✓ Upgrade complete — all services healthy."
