#!/usr/bin/env bash
# Upgrade the Orbit Docker Compose stack. The default path rebuilds local images and leaves
# postgres running; --pull-base opts into refreshing and potentially recreating base services.
set -euo pipefail

GIT_PULL=auto
NO_CACHE=0
PRUNE=0
PULL_BASE=0
ALLOW_DIRTY=0

usage() {
  cat <<'EOF'
Usage: upgrade.sh [--no-pull] [--pull] [--pull-base] [--no-cache] [--prune] [--allow-dirty]

  --no-pull    deploy the checkout as it is (on main the default is git pull --ff-only first)
  --pull       git pull --ff-only even when the checkout is not on main
  --pull-base  refresh postgres and gateway base images; may restart postgres
  --no-cache   rebuild apiserver/web images without Docker layer cache
  --prune      prune dangling images after a successful upgrade
  --allow-dirty
               build anyway when the checkout has uncommitted changes (they are
               baked into the image and exist in no commit)
  -h, --help   show this help
EOF
}

ORIGINAL_ARGS=("$@")
while [ $# -gt 0 ]; do
  case "$1" in
    --pull) GIT_PULL=1 ;;
    --no-pull) GIT_PULL=0 ;;
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

# Compose otherwise derives its project from the checkout directory, while the installed stack is
# the stable `orbit` project; letting that name drift creates a second network and then collides
# with the intentionally fixed container names. An upgrade runs in the installed checkout, and
# deployment_preflight stops one anywhere else, a worktree included. A separate deployment exports
# its own project name here, and gives its containers names of their own.
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-orbit}"

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
      # The other apiservers read it as they start too. They run the apiserver's image, so they were not recreated
      # either.
      if [ -n "$APISERVERS" ]; then
        echo "==> Recreating the other apiservers ($APISERVERS) to read it too"
        $DC up -d --wait --no-deps --force-recreate $APISERVERS
      fi
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

# ── Runner link: this section is the same in both copies of /upgrade's script ───────────────────────
# Runners work over the runner link (docs/self-hosting.md, "Runner link"), so an upgrade brings it up on a deployment that
# has none. What .env says decides what this script may do:
#   new       No RUNNER_LINK_* value and no runner-link profile: the link's secrets are generated once and appended to
#             .env with RUNNER_LINK_URL=same-origin, in one write that changes no line there and prints none of them. Runners
#             then reach the link through the web gateway's port, at the address they reach this server at.
#   managed   RUNNER_LINK_URL=same-origin, as an install or an earlier run wrote it: .env stays as it is, and the gateway
#             follows src/link-gateway. Its image is named by the last commit there, so a commit elsewhere recreates nothing.
#   operator  Anything else, such as production's own host name, ACME and port 443: .env is not opened for writing, and
#             the gateway and NATS are neither built nor restarted.
# Which build this is comes from this checkout's docker-compose.yml, and not from this script, which may have started
# before the pull: a build that serves runners only over the link demands the signing key there (RUNNER_LINK_SIGNING_KEY:?).
# In such a build a link that does not come up stops the upgrade before the apiserver is recreated, so the deployment
# goes on running the build it has. In any other it is reported as this script's last words and in its exit code, and
# the runners stay on HTTPS. Nothing here writes RUNNER_LINK_REQUIRED, which is an administrator's.
LINK_IMAGE=orbit-link-gateway:local
LINK_STATE=""
LINK_ONLY=0
LINK_FAILURE=""
LINK_DETAIL=""

# A name's last value in .env, as Compose reads it, without its quotes. Only ever captured, never printed.
link_env() {
  [ -f .env ] || return 0
  sed -nE "s/^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=[[:space:]]*//p" .env | tail -n 1 |
    sed -E "s/^\"(.*)\"[[:space:]]*\$/\\1/; s/^'(.*)'[[:space:]]*\$/\\1/"
}

# new, managed or operator, read without writing. A name exported in this shell counts as .env does, since Compose
# prefers it. compgen lists names alone, so no value passes through a pipe.
link_state() {
  if [ "$(link_env RUNNER_LINK_URL)" = same-origin ]; then
    echo managed
  elif compgen -e | grep '^RUNNER_LINK_' >/dev/null \
    || { [ -f .env ] && grep -E "^[[:space:]]*(export[[:space:]]+)?RUNNER_LINK_[A-Z0-9_]+[[:space:]]*=[[:space:]]*(\"[^\"]|'[^']|[^\"'[:space:]#])" .env >/dev/null; } \
    || link_env COMPOSE_PROFILES | tr ',' '\n' | tr -d ' ' | grep -x runner-link >/dev/null; then
    echo operator
  else
    echo new
  fi
}

# What an operator's link is missing, by name, never by value.
link_gaps() {
  local name
  for name in RUNNER_LINK_SIGNING_KEY RUNNER_LINK_URL RUNNER_LINK_GATEWAY_TOKEN RUNNER_LINK_PUBLIC_KEY \
    RUNNER_LINK_NATS_APISERVER_SEED RUNNER_LINK_NATS_APISERVER_KEY RUNNER_LINK_NATS_GATEWAY_SEED RUNNER_LINK_NATS_GATEWAY_KEY; do
    if [ -z "${!name:-}" ] && [ -z "$(link_env "$name")" ]; then printf ' %s' "$name"; fi
  done
  if ! printf '%s,%s\n' "${COMPOSE_PROFILES:-}" "$(link_env COMPOSE_PROFILES)" | tr ',' '\n' | tr -d ' ' | grep -x runner-link >/dev/null; then
    printf ' %s' "COMPOSE_PROFILES(runner-link)"
  fi
}

link_status() {
  $DC ps -a nats link-gateway 2>&1 || true
  $DC logs --tail=20 nats link-gateway 2>&1 || true
}

# Reported at the end of a build that keeps its HTTPS path; the end of the upgrade, before the apiserver, in one that has none.
link_failed() {
  LINK_FAILURE="$1"
  LINK_DETAIL="$(link_status)"
  [ "$LINK_ONLY" -eq 1 ] || return 0
  echo "error: this build serves runners only over the runner link, and it did not come up: $LINK_FAILURE" >&2
  printf '%s\n' "$LINK_DETAIL" | sed 's/^/       /' >&2
  echo "       The apiserver was not recreated: this deployment goes on running the build it has, and its runners keep" >&2
  echo "       working. Fix that and run this script again: it keeps what it already wrote to .env." >&2
  echo "       docs/self-hosting.md, \"Runner link\"." >&2
  exit 1
}

# Before anything is built or written.
link_preflight() {
  { set +x; } 2>/dev/null
  if grep 'RUNNER_LINK_SIGNING_KEY:?' docker-compose.yml >/dev/null; then LINK_ONLY=1; fi
  LINK_STATE="$(link_state)"
  case "$LINK_STATE" in
    new) echo "==> Runner link: this deployment has none; setting it up" ;;
    managed) echo "==> Runner link: keeping it current" ;;
    operator)
      local gaps running health="" problem=""
      gaps="$(link_gaps)"
      if [ -z "$gaps" ]; then
        running="$($DC ps -q link-gateway 2>/dev/null || true)"
        if [ -n "$running" ]; then
          health="$(docker inspect -f '{{with index .State "Health"}}{{.Status}}{{end}}' "$running" 2>/dev/null || true)"
        fi
      fi
      if [ -n "$gaps" ]; then
        problem="this deployment set up its own link, and .env has no value for:$gaps"
      elif [ "$health" != healthy ]; then
        problem="this deployment set up its own link, and link-gateway is ${health:-not running}"
      fi
      if [ -z "$problem" ]; then
        echo "==> Runner link: this deployment's own; .env and the link gateway are left as they are"
      elif [ "$LINK_ONLY" -eq 1 ]; then
        link_failed "$problem"
      else
        # Its own to finish, and maybe on purpose: said, and nothing changes while runners can work over HTTPS.
        echo "!!  warning: $problem. Its runners stay on HTTPS, and .env and the link gateway are left as they are." >&2
        echo "!!  A later build serves runners only over the link: docs/self-hosting.md, \"Runner link\"." >&2
      fi
      ;;
  esac
}

link_build() {
  local flags=() source_sha
  source_sha="$(git log -1 --format=%H -- src/link-gateway 2>/dev/null || true)"
  if [ "$NO_CACHE" -eq 1 ]; then flags+=(--no-cache); fi
  # Without a provenance attestation where this Docker makes them, as the managed runner image is built: an image of the
  # same content keeps its ID, so Compose recreates nothing.
  if docker build --help 2>/dev/null | grep -e --provenance >/dev/null; then flags+=(--provenance=false); fi
  echo "==> Building the link gateway from src/link-gateway ($LINK_IMAGE, local, never pushed)"
  if ! docker build ${flags[@]+"${flags[@]}"} --build-arg "ORBIT_SOURCE_SHA=$source_sha" -t "$LINK_IMAGE" src/link-gateway; then
    link_failed "its image did not build (above)"
    return 1
  fi
}

# The lines .env gains, given the secrets.
link_lines() {
  local profiles
  profiles="$(link_env COMPOSE_PROFILES | tr -d ' ')"
  cat <<LINES
# ─────────── Runner link: written by the upgrade script at $(date -u +%Y-%m-%dT%H:%M:%SZ) ───────────
# docs/self-hosting.md, "Runner link". Keep these with this deployment's other secrets; no upgrade replaces them. Runners
# reach the link through the web gateway's port, at the address they reach this server at (RUNNER_LINK_URL=same-origin),
# so the gateway's own ports go on this host's loopback, where nothing else can collide with them. Compose takes the last
# COMPOSE_PROFILES in this file: this one is whatever came before it, with runner-link.
RUNNER_LINK_URL=same-origin
RUNNER_LINK_ENV_FILE=./deploy/runner-link/behind-web-gateway.env
RUNNER_LINK_BIND=127.0.0.1
RUNNER_LINK_PORT=0
RUNNER_LINK_METRICS_PORT=0
$1
COMPOSE_PROFILES=${profiles:+$profiles,}runner-link
LINES
}

# The link's lines, in one write at the end of .env. Every line there stays as it was. Compose takes the last value of a
# name, which is how COMPOSE_PROFILES gains runner-link without its line changing. The secrets stay in this variable
# and in .env: printf is a builtin, so they are in no process's arguments.
link_write_env() {
  local secrets block
  if ! secrets="$(docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges "$LINK_IMAGE" secrets)"; then
    link_failed "its image did not make the link's secrets (above)"
    return 1
  fi
  if [ "$(printf '%s\n' "$secrets" | grep -cE '^RUNNER_LINK_(SIGNING_KEY|PUBLIC_KEY|GATEWAY_TOKEN|NATS_(APISERVER|GATEWAY)_(SEED|KEY))="[^"]+"$')" != 7 ]; then
    link_failed "its image made something other than the link's seven secrets"
    return 1
  fi
  block="$(link_lines "$secrets")"
  # A last line with no newline stays that line, ended.
  if [ -f .env ] && [ -n "$(tail -c 1 .env)" ]; then
    if ! printf '\n' >>.env; then
      link_failed "this script cannot write to .env"
      return 1
    fi
  fi
  if ! ( umask 077 && printf '%s\n' "$block" >>.env ); then
    link_failed "this script cannot write to .env"
    return 1
  fi
  if [ "$(link_env RUNNER_LINK_URL)" != same-origin ]; then
    link_failed "the link's lines did not reach .env"
    return 1
  fi
  echo "    Wrote the runner link's secrets to .env (not shown); keep them with this deployment's other secrets."
}

# Its image and, for a deployment with none, its lines in .env.
link_prepare() {
  [ "$LINK_STATE" != operator ] || return 0
  link_build || return 0
  if [ "$LINK_STATE" = new ]; then link_write_env || return 0; fi
}

# What a link address answers from this project's network, as scripts/runner-link/door-check.js says it.
link_door() {
  $DC run --rm --no-deps -T apiserver node - "$1" <scripts/runner-link/door-check.js 2>/dev/null || echo "unreachable the check did not run"
}

# The way a runner takes: the web gateway's /runner-link, and where this deployment has an address of its own, that too,
# through whatever stands in front of it. An address this host cannot reach proves nothing either way.
link_door_check() {
  local answer origin
  answer="$(link_door http://gateway/runner-link)"
  case "$answer" in
    "401 UNAUTHENTICATED"*) ;;
    *) link_failed "the web gateway's /runner-link answered: $answer, not the link gateway's refusal of a request with no token"; return 0 ;;
  esac
  origin="$(link_env PUBLIC_ORIGIN)"
  origin="${origin%/}"
  case "$origin" in
    ""|*://localhost|*://localhost:*|*://127.*) return 0 ;;
  esac
  answer="$(link_door "$origin/runner-link")"
  case "$answer" in
    "401 UNAUTHENTICATED"*) echo "    $origin/runner-link reaches the link gateway." ;;
    unreachable*) echo "    $origin/runner-link could not be checked from here (${answer#unreachable }); runners reach it from where they are." ;;
    *) link_failed "$origin/runner-link answered: $answer, not the link gateway. Whatever stands in front of this deployment has to pass WebSocket upgrades on to /runner-link (docs/self-hosting.md, \"Put HTTPS in front\")" ;;
  esac
}

# The web gateway keeps the nginx.conf it started on: Compose bind-mounts it as a single file, a new checkout replaces
# that file under a running container, and Compose sees no change. So it is compared, as pgbackup's script is, and a
# difference recreates it, a moment's break for web traffic and streams, and only then.
web_gateway_refresh() {
  local running
  running="$($DC ps -q gateway 2>/dev/null || true)"
  [ -n "$running" ] || return 0
  if ! docker exec "$running" cat /etc/nginx/conf.d/default.conf | cmp -s - gateway/nginx.conf; then
    echo "==> Recreating gateway to run this checkout's gateway/nginx.conf"
    $DC up -d --wait --no-deps --force-recreate gateway
  fi
}

# After the images are built, before the apiserver is recreated. NATS and the gateway need nothing of the apiserver to
# start: its revocation list and switch are read again until they answer. --no-deps, so that nothing else moves.
link_start() {
  if [ "$LINK_STATE" = operator ] || [ -n "$LINK_FAILURE" ]; then
    web_gateway_refresh
    return 0
  fi
  echo "==> Starting the runner link (nats, link-gateway)"
  if ! $DC up -d --wait --wait-timeout 180 --no-deps nats link-gateway; then
    link_failed "nats or link-gateway did not come up within 3 minutes"
    web_gateway_refresh
    return 0
  fi
  web_gateway_refresh
  link_door_check
}

# The last thing this script says, and what it exits with.
link_report() {
  if [ -n "$LINK_FAILURE" ]; then
    {
      echo "!!  The runner link is NOT working: $LINK_FAILURE"
      printf '%s\n' "$LINK_DETAIL" | sed 's/^/!!    /'
      echo "!!  This deployment keeps working: everything else was upgraded, and its runners stay on HTTPS. A later build"
      echo "!!  serves them only over the link and will not start without it, so fix this first, then run this script again:"
      echo "!!  it keeps what it already wrote to .env. docs/self-hosting.md, \"Runner link\"."
    } >&2
    return 1
  fi
  case "$LINK_STATE" in
    new|managed)
      echo "    Runner link: up. Runners connect at the address they reach this server at, within about 20 minutes, or at once"
      echo "    as they update themselves. docs/self-hosting.md, \"Runner link\"."
      case "$(link_env PUBLIC_ORIGIN)" in
        https://*) ;;
        *)
          echo "!!  warning: this deployment's address is plain http, so its runner link is plain ws://: session content and" >&2
          echo "!!  one-hour link tokens cross the network unencrypted, as its HTTP does today. Put TLS in front of anything" >&2
          echo "!!  beyond a trusted LAN (docs/self-hosting.md, \"Put HTTPS in front\")." >&2
          ;;
      esac
      ;;
  esac
}
# ── end of the runner link's section ────────────────────────────────────────────────────────────────

# A deployment runs from one checkout, because its bind mounts are relative: ./data/postgres, ./data/pg-archive,
# ./data/files. From any other directory, a worktree included, Compose would bind that directory's empty ./data: that has
# served production an empty database, it empties the off-host mirror's source, and every attachment stops reading. So a
# run anywhere else stops here, before anything is pulled, built, tagged or recreated. Which deployment this run would
# act on is the postgres container Compose renders here, by its name, stopped or not: with container names of its own, a
# separate deployment is checked against its own /archive, and one with the same names is those containers, whatever its
# project is called. With no such container there is no deployment yet, and a first install goes ahead. Where Compose
# cannot render this checkout, as with no .env here, the default name is what it would have said.
deployment_preflight() {
  local name archive installed
  name="$($DC config postgres 2>/dev/null | awk '/^[[:space:]]*container_name:/ { found = $2 } END { print found }' || true)"
  name="${name:-orbit-postgres}"
  archive="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/archive"}}{{.Source}}{{end}}{{end}}' "$name" 2>/dev/null || true)"
  if [ -n "$archive" ] && [ "$archive" != "$PWD/data/pg-archive" ]; then
    installed="${archive%/data/pg-archive}"
    echo "error: this deployment runs from $installed, not from this checkout ($PWD): $name has /archive at $archive." >&2
    echo "       Its mounts are relative, so upgrading from here would bind them to this checkout's ./data." >&2
    echo "       Nothing was pulled, built, tagged or recreated. Run the upgrade in $installed." >&2
    echo "       A separate deployment on this Docker needs container names of its own, or it cannot be told from that one." >&2
    exit 1
  fi
}
deployment_preflight

# pgbackup is in neither list of services below, and `up` alone would not do for it: Compose bind-mounts its script as a
# single file, so a new checkout replaces the file under a running container, which keeps the one it started on, and
# Compose sees no change. So its script is compared with this checkout's: a difference recreates it, and otherwise `up`
# does so for a change of configuration, such as a new mount, and leaves it running if there is none. --no-deps, or `up`
# would recreate postgres with it. One that is not running is left as it is, and the run says so as its last words.
PGBACKUP_NOTICE=""
pgbackup_up() {
  local running
  running="$($DC ps -q pgbackup 2>/dev/null || true)"
  if [ -z "$running" ]; then
    PGBACKUP_NOTICE="!!  pgbackup was NOT updated: it is not running in this Compose project, so its script and mounts stay
!!  as they were. To update it, run this in $PWD: docker compose up -d --no-deps --force-recreate pgbackup"
    return 0
  fi
  if ! docker exec "$running" cat /usr/local/bin/pg-backup.sh | cmp -s - scripts/pg-backup.sh; then
    echo "==> Recreating pgbackup to run this checkout's scripts/pg-backup.sh"
    $DC up -d --wait --no-deps --force-recreate pgbackup
  else
    echo "==> Recreating pgbackup if it changed"
    $DC up -d --wait --no-deps pgbackup
  fi
}

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

# A checkout on main deploys origin's main: merges also reach origin without passing through this
# checkout, which would otherwise rebuild a stale tree. --ff-only rewrites nothing and stops on a
# diverged checkout; --no-pull deploys the checkout as it is, --pull also pulls off main.
if [ "$GIT_PULL" = auto ]; then
  if [ "$(git -C "$REPO_ROOT" symbolic-ref --quiet --short HEAD 2>/dev/null)" = main ]; then
    GIT_PULL=1
  else
    GIT_PULL=0
  fi
fi
if [ "$GIT_PULL" -eq 1 ]; then
  echo "==> git pull --ff-only"
  SCRIPT_BEFORE_PULL="$(git hash-object "$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")")"
  if ! git pull --ff-only; then
    echo "error: git pull --ff-only failed — nothing was built or recreated." >&2
    echo "       Reconcile this checkout with its upstream, or pass --no-pull to deploy it as it is." >&2
    exit 1
  fi
  # A pull that changed this file leaves this process reading the file it opened, the old steps with the new tree. So the
  # new script runs instead, from the start, holding what it needs, and pulls nothing again.
  if [ "$(git hash-object "$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")")" != "$SCRIPT_BEFORE_PULL" ]; then
    echo "==> The pull changed this script; running the new one"
    exec 9>&-
    exec "$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")" "${ORIGINAL_ARGS[@]+"${ORIGINAL_ARGS[@]}"}" --no-pull
  fi
fi

# The web image builds the downloadable runner from a context that carries no Git metadata, so the
# commit has to be handed to Compose before it renders the build arguments.
DEPLOY_SHA="$(git rev-parse HEAD)"
export ORBIT_SOURCE_SHA="${ORBIT_SOURCE_SHA:-$DEPLOY_SHA}"

# The runner link (the section above). A build that needs it demands its lines before Compose can render anything.
link_preflight
if [ "$LINK_ONLY" -eq 1 ]; then link_prepare; fi

# wiki-worker runs the apiserver's image with another command, so naming it builds nothing twice: it
# keeps this list and the recreate list below the same services.
SERVICES="apiserver wiki-worker web"
# The services Compose lists for this deployment, read once for the Docker channel and the other apiservers below.
COMPOSE_SERVICES="$($DC config --services 2>/dev/null || true)"
# Managed runners stay as this deployment's .env has them: this script writes nothing of theirs there. A deployment
# whose .env switched on the managed-runners-docker profile (a fresh install's scripts/install-server.sh
# does) runs the Docker channel, which is rebuilt with the rest and recreated after them, and its managed
# runner image, rebuilt and switched to (the section above). Without that profile, Compose does not list
# the service and nothing is added. (grep reads to the end, unlike -q: an early exit could stop printf
# mid-list with SIGPIPE, which pipefail would read as no channel.) The managed runners' firewall
# (managed-runner-firewall) is never built, started or recreated here: its rules stay as the install or
# --enable-managed-runner-firewall left them, and a deployment without it gains none.
CHANNEL=""
if printf '%s\n' "$COMPOSE_SERVICES" | grep -x docker-channel >/dev/null; then
  CHANNEL=docker-channel
  managed_runners_preflight
fi
# Once what can stop this run before anything is built has had its say, as a build that needs the link could not wait for.
if [ "$LINK_ONLY" -eq 0 ]; then link_prepare; fi
# The other apiservers a deployment adds in docker-compose.override.yml, apiserver-2 and on (docs/self-hosting.md,
# "Several apiservers"). They run the apiserver's image and build nothing; they are recreated after it, below.
# Where Compose lists none, nothing is added.
APISERVERS="$(printf '%s\n' "$COMPOSE_SERVICES" | grep -xE 'apiserver-[0-9]+' | paste -sd ' ' - || true)"
echo "==> Building images from source ($SERVICES${CHANNEL:+ $CHANNEL})"
if [ "$NO_CACHE" -eq 1 ]; then
  $DC build --no-cache $SERVICES $CHANNEL
else
  $DC build $SERVICES $CHANNEL
fi
if [ -n "$CHANNEL" ]; then
  managed_runner_image_build
fi
link_start

echo "==> Applying migrations before recreating services"
# Same command the image's CMD runs, and for the same reason it resolves the CLI instead of naming
# its path: npm's choice between the workspace tree and the hoisted root one is not a contract.
$DC run --rm --no-deps apiserver /bin/sh -c \
  'cd src/apiserver && node "$(node -p '"'"'require.resolve("prisma/build/index.js")'"'"')" migrate deploy'

if [ -n "$CHANNEL" ]; then
  managed_runner_image_switch
fi

if [ "$PULL_BASE" -eq 1 ]; then
  echo "==> Refreshing base images (postgres, gateway)"
  $DC pull postgres gateway
  echo "==> Recreating refreshed database services"
  $DC up -d --wait postgres pgbackup
fi

# --no-deps is deliberate: this path never recreates postgres. Its data is a relative bind mount,
# and a recreate from outside the installed checkout has already once served production an empty
# database, which is what deployment_preflight now stops.
echo "==> Recreating apiserver, wiki-worker and presentation services"
$DC up -d --wait --no-deps $SERVICES gateway
if [ -n "$APISERVERS" ]; then
  # Only once the apiserver is healthy, the migrations applied, so the others find none to apply. They run its
  # image, so a new one recreates them too.
  echo "==> Recreating the other apiservers ($APISERVERS) now that apiserver is healthy"
  $DC up -d --wait --no-deps $APISERVERS
fi
if [ -n "$CHANNEL" ]; then
  managed_runner_services_up
fi
if printf '%s\n' "$COMPOSE_SERVICES" | grep -x pgbackup >/dev/null; then
  pgbackup_up
fi

echo "==> Stack status"
$DC ps

if [ "$PRUNE" -eq 1 ]; then
  echo "==> Pruning dangling images"
  docker image prune -f
fi

[ -z "$PGBACKUP_NOTICE" ] || printf '%s\n' "$PGBACKUP_NOTICE" >&2
if ! link_report; then
  echo "✗ The upgrade finished, and the runner link is not working (above)." >&2
  exit 1
fi
echo "✓ Upgrade complete — all services healthy."
