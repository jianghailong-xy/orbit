#!/usr/bin/env bash
# Upgrade the Orbit Docker Compose stack. The default path rebuilds local images and leaves
# postgres running; --pull-base opts into refreshing and potentially recreating base services.
set -euo pipefail

GIT_PULL=0
NO_CACHE=0
PRUNE=0
PULL_BASE=0
ALLOW_DIRTY=0
OBSERVERS_ONLY=0

usage() {
  cat <<'EOF'
Usage: upgrade.sh [--pull] [--pull-base] [--no-cache] [--prune] [--allow-dirty]
                  [--observers-only]

  --pull       git pull --ff-only before building
  --pull-base  refresh postgres and gateway base images; may restart postgres
  --no-cache   rebuild apiserver/web images without Docker layer cache
  --prune      prune dangling images after a successful upgrade
  --allow-dirty
               build anyway when the checkout has uncommitted changes (they are
               baked into the image and exist in no commit)
  --observers-only
               stop after migrations, runtime-generation registration, and the
               independent watchdog/coordinator/dead-man stage; leave the old
               apiserver/web/gateway serving until an operator verifies the new
               observers, then recreate those three services explicitly
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
    --observers-only) OBSERVERS_ONLY=1 ;;
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

# The watchdog refuses anonymous builds: every emitted sample identifies both the independently
# running collector and the code whose projection it observes. Operators can deliberately point
# TARGET at another full SHA; the normal same-release deployment binds both to this checkout.
DEPLOY_SHA="$(git rev-parse HEAD)"
DEPLOY_BRANCH="$(git symbolic-ref --quiet --short HEAD || true)"
[ -n "$DEPLOY_BRANCH" ] || {
  echo "error: deployment checkout is detached; set OUTCOME_WATCHDOG_TARGET_REF explicitly" >&2
  exit 1
}
export OUTCOME_WATCHDOG_COLLECTOR_SHA="${OUTCOME_WATCHDOG_COLLECTOR_SHA:-$DEPLOY_SHA}"
export OUTCOME_WATCHDOG_TARGET_SHA="${OUTCOME_WATCHDOG_TARGET_SHA:-$DEPLOY_SHA}"
export OUTCOME_WATCHDOG_TARGET_REF="${OUTCOME_WATCHDOG_TARGET_REF:-refs/heads/$DEPLOY_BRANCH}"
export OUTCOME_COORDINATOR_SOURCE_SHA="${OUTCOME_COORDINATOR_SOURCE_SHA:-$DEPLOY_SHA}"
export OUTCOME_COORDINATOR_TARGET_SHA="${OUTCOME_COORDINATOR_TARGET_SHA:-$DEPLOY_SHA}"
export EXECUTABLE_DEAD_MAN_SOURCE_SHA="${EXECUTABLE_DEAD_MAN_SOURCE_SHA:-$DEPLOY_SHA}"
export ORBIT_SOURCE_SHA="${ORBIT_SOURCE_SHA:-$DEPLOY_SHA}"

# A deployment declares each independently monitored process before starting it. The external
# dead-man can therefore distinguish "healthy", "stale", and "never started". A caller may pin
# these values when retrying the same rollout; otherwise each invocation is a new generation.
new_runtime_generation() {
  node -e "process.stdout.write(require('node:crypto').randomUUID())"
}
export OUTCOME_WATCHDOG_EXPECTATION_GENERATION="${OUTCOME_WATCHDOG_EXPECTATION_GENERATION:-$(new_runtime_generation)}"
export COMPLETION_ACK_WATCHDOG_EXPECTATION_GENERATION="${COMPLETION_ACK_WATCHDOG_EXPECTATION_GENERATION:-$(new_runtime_generation)}"
export OUTCOME_COORDINATOR_EXPECTATION_GENERATION="${OUTCOME_COORDINATOR_EXPECTATION_GENERATION:-$(new_runtime_generation)}"
export OUTCOME_COORDINATOR_SECONDARY_EXPECTATION_GENERATION="${OUTCOME_COORDINATOR_SECONDARY_EXPECTATION_GENERATION:-$(new_runtime_generation)}"
for generation in \
  "$OUTCOME_WATCHDOG_EXPECTATION_GENERATION" \
  "$COMPLETION_ACK_WATCHDOG_EXPECTATION_GENERATION" \
  "$OUTCOME_COORDINATOR_EXPECTATION_GENERATION" \
  "$OUTCOME_COORDINATOR_SECONDARY_EXPECTATION_GENERATION"; do
  if [[ ! "$generation" =~ ^[0-9a-fA-F-]{36}$ ]]; then
    echo "error: runtime expectation generation is not a UUID: $generation" >&2
    exit 1
  fi
done
if [ "$OUTCOME_WATCHDOG_EXPECTATION_GENERATION" = "$COMPLETION_ACK_WATCHDOG_EXPECTATION_GENERATION" ] \
   || [ "$OUTCOME_WATCHDOG_EXPECTATION_GENERATION" = "$OUTCOME_COORDINATOR_EXPECTATION_GENERATION" ] \
   || [ "$OUTCOME_WATCHDOG_EXPECTATION_GENERATION" = "$OUTCOME_COORDINATOR_SECONDARY_EXPECTATION_GENERATION" ] \
   || [ "$COMPLETION_ACK_WATCHDOG_EXPECTATION_GENERATION" = "$OUTCOME_COORDINATOR_EXPECTATION_GENERATION" ] \
   || [ "$COMPLETION_ACK_WATCHDOG_EXPECTATION_GENERATION" = "$OUTCOME_COORDINATOR_SECONDARY_EXPECTATION_GENERATION" ] \
   || [ "$OUTCOME_COORDINATOR_EXPECTATION_GENERATION" = "$OUTCOME_COORDINATOR_SECONDARY_EXPECTATION_GENERATION" ]; then
  echo "error: runtime expectation generations must be distinct" >&2
  exit 1
fi

WATCHDOG_MODULE_GRAPH_DIGEST="0b37ae35a4c04c94a2b0cc6683c04be3b5a4c3bc394d9b6725ec391d439ba4a7"
COORDINATOR_MODULE_GRAPH_DIGEST="cb34a9176d5135170d5591248f88d9c1fb88953cca69318d4433d272aee5d643"

echo "==> Building images from source (apiserver, web)"
if [ "$NO_CACHE" -eq 1 ]; then
  $DC build --no-cache apiserver web
else
  $DC build apiserver web
fi

echo "==> Applying migrations before declaring runtime expectations"
$DC run --rm --no-deps apiserver /bin/sh -c \
  'cd src/apiserver && node node_modules/prisma/build/index.js migrate deploy'

register_runtime_expectation() {
  component="$1"
  instance="$2"
  generation="$3"
  module_digest="$4"
  $DC run --rm --no-deps executable-dead-man node \
    /app/scripts/executable-acceptance-dead-man.mjs \
    --register-expectation \
    --component "$component" \
    --instance-id "$instance" \
    --generation "$generation" \
    --expected-source-sha "$DEPLOY_SHA" \
    --module-graph-digest "$module_digest" \
    --startup-grace-seconds 60 \
    --source-sha "$DEPLOY_SHA"
}

echo "==> Declaring independently monitored runtime generations"
register_runtime_expectation \
  outcome-watchdog compose:outcome-watchdog \
  "$OUTCOME_WATCHDOG_EXPECTATION_GENERATION" "$WATCHDOG_MODULE_GRAPH_DIGEST"
register_runtime_expectation \
  completion-ack-watchdog compose:outcome-watchdog \
  "$COMPLETION_ACK_WATCHDOG_EXPECTATION_GENERATION" "$WATCHDOG_MODULE_GRAPH_DIGEST"
register_runtime_expectation \
  outcome-coordinator compose:outcome-coordinator \
  "$OUTCOME_COORDINATOR_EXPECTATION_GENERATION" "$COORDINATOR_MODULE_GRAPH_DIGEST"
register_runtime_expectation \
  outcome-coordinator compose:outcome-coordinator-secondary \
  "$OUTCOME_COORDINATOR_SECONDARY_EXPECTATION_GENERATION" "$COORDINATOR_MODULE_GRAPH_DIGEST"

if [ "$PULL_BASE" -eq 1 ]; then
  echo "==> Refreshing base images (postgres, gateway)"
  $DC pull postgres gateway
  echo "==> Recreating refreshed database services"
  $DC up -d --wait postgres pgbackup
fi

# Bring up the observers and couriers before replacing the transaction they observe. This is a
# rolling-upgrade invariant, not merely incident choreography: a compatibility failure in the new
# apiserver must already have an independent detector and a durable delivery path when its first
# callback arrives. --no-deps is deliberate in both stages: the old apiserver remains live during
# stage one, and an upgrade launched from a worktree must not recreate postgres because its
# relative bind-mount path differs from the installed checkout.
echo "==> Stage 1/2: starting independent watchdog, coordinator peers, and dead-man"
$DC up -d --wait --no-deps watchdog outcome-coordinator \
  outcome-coordinator-secondary executable-dead-man

if [ "$OBSERVERS_ONLY" -eq 1 ]; then
  echo "==> Observer stage complete; apiserver/web/gateway intentionally left unchanged"
  $DC ps
  echo "✓ Independent observer stage is running. Verify its canonical obligations, then run:"
  echo "  $DC up -d --wait --no-deps apiserver web gateway"
  exit 0
fi

echo "==> Stage 2/2: recreating apiserver and presentation services"
$DC up -d --wait --no-deps apiserver web gateway

echo "==> Stack status"
$DC ps

if [ "$PRUNE" -eq 1 ]; then
  echo "==> Pruning dangling images"
  docker image prune -f
fi

echo "✓ Upgrade complete — all services healthy."
