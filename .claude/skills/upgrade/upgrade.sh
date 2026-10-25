#!/usr/bin/env bash
# Upgrade the Orbit Docker Compose stack: rebuild the locally-built images
# (apiserver, web) from the current source, refresh the pinned base images
# (postgres, gateway/nginx), then recreate every service and wait for health.
#
# Database migrations are NOT a separate step: the apiserver container runs
# `prisma migrate deploy` on boot (see src/apiserver/Dockerfile CMD), so
# recreating it applies any new migrations against the persisted volume.
set -euo pipefail

GIT_PULL=auto
NO_CACHE=0
PRUNE=0
PULL_BASE=0
ALLOW_DIRTY=0

usage() {
  cat <<'EOF'
Usage: upgrade.sh [--no-pull] [--pull] [--pull-base] [--no-cache] [--prune] [--allow-dirty]

  --no-pull    deploy the checkout as it is. By default a checkout on main is
               fast-forwarded first (git pull --ff-only), so origin's main ships
  --pull       git pull --ff-only even when the checkout is not on main
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
    --no-pull)   GIT_PULL=0 ;;
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

# ── Managed runners' image: this section is the same in both copies of /upgrade's script ──────────
# A deployment whose .env switches on the managed-runners-docker profile runs managed runners on this
# host's Docker (docs/self-hosting.md, "Managed runners"). The Docker channel makes every runner's
# container from one image, which channel.json and profile.json in the managed runners' directory both
# name by its local image ID. The image carries the runner, and the runner never updates itself, so the
# upgrade rebuilds the image from this checkout (on this host, never pushed) and names the new ID in both
# files. A container keeps the image it was made from: nothing running is stopped, and each runner
# moves to the new image with its next container, made when it wakes after it next sleeps. Nothing here
# deletes the previous image, and Docker keeps what a container runs (docs/self-hosting.md, "What an
# upgrade does").
MR_TAG=orbit-managed-runner:local
# Where root Compose mounts the managed runners' directory: in the channel, and read-only in the apiserver.
MR_MOUNT=/var/lib/orbit-managed-runners
MR_SWITCH=0

# The managed runners' directory on this host: the source Compose binds at $MR_MOUNT. awk reads to the end
# rather than exiting at the match, which could stop Compose with SIGPIPE and fail the pipeline.
managed_runners_dir() {
  $DC config docker-channel 2>/dev/null | awk -v mount="$MR_MOUNT" '
    { sub(/^[[:space:]]*-?[[:space:]]*/, "") }
    /^source:/ { source = $0; sub(/^source:[[:space:]]*/, "", source); gsub(/^"|"$/, "", source) }
    /^target:/ { target = $0; sub(/^target:[[:space:]]*/, "", target); gsub(/^"|"$/, "", target)
                 if (target == mount && found == "") found = source }
    END { if (found != "") print found }'
}

# The image ID a file names: its one "image" member, sha256:<64 hex>.
managed_runner_image_in() {
  local ids
  ids="$(grep -oE '"image"[[:space:]]*:[[:space:]]*"sha256:[0-9a-f]{64}"' "$1" | grep -oE 'sha256:[0-9a-f]{64}' || true)"
  if [ -z "$ids" ] || [ "$(printf '%s\n' "$ids" | grep -c .)" -ne 1 ]; then
    echo "error: $1 must name the managed runner image once, as \"image\": \"sha256:<64 hex>\";" >&2
    echo "       nothing was recreated" >&2
    return 1
  fi
  printf '%s\n' "$ids"
}

# Before anything is built: the directory, its two files and the image each names now.
managed_runners_preflight() {
  MR_DIR="$(managed_runners_dir)"
  if [ -z "$MR_DIR" ] || [ ! -f "$MR_DIR/channel.json" ] || [ ! -f "$MR_DIR/profile.json" ]; then
    echo "error: the managed-runners-docker profile is on, but the directory Compose binds at $MR_MOUNT" >&2
    echo "       (${MR_DIR:-none}) holds no channel.json and profile.json — nothing was built or recreated." >&2
    echo "       scripts/install-server.sh prepares them (docs/self-hosting.md, \"Managed runners\")." >&2
    exit 1
  fi
  MR_CHANNEL_IMAGE="$(managed_runner_image_in "$MR_DIR/channel.json")" || exit 1
  MR_PROFILE_IMAGE="$(managed_runner_image_in "$MR_DIR/profile.json")" || exit 1
}

# Without a provenance attestation, as the install builds it: BuildKit makes a new one for every build, and in
# Docker's containerd image store that gives the same image a new ID each time, so a re-run that built nothing new
# would still switch. The ID then names the image's content alone.
managed_runner_image_build() {
  echo "==> Building the managed runner image from deploy/managed-runner/image ($MR_TAG, local, never pushed)"
  if [ "$NO_CACHE" -eq 1 ]; then
    docker build --no-cache --provenance=false -f deploy/managed-runner/image/Dockerfile --build-arg "ORBIT_SOURCE_SHA=$ORBIT_SOURCE_SHA" -t "$MR_TAG" .
  else
    docker build --provenance=false -f deploy/managed-runner/image/Dockerfile --build-arg "ORBIT_SOURCE_SHA=$ORBIT_SOURCE_SHA" -t "$MR_TAG" .
  fi
  MR_IMAGE="$(docker image inspect -f '{{.Id}}' "$MR_TAG")"
  if ! [[ "$MR_IMAGE" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "error: $MR_TAG has no local image ID of the form sha256:<64 hex> — nothing was recreated." >&2
    exit 1
  fi
}

# Name the image in both files, unless both name it already and no earlier switch is unfinished. Each file
# is replaced whole by a rename, so a reader finds the previous file or the new one, never part of either,
# and nothing reads them until the apiserver and the channel start again. .image-switch marks a switch
# written and not yet started on: a run that finds it starts both again, whatever it built.
managed_runner_image_switch() {
  local file
  if [ "$MR_CHANNEL_IMAGE" = "$MR_IMAGE" ] && [ "$MR_PROFILE_IMAGE" = "$MR_IMAGE" ] && [ ! -e "$MR_DIR/.image-switch" ]; then
    echo "==> The managed runner image is unchanged ($MR_IMAGE)"
    return
  fi
  MR_SWITCH=1
  echo "$MR_IMAGE" >"$MR_DIR/.image-switch"
  for file in channel.json profile.json; do
    cp -p "$MR_DIR/$file" "$MR_DIR/.$file.new"
    sed -E "s/(\"image\"[[:space:]]*:[[:space:]]*\")sha256:[0-9a-f]{64}\"/\\1$MR_IMAGE\"/" "$MR_DIR/$file" >"$MR_DIR/.$file.new"
    # One ID for another of the same length: the copy is whole only if it is exactly as long as the file.
    if [ "$(managed_runner_image_in "$MR_DIR/.$file.new")" != "$MR_IMAGE" ] \
      || [ "$(wc -c <"$MR_DIR/.$file.new")" -ne "$(wc -c <"$MR_DIR/$file")" ]; then
      echo "error: could not write the new image ID into a copy of $MR_DIR/$file; nothing was recreated" >&2
      exit 1
    fi
  done
  mv -f "$MR_DIR/.channel.json.new" "$MR_DIR/channel.json"
  mv -f "$MR_DIR/.profile.json.new" "$MR_DIR/profile.json"
  echo "==> The managed runner image is now $MR_IMAGE in channel.json and profile.json"
  echo "    (it was $MR_CHANNEL_IMAGE: containers made from it keep running on it until they stop)"
  MR_APISERVER="$($DC ps -q apiserver 2>/dev/null || true)"
}

# After the other services: the apiserver and the channel read their files only as they start, so after a
# switch both start again, the apiserver first. Until the channel serves the image the apiserver's profile
# names, its manager makes nothing (each pass stops at the mismatch) and only waits; the other way round, a
# channel serving the new image would refuse the previous apiserver's creates and fail the runners it was
# starting. Neither restart stops a managed runner's container.
managed_runner_services_up() {
  if [ "$MR_SWITCH" -eq 1 ]; then
    if [ "$($DC ps -q apiserver 2>/dev/null || true)" = "$MR_APISERVER" ]; then
      echo "==> Recreating apiserver to read the managed runner profile"
      $DC up -d --wait --no-deps --force-recreate apiserver
    fi
    echo "==> Recreating docker-channel to read its configuration"
    $DC up -d --wait --no-deps --force-recreate docker-channel
    rm -f "$MR_DIR/.image-switch"
  else
    echo "==> Recreating docker-channel if it changed"
    $DC up -d --wait --no-deps docker-channel
  fi
}
# ── end of the managed runners' section ─────────────────────────────────────────────────────────────

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

# Deploying main means deploying origin's main, not whatever this checkout last heard of: merges also
# reach origin without passing through here (another machine's runner, a GitHub merge), and a
# checkout that missed them rebuilds a stale tree and still reports success. So a checkout on main is
# fast-forwarded before anything is built. --ff-only merges and rewrites nothing — a checkout that has
# diverged from origin stops here. --no-pull deploys the checkout as it is; --pull also pulls off main.
if [ "$GIT_PULL" = auto ]; then
  if [ "$(git -C "$REPO_ROOT" symbolic-ref --quiet --short HEAD 2>/dev/null)" = main ]; then
    GIT_PULL=1
  else
    GIT_PULL=0
  fi
fi
if [ "$GIT_PULL" -eq 1 ]; then
  echo "==> git pull --ff-only"
  if ! git pull --ff-only; then
    echo "error: git pull --ff-only failed — nothing was built or recreated." >&2
    echo "       Reconcile this checkout with its upstream, or pass --no-pull to deploy it as it is." >&2
    exit 1
  fi
fi

# The web image builds the downloadable runner from a deliberately narrow Docker context that
# contains no Git metadata. Bind that binary to the exact source commit before Compose renders
# its build arguments. Keep an explicit caller value for reproducible retries of a pinned build.
DEPLOY_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
export ORBIT_SOURCE_SHA="${ORBIT_SOURCE_SHA:-$DEPLOY_SHA}"

# The web image now serving publishes the runner release the runners run today. Hand it to the build,
# so the image built next keeps that release downloadable at /dl/previous/ — the release the control
# plane holds runners at during a staged rollout and rolls them back to (src/web/Dockerfile). By a
# tag, because a build can start FROM a local image only by name, never by its id.
PREVIOUS_RELEASE_ARG=""
SERVING_WEB_IMAGE="$(docker inspect --format '{{.Image}}' orbit-web 2>/dev/null || true)"
if [ -n "$SERVING_WEB_IMAGE" ] && docker tag "$SERVING_WEB_IMAGE" orbit-web:previous-release; then
  PREVIOUS_RELEASE_ARG="PREVIOUS_RELEASE_IMAGE=orbit-web:previous-release"
else
  echo "warning: no orbit-web image to carry the runner release over from — the new web image keeps no previous one" >&2
fi

# wiki-worker runs the apiserver's image with another command, so naming it builds nothing twice: it
# keeps this list and the recreate list below the same services.
SERVICES="apiserver wiki-worker web"
# Managed runners stay as this deployment's .env has them: this script never writes .env. A deployment
# whose .env switched on the managed-runners-docker profile (a fresh install's scripts/install-server.sh
# does) runs the Docker channel, which is rebuilt with the rest and recreated after them, and its managed
# runner image, rebuilt and switched to (the section above). Without that profile, Compose does not list
# the service and nothing is added. (grep reads to the end, unlike -q: an early exit could stop Compose
# mid-list with SIGPIPE, which pipefail would read as no channel.) The managed runners' firewall
# (managed-runner-firewall) is never built, started or recreated here: its rules stay as the install or
# --enable-managed-runner-firewall left them, and a deployment without it gains none.
CHANNEL=""
if $DC config --services 2>/dev/null | grep -x docker-channel >/dev/null; then
  CHANNEL=docker-channel
  managed_runners_preflight
fi
echo "==> Building images from source ($SERVICES${CHANNEL:+ $CHANNEL})"
if [ "$NO_CACHE" -eq 1 ]; then
  $DC build --no-cache ${PREVIOUS_RELEASE_ARG:+--build-arg "$PREVIOUS_RELEASE_ARG"} $SERVICES $CHANNEL
else
  $DC build ${PREVIOUS_RELEASE_ARG:+--build-arg "$PREVIOUS_RELEASE_ARG"} $SERVICES $CHANNEL
fi
if [ -n "$CHANNEL" ]; then
  managed_runner_image_build
  managed_runner_image_switch
fi

# `up -d` only recreates containers whose image or config changed. The locally
# built images (apiserver, web) change here, and wiki-worker with apiserver's,
# whose image it runs; gateway changes only when its image or mounted nginx.conf
# does. Scoping `up` to those services means an unchanged
# postgres is never recreated (nor polled by --wait). Refreshing the base images —
# the only thing that could mark postgres/gateway "changed" — is opt-in via
# --pull-base, which then needs a full recreate to apply.
if [ "$PULL_BASE" -eq 1 ]; then
  echo "==> Refreshing base images (postgres, gateway)"
  $DC pull postgres gateway
  echo "==> Recreating the stack (apiserver applies DB migrations on boot)"
  if [ -n "$CHANNEL" ]; then
    # Every service but the channel, which follows the apiserver below, and the managed runners' firewall, which an
    # upgrade leaves as it is, rules and all: only an install or --enable-managed-runner-firewall starts it.
    ALL_BUT_CHANNEL="$($DC config --services | grep -vxE 'docker-channel|managed-runner-firewall')"
    $DC up -d --wait $ALL_BUT_CHANNEL
  else
    $DC up -d --wait
  fi
else
  echo "==> Recreating changed services (apiserver applies DB migrations on boot)"
  $DC up -d --wait $SERVICES gateway
fi
if [ -n "$CHANNEL" ]; then
  managed_runner_services_up
fi

echo "==> Stack status"
$DC ps

if [ "$PRUNE" -eq 1 ]; then
  echo "==> Pruning dangling images"
  docker image prune -f
fi

echo "✓ Upgrade complete — all services healthy."
