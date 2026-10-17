#!/usr/bin/env bash
# Install a new Orbit deployment from this checkout: write its .env, prepare managed runners on this
# host's Docker, and start the Compose stack (docs/self-hosting.md).
#
# A fresh install only. A .env, or a database under data/postgres, means a deployment already lives
# here, and the script stops before it changes anything: a second run would replace that deployment's
# secrets and decide its managed runners for it. Upgrade a deployment with
# .claude/skills/upgrade/upgrade.sh, which never writes .env either, so managed runners stay as that
# deployment's own .env has them.
#
# Managed runners are on in a new deployment (docs/self-hosting.md, "Managed runners"): every account
# gets a runner of its own, a container on this host's Docker, when it signs in. For them this script
#   - builds the managed runner image from deploy/managed-runner/image, on this host and never pushed,
#     or takes the local image --managed-runner-image names;
#   - creates their network, a bridge on which managed runners cannot reach one another;
#   - writes data/managed-runners: the Docker channel's token and configuration, and the apiserver's
#     profile;
#   - writes the switch, that directory and the managed-runners-docker Compose profile into .env.
# With --no-managed-runners it writes ORBIT_MANAGED_RUNNERS_ENABLED=false instead and prepares nothing.
#
# --enable-managed-runners is an administrator's explicit choice for the deployment already in this
# checkout, one installed without managed runners: it prepares them the same way, writes those lines
# into its .env (and only those), and starts the channel and the apiserver. Nothing else runs it.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/install-server.sh [--public-origin URL] [--no-managed-runners]
                                 [--managed-runner-image IMAGE] [--no-start]
       scripts/install-server.sh --enable-managed-runners [--managed-runner-image IMAGE] [--no-start]

  --public-origin URL     the origin people open Orbit at (default http://localhost:2086)
  --no-managed-runners    install with managed runners switched off
  --managed-runner-image IMAGE
                          use this local managed runner image instead of building one
  --enable-managed-runners
                          switch managed runners on for the deployment already in this checkout
  --no-start              write the configuration only; start later with
                          `docker compose up -d --build --wait`
  -h, --help              show this help
EOF
}

PUBLIC_ORIGIN=""
MANAGED=1
ENABLE_EXISTING=0
RUNNER_IMAGE=""
START=1
while [ $# -gt 0 ]; do
  case "$1" in
    --public-origin) PUBLIC_ORIGIN="${2:?--public-origin needs a URL}"; shift ;;
    --no-managed-runners) MANAGED=0 ;;
    --enable-managed-runners) ENABLE_EXISTING=1 ;;
    --managed-runner-image) RUNNER_IMAGE="${2:?--managed-runner-image needs an image}"; shift ;;
    --no-start) START=0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

die() {
  echo "error: $*" >&2
  exit 1
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
MR_DIR=data/managed-runners
MR_NETWORK=orbit-managed-runners
# What .env carries for managed runners: the switch, their directory and the Docker backend's profile.
MR_LINES=(
  "ORBIT_MANAGED_RUNNERS_ENABLED=true"
  "ORBIT_MANAGED_RUNNERS_DIR=./$MR_DIR"
  "COMPOSE_PROFILES=managed-runners-docker"
)

if [ "$ENABLE_EXISTING" -eq 1 ]; then
  [ "$MANAGED" -eq 1 ] && [ -z "$PUBLIC_ORIGIN" ] \
    || die "--enable-managed-runners takes neither --no-managed-runners nor --public-origin"
  [ -e .env ] || die "no .env here: there is no deployment to switch managed runners on for. Run without --enable-managed-runners to install one."
  if grep -Eq '^[[:space:]]*(ORBIT_MANAGED_RUNNERS_DIR|COMPOSE_PROFILES)=' .env; then
    die "managed runners were prepared for this deployment already, or .env sets COMPOSE_PROFILES: switch them
       with ORBIT_MANAGED_RUNNERS_ENABLED in .env (docs/self-hosting.md, \"Managed runners\")."
  fi
else
  if [ -e .env ]; then
    die ".env already exists: a deployment lives in this checkout, and an install never rewrites it.
       Upgrade it with .claude/skills/upgrade/upgrade.sh. Managed runners are switched in its .env
       (docs/self-hosting.md, \"Managed runners\")."
  fi
  if [ -e data/postgres ]; then
    die "data/postgres already exists: this checkout holds a deployment's database. Restore that
       deployment's .env rather than installing over it."
  fi
fi
case "$PUBLIC_ORIGIN" in
  ''|http://*|https://*) ;;
  *) die "--public-origin must be an http:// or https:// origin" ;;
esac
case "$PUBLIC_ORIGIN" in
  *[[:space:]\"\|\\]*) die "--public-origin must not contain spaces, quotes, | or \\" ;;
esac
command -v openssl >/dev/null || die "openssl is needed to generate the deployment's secrets"
docker compose version >/dev/null 2>&1 || die "Docker with the Compose plugin (docker compose) is needed"

prepare_managed_runners() {
  if [ -e "$MR_DIR/state" ]; then
    die "$MR_DIR/state already exists: a Docker channel has run from this checkout."
  fi

  # The image every managed runner container runs, by its local ID: the channel and the apiserver's
  # profile both name that ID, so a tag moved later changes nothing that runs.
  if [ -z "$RUNNER_IMAGE" ]; then
    local source_sha
    source_sha="${ORBIT_SOURCE_SHA:-$(git rev-parse HEAD 2>/dev/null || true)}"
    [[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] \
      || die "the managed runner image is stamped with its full source commit: run from a Git checkout, or set ORBIT_SOURCE_SHA"
    echo "==> Building the managed runner image from deploy/managed-runner/image (local, never pushed)"
    # No provenance attestation, which BuildKit makes anew for every build: in Docker's containerd image store it
    # would give the same image a new ID each time. /upgrade builds it the same way and compares the IDs.
    docker build --provenance=false -f deploy/managed-runner/image/Dockerfile --build-arg "ORBIT_SOURCE_SHA=$source_sha" \
      -t orbit-managed-runner:local .
    RUNNER_IMAGE=orbit-managed-runner:local
  fi
  local image_id
  image_id="$(docker image inspect -f '{{.Id}}' "$RUNNER_IMAGE")" || die "no local image $RUNNER_IMAGE"
  [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || die "$RUNNER_IMAGE has no local image ID of the form sha256:<64 hex>"

  # Their network: not internal, since a runner reaches its model's endpoint and its Git hosts, but with
  # inter-container traffic off, so no runner reaches another. Nor can a runner reach the stack's
  # containers: it reaches the apiserver the way a runner on another machine does, through the gateway's
  # published port, at the host's address on this network.
  if ! docker network inspect "$MR_NETWORK" >/dev/null 2>&1; then
    echo "==> Creating the managed runners' network $MR_NETWORK"
    docker network create --driver bridge --opt com.docker.network.bridge.enable_icc=false "$MR_NETWORK" >/dev/null
  fi
  [ "$(docker network inspect -f '{{index .Options "com.docker.network.bridge.enable_icc"}}' "$MR_NETWORK")" = false ] \
    || die "network $MR_NETWORK exists and lets containers reach one another; remove it or create it with com.docker.network.bridge.enable_icc=false"
  local gateway="" address
  for address in $(docker network inspect -f '{{range .IPAM.Config}}{{.Gateway}} {{end}}' "$MR_NETWORK"); do
    case "$address" in *.*.*.*) gateway="$address"; break ;; esac
  done
  [ -n "$gateway" ] || die "network $MR_NETWORK has no IPv4 gateway address"

  echo "==> Writing $MR_DIR (the Docker channel's token and configuration, the apiserver's profile)"
  local instance
  instance="orbit-$(openssl rand -hex 4)"
  ( umask 077 && mkdir -p "$MR_DIR" )
  chmod 700 "$MR_DIR"
  ( umask 077 && openssl rand -hex 32 >"$MR_DIR/token" )
  # Both files name paths inside the containers, where root Compose mounts this directory at
  # /var/lib/orbit-managed-runners. A runner may ask for no more than the channel's limits; the
  # profile's amounts are what each runner is given, and the pool is what the host has, less a quarter
  # of its CPU and memory and a tenth of its disk.
  ( umask 077 && cat >"$MR_DIR/channel.json" <<EOF
{
  "schemaVersion": 1,
  "instanceId": "$instance",
  "listen": { "unixSocket": "/var/lib/orbit-managed-runners/channel.sock" },
  "tokenFile": "/var/lib/orbit-managed-runners/token",
  "dockerSocket": "/var/run/docker.sock",
  "stateDir": "/var/lib/orbit-managed-runners/state",
  "image": "$image_id",
  "network": "$MR_NETWORK",
  "limits": {
    "maxCpuMillis": 4000,
    "maxMemoryBytes": 8589934592,
    "maxPids": 4096,
    "maxTmpBytes": 2147483648,
    "maxVolumeBytes": 107374182400,
    "maxConcurrent": 8
  },
  "stopGraceSeconds": 240,
  "diskCheckSeconds": 120
}
EOF
  )
  ( umask 077 && cat >"$MR_DIR/profile.json" <<EOF
{
  "schemaVersion": 1,
  "valueKind": "actual",
  "backend": "docker",
  "environmentId": "$instance",
  "clusterKey": "$instance",
  "resourceProfileId": "docker-default",
  "docker": {
    "instanceId": "$instance",
    "channel": { "socketPath": "/var/lib/orbit-managed-runners/channel.sock" },
    "tokenFile": "/var/lib/orbit-managed-runners/token"
  },
  "storage": { "capacity": "20Gi" },
  "runner": {
    "image": "$image_id",
    "serverUrl": "http://$gateway:2086",
    "maxConcurrent": 2,
    "tmpSizeLimit": "1Gi",
    "resources": { "cpu": "2", "memory": "4Gi", "pids": 4096 }
  },
  "lifecycle": {
    "maxAttempts": 5,
    "backoffBaseSeconds": 10,
    "backoffMaxSeconds": 300,
    "startupDeadlineSeconds": 1800,
    "requestTimeoutSeconds": 60,
    "leaseSeconds": 60,
    "pollIntervalSeconds": 5,
    "heartbeatFreshSeconds": 120,
    "idleSeconds": 3600,
    "capacityRetrySeconds": 60,
    "drainSeconds": 600
  }
}
EOF
  )
}

# The managed runners' lines, appended to the .env being written.
write_managed_lines() {
  echo
  echo "# ─────────── Managed runners: written by scripts/install-server.sh at $STAMP ───────────"
  echo "# docs/self-hosting.md, \"Managed runners\": who gets one, what isolates it, and how to turn them off"
  echo "# or on. An upgrade never writes these lines."
  if [ "$MANAGED" -eq 1 ]; then
    printf '%s\n' "${MR_LINES[@]}"
  else
    echo "ORBIT_MANAGED_RUNNERS_ENABLED=false"
  fi
}

if [ "$MANAGED" -eq 1 ]; then
  prepare_managed_runners
fi

echo "==> Writing .env"
NEW_ENV="$(mktemp .env.install.XXXXXX)"
trap 'rm -f "$NEW_ENV"' EXIT
if [ "$ENABLE_EXISTING" -eq 1 ]; then
  # The deployment's own .env, every line kept but an earlier switch, which the new one replaces.
  grep -Ev '^[[:space:]]*ORBIT_MANAGED_RUNNERS_ENABLED=' .env >"$NEW_ENV" || true
else
  JWT_SECRET="$(openssl rand -base64 32)"
  PROVIDER_SECRET_KEY="$(openssl rand -base64 32)"
  sed -e "s|^JWT_SECRET=.*\$|JWT_SECRET=\"$JWT_SECRET\"|" \
      -e "s|^PROVIDER_SECRET_KEY=.*\$|PROVIDER_SECRET_KEY=\"$PROVIDER_SECRET_KEY\"|" \
      ${PUBLIC_ORIGIN:+-e "s|^PUBLIC_ORIGIN=.*\$|PUBLIC_ORIGIN=\"$PUBLIC_ORIGIN\"|"} \
      .env.example >"$NEW_ENV"
  unset JWT_SECRET PROVIDER_SECRET_KEY
fi
write_managed_lines >>"$NEW_ENV"
mv "$NEW_ENV" .env
trap - EXIT

if [ "$START" -eq 0 ]; then
  echo "✓ Configuration written. Start the stack with: docker compose up -d --build --wait"
  exit 0
fi

if [ "$ENABLE_EXISTING" -eq 1 ]; then
  # Only the channel is built: the apiserver is recreated from the image it runs now, so switching
  # managed runners on deploys no other change. --no-deps leaves postgres alone.
  echo "==> Starting the Docker channel and recreating the apiserver with managed runners on"
  docker compose build docker-channel
  docker compose up -d --wait --wait-timeout 300 --no-deps docker-channel apiserver
else
  echo "==> Building the images"
  docker compose build
  # A new database takes every migration at once, which on a slow disk outlasts the apiserver's health
  # check at its first boot; applied first, the apiserver starts with nothing left to apply. The same
  # command its image runs at boot, resolving the Prisma CLI rather than naming its path.
  echo "==> Starting the database and applying the migrations"
  docker compose up -d --wait --wait-timeout 300 postgres
  docker compose run --rm --no-deps apiserver sh -c \
    'cd src/apiserver && node "$(node -p '"'"'require.resolve("prisma/build/index.js")'"'"')" migrate deploy'
  echo "==> Starting the stack"
  docker compose up -d --wait --wait-timeout 900
fi
docker compose ps
if [ "$MANAGED" -eq 1 ]; then
  # The apiserver says once, at start, whether managed runners are running and, if not, why.
  docker compose logs apiserver 2>&1 | grep -E 'managed runners are' | tail -n 5 || true
fi
if [ "$ENABLE_EXISTING" -eq 1 ]; then
  echo "✓ Managed runners are on: every account that signs in from now on gets one."
else
  echo "✓ Orbit is running. Open ${PUBLIC_ORIGIN:-http://localhost:2086}: the first visitor creates the administrator at /setup."
fi
