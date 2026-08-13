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
ALLOW_DIRTY=0

usage() {
  cat <<'EOF'
Usage: upgrade.sh [--pull] [--pull-base] [--no-cache] [--prune] [--allow-dirty]

  --pull       git pull --ff-only before building (get the latest source)
  --pull-base  also refresh the pinned base images (postgres, gateway). This is
               the only path that may recreate/restart postgres — omit it and an
               unchanged postgres is left running untouched.
  --no-cache   rebuild apiserver/web images without the Docker layer cache
  --prune      docker image prune -f after a successful upgrade
  --allow-dirty
               build anyway when the checkout has uncommitted changes (they are
               baked into the image and exist in no commit)
  -h, --help   show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --pull)      GIT_PULL=1 ;;
    --pull-base) PULL_BASE=1 ;;
    --no-cache)  NO_CACHE=1 ;;
    --prune)     PRUNE=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
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

# Serialize upgrades — only one upgrade.sh may run against this deployment at a time, so a
# second invocation fails fast instead of queueing a redundant rebuild.
#
# mkdir, not flock: flock ships with util-linux and does not exist on macOS, where `flock -n 9`
# failed with "command not found". `if ! flock` cannot tell that apart from "someone holds the
# lock", so the script refused EVERY upgrade on a Mac with a message saying another upgrade was
# running — a lock that blocked exactly the machine it was supposed to protect. mkdir is atomic
# on any POSIX filesystem and needs no external command.
#
# What flock gave for free was release-on-death: the kernel drops the lock when the holder dies.
# mkdir cannot, so the holder's pid goes in the directory and a lock whose holder is gone counts
# as stale and is taken over. Without that, one Ctrl-C during a long build would wedge every
# future upgrade — a worse failure than the one being fixed.
LOCK_DIR="/tmp/orbit-upgrade.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  LOCK_PID="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
    echo "error: another upgrade is already in progress (pid $LOCK_PID, lock: $LOCK_DIR)" >&2
    echo "       wait for it to finish, or check: docker compose ps" >&2
    exit 1
  fi
  echo "warning: taking over a stale upgrade lock (holder ${LOCK_PID:-unknown} is gone)" >&2
  # Re-create rather than just proceeding, so two processes finding the same stale lock still
  # resolve to one winner.
  rm -rf "$LOCK_DIR"
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "error: another upgrade claimed the stale lock first" >&2
    exit 1
  fi
fi
# Only now that the lock is ours: an early exit above must never delete someone else's. Covers
# set -e and a Ctrl-C mid-build as well as a normal finish.
trap 'rm -rf "$LOCK_DIR"' EXIT
echo "$$" >"$LOCK_DIR/pid"

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
