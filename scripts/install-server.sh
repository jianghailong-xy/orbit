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
#   - creates their network, an IPv4-only bridge on which managed runners cannot reach one another;
#   - firewalls that network on this host (the managed runners' host firewall, below);
#   - writes data/managed-runners: the Docker channel's token and configuration, the apiserver's
#     profile and the firewall's configuration;
#   - writes the switch, that directory and the Compose profiles of the Docker backend and of the
#     firewall into .env.
# With --no-managed-runners it writes ORBIT_MANAGED_RUNNERS_ENABLED=false instead and prepares nothing.
#
# The managed runners' host firewall (docs/self-hosting.md, "Isolation and its limits";
# deploy/managed-runner/firewall): rules on this host's iptables that leave a managed runner the
# gateway's published port, DNS and public addresses, and nothing else of this host or the private
# networks behind it. The managed-runner-firewall service keeps them, through Docker and host restarts,
# and the Docker channel starts no runner container while they are not in force. Before anything is
# written the script checks that this host can carry them; then it applies them once and checks from
# the network that this host and a private address are refused. Where either fails it stops and says
# why: fix that, or install with --no-managed-runner-firewall, which leaves this host's firewall alone
# and says so in .env.
#
# --enable-managed-runners is an administrator's explicit choice for the deployment already in this
# checkout, one installed without managed runners: it prepares them the same way, firewall included,
# writes those lines into its .env (and only those), and starts the channel, the firewall and the
# apiserver. --enable-managed-runner-firewall is the same choice for a deployment that has managed
# runners without their firewall: it adds the firewall alone. Nothing else runs either.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/install-server.sh [--public-origin URL] [--no-managed-runners] [--no-managed-runner-firewall]
                                 [--managed-runner-image IMAGE] [--no-start]
       scripts/install-server.sh --enable-managed-runners [--no-managed-runner-firewall]
                                 [--managed-runner-image IMAGE] [--no-start]
       scripts/install-server.sh --enable-managed-runner-firewall [--no-start]

  --public-origin URL     the origin people open Orbit at (default http://localhost:2086)
  --no-managed-runners    install with managed runners switched off
  --no-managed-runner-firewall
                          leave this host's firewall alone: managed runners can then reach every
                          service this host listens to and the private networks behind it
  --managed-runner-image IMAGE
                          use this local managed runner image instead of building one
  --enable-managed-runners
                          switch managed runners on for the deployment already in this checkout
  --enable-managed-runner-firewall
                          firewall the managed runners of the deployment already in this checkout
  --no-start              write the configuration only; start later with
                          `docker compose up -d --build --wait`
  -h, --help              show this help
EOF
}

PUBLIC_ORIGIN=""
MANAGED=1
FIREWALL=1
ENABLE_EXISTING=0
ENABLE_FIREWALL=0
RUNNER_IMAGE=""
START=1
while [ $# -gt 0 ]; do
  case "$1" in
    --public-origin) PUBLIC_ORIGIN="${2:?--public-origin needs a URL}"; shift ;;
    --no-managed-runners) MANAGED=0 ;;
    --no-managed-runner-firewall) FIREWALL=0 ;;
    --enable-managed-runners) ENABLE_EXISTING=1 ;;
    --enable-managed-runner-firewall) ENABLE_FIREWALL=1 ;;
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
# The gateway's published port in docker-compose.yml: how a managed runner reaches the apiserver, at the host's
# address on its network, and the one port of this host the firewall leaves it.
MR_API_PORT=2086
FW_IMAGE=orbit-managed-runner-firewall:local
FW_PROFILE=managed-runner-firewall
FW_SERVICE=managed-runner-firewall
FW_LOCK_LINE=""
# What .env carries for managed runners: the switch, their directory and the Compose profiles of the Docker
# backend and, unless --no-managed-runner-firewall, of the firewall.
mr_lines() {
  echo "ORBIT_MANAGED_RUNNERS_ENABLED=true"
  echo "ORBIT_MANAGED_RUNNERS_DIR=./$MR_DIR"
  if [ "$FIREWALL" -eq 1 ]; then
    echo "COMPOSE_PROFILES=managed-runners-docker,$FW_PROFILE"
    [ -z "$FW_LOCK_LINE" ] || echo "$FW_LOCK_LINE"
  else
    echo "COMPOSE_PROFILES=managed-runners-docker"
  fi
}
FIREWALL_OFF_WARNING="the managed runners' host firewall is off (--no-managed-runner-firewall): every account's runner
         can reach every service this host listens to and the private networks behind it. Firewall their network
         yourself, or add it later with scripts/install-server.sh --enable-managed-runner-firewall
         (docs/self-hosting.md, \"Isolation and its limits\")."

if [ "$ENABLE_FIREWALL" -eq 1 ]; then
  [ "$MANAGED" -eq 1 ] && [ "$FIREWALL" -eq 1 ] && [ "$ENABLE_EXISTING" -eq 0 ] && [ -z "$PUBLIC_ORIGIN" ] && [ -z "$RUNNER_IMAGE" ] \
    || die "--enable-managed-runner-firewall takes no other option than --no-start"
  [ -e .env ] || die "no .env here: there is no deployment whose managed runners could be firewalled."
  grep -Eq '^[[:space:]]*ORBIT_MANAGED_RUNNERS_DIR=' .env \
    || die "managed runners were never prepared for this deployment: switch them on with --enable-managed-runners, which
       firewalls them too."
  if grep -Eq "^[[:space:]]*COMPOSE_PROFILES=.*$FW_PROFILE" .env; then
    die "the managed runners' firewall is on for this deployment already ($FW_PROFILE is in COMPOSE_PROFILES)."
  fi
  [ "$(grep -Ec '^[[:space:]]*COMPOSE_PROFILES=' .env)" = 1 ] && grep -qx 'COMPOSE_PROFILES=managed-runners-docker' .env \
    || die ".env's COMPOSE_PROFILES is not the line an install writes (COMPOSE_PROFILES=managed-runners-docker): add
       $FW_PROFILE to it by hand, as docs/managed-runner-docker-operations.md describes."
  MR_DIR="$(sed -n 's/^[[:space:]]*ORBIT_MANAGED_RUNNERS_DIR=//p' .env | tail -n 1)"
  MR_DIR="${MR_DIR%\"}"
  MR_DIR="${MR_DIR#\"}"
  MR_DIR="${MR_DIR#./}"
  [ -f "$MR_DIR/profile.json" ] || die "$MR_DIR/profile.json is missing: this is not a deployment the install prepared."
elif [ "$ENABLE_EXISTING" -eq 1 ]; then
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
[ "$MANAGED" -eq 1 ] || [ "$FIREWALL" -eq 1 ] \
  || die "--no-managed-runner-firewall is about managed runners, which --no-managed-runners leaves off"
case "$PUBLIC_ORIGIN" in
  ''|http://*|https://*) ;;
  *) die "--public-origin must be an http:// or https:// origin" ;;
esac
case "$PUBLIC_ORIGIN" in
  *[[:space:]\"\|\\]*) die "--public-origin must not contain spaces, quotes, | or \\" ;;
esac
command -v openssl >/dev/null || die "openssl is needed to generate the deployment's secrets"
docker compose version >/dev/null 2>&1 || die "Docker with the Compose plugin (docker compose) is needed"
if [ "$MANAGED" -eq 1 ] && [ "$FIREWALL" -eq 0 ]; then
  echo "!! warning: $FIREWALL_OFF_WARNING" >&2
fi

# ── the managed runners' host firewall ──────────────────────────────────────────────────────────────

# The firewall program once, with its service's privileges (root Compose's managed-runner-firewall): this host's
# network namespace, NET_ADMIN and NET_RAW, no Docker socket. The host's xtables lock, where there is one, as the
# legacy iptables backend needs it; the firewall's directory once it exists.
firewall_run() {
  local mounts=() directory
  case "$MR_DIR" in /*) directory="$MR_DIR/firewall" ;; *) directory="$REPO_ROOT/$MR_DIR/firewall" ;; esac
  if [ -f /run/xtables.lock ]; then mounts+=(-v /run/xtables.lock:/run/xtables.lock); fi
  if [ -d "$directory" ]; then mounts+=(-v "$directory:/var/lib/orbit-managed-runner-firewall"); fi
  docker run --rm --network host --cap-drop ALL --cap-add NET_ADMIN --cap-add NET_RAW \
    --security-opt no-new-privileges --read-only ${mounts[@]+"${mounts[@]}"} "$FW_IMAGE" "$@"
}

# The firewall program as a process on the managed runners' network, where a runner is: no privilege, nobody's user.
on_runner_network() {
  docker run --rm --network "$MR_NETWORK" --cap-drop ALL --security-opt no-new-privileges --read-only \
    --user 65534:65534 "$FW_IMAGE" "$@"
}

FIREWALL_HELP="Fix that, or go without it (--no-managed-runner-firewall) and firewall the managed runners' network
       yourself (docs/managed-runner-docker-operations.md, \"What a managed runner can reach\")."

# Before anything is written: can this host carry the rules?
firewall_preflight() {
  local security driver facts
  security="$(docker info --format '{{json .SecurityOptions}}')" || die "docker info failed"
  case "$security" in
    *name=rootless*)
      die "this Docker is rootless: a container's host network is rootlesskit's namespace, not this host's, so
       the managed runners' firewall would protect nothing. $FIREWALL_HELP" ;;
  esac
  # Docker 28.2 and later name their firewall backend; an older Docker uses iptables.
  driver="$(docker info --format '{{with .FirewallBackend}}{{.Driver}}{{end}}' 2>/dev/null || true)"
  case "$driver" in
    nftables*)
      die "Docker uses its nftables firewall backend ($driver), which has no DOCKER-USER chain for these rules.
       Switch Docker back to iptables (\"firewall-backend\": \"iptables\" in daemon.json), or: $FIREWALL_HELP" ;;
  esac
  echo "==> Building the managed runners' firewall from deploy/managed-runner/firewall ($FW_IMAGE, local, never pushed)"
  docker build -f deploy/managed-runner/firewall/Dockerfile -t "$FW_IMAGE" .
  echo "==> Checking that this host's firewall can carry the managed runners' rules"
  facts="$(firewall_run preflight)" \
    || die "this host's iptables cannot carry the managed runners' firewall (the reason is above). $FIREWALL_HELP"
  echo "    $facts"
  case "$facts" in
    *'"backend": "legacy"'*)
      # The legacy backend replaces a whole table at a time: the service shares Docker's lock.
      [ -f /run/xtables.lock ] || die "the legacy iptables backend is in use but /run/xtables.lock is not there. $FIREWALL_HELP"
      FW_LOCK_LINE="ORBIT_MANAGED_RUNNER_FIREWALL_XTABLES_LOCK=/run/xtables.lock" ;;
  esac
}

# Once the network exists: the firewall's configuration, its rules applied once, and seen from the network.
# The configuration takes its place only once that worked: the Docker channel starts no runner container where
# it is in place and the firewall does not report its rules in force.
firewall_configure() {
  local gateway="$1" bridge dns dns_before=0
  [ "$(docker network inspect -f '{{.EnableIPv6}}' "$MR_NETWORK")" = false ] \
    || die "network $MR_NETWORK has IPv6 on, which the managed runners' firewall leaves them none of: remove it, or
       make it again IPv4-only (docker network create --ipv6=false ...). $FIREWALL_HELP"
  bridge="$(docker network inspect -f '{{with index .Options "com.docker.network.bridge.name"}}{{.}}{{else}}br-{{printf "%.12s" .Id}}{{end}}' "$MR_NETWORK")"
  # The DNS servers Docker's resolver forwards to from a container's own namespace, which the rules must leave.
  dns="$(on_runner_network docker-dns)" || die "could not read the DNS servers Docker gives the managed runners' network"
  [[ "$dns" =~ ^\[.*\]$ ]] || die "the managed runners' DNS servers came back as $dns"
  if on_runner_network probe --resolve registry-1.docker.io >/dev/null 2>&1; then dns_before=1; fi
  echo "==> Writing $MR_DIR/firewall (the managed runners' firewall: bridge $bridge, gateway $gateway:$MR_API_PORT)"
  ( umask 077 && mkdir -p "$MR_DIR/firewall" )
  ( umask 077 && cat >"$MR_DIR/firewall/config.json.new" <<EOF
{
  "schemaVersion": 1,
  "network": "$MR_NETWORK",
  "bridge": "$bridge",
  "gateway": "$gateway",
  "apiPort": $MR_API_PORT,
  "dnsServers": $dns,
  "allow": [],
  "intervalSeconds": 10
}
EOF
  )
  echo "==> Applying the managed runners' firewall rules"
  firewall_run apply --config /var/lib/orbit-managed-runner-firewall/config.json.new \
    || die "the managed runners' firewall rules could not be applied (the reason is above). $FIREWALL_HELP"
  echo "==> Checking from the managed runners' network that this host and private addresses are refused"
  on_runner_network probe --blocked "$gateway:1" --blocked 169.254.169.254:80 --blocked 10.255.255.1:9 \
    || die "the managed runners' firewall rules are applied but a runner is not refused (above). $FIREWALL_HELP"
  if [ "$dns_before" -eq 1 ]; then
    on_runner_network probe --resolve registry-1.docker.io \
      || die "the managed runners' firewall rules broke DNS on their network (above). $FIREWALL_HELP"
  fi
  mv -f "$MR_DIR/firewall/config.json.new" "$MR_DIR/firewall/config.json"
}

# Once the stack is up: the designed way to the apiserver, through the gateway's published port.
firewall_reach_check() {
  local gateway="$1"
  echo "==> Checking from the managed runners' network that the gateway's port $MR_API_PORT is reached"
  on_runner_network probe --reach "$gateway:$MR_API_PORT" --attempts 15 \
    || die "the managed runners' firewall is in force but a runner does not reach the gateway at $gateway:$MR_API_PORT
       (above): managed runners cannot reach this deployment. Check docker compose ps and
       docker compose logs managed-runner-firewall."
}

# ── an administrator adds the firewall to a deployment that has managed runners ─────────────────────

if [ "$ENABLE_FIREWALL" -eq 1 ]; then
  docker network inspect "$MR_NETWORK" >/dev/null 2>&1 || die "network $MR_NETWORK does not exist"
  server="$(grep -oE '"serverUrl"[[:space:]]*:[[:space:]]*"[^"]*"' "$MR_DIR/profile.json" | sed -E 's/.*"([^"]*)"$/\1/')"
  gateway=""
  for address in $(docker network inspect -f '{{range .IPAM.Config}}{{.Gateway}} {{end}}' "$MR_NETWORK"); do
    case "$address" in *.*.*.*) gateway="$address"; break ;; esac
  done
  [ "$server" = "http://$gateway:$MR_API_PORT" ] \
    || die "runner.serverUrl in $MR_DIR/profile.json is $server, not http://$gateway:$MR_API_PORT, the gateway's port at
       this host's address on $MR_NETWORK, which is the one way the firewall leaves a runner to this host. Point it
       there first (docs/managed-runner-docker-operations.md, \"Plain HTTP to the server\")."
  firewall_preflight
  firewall_configure "$gateway"
  echo "==> Adding $FW_PROFILE to COMPOSE_PROFILES in .env"
  NEW_ENV="$(mktemp .env.install.XXXXXX)"
  trap 'rm -f "$NEW_ENV"' EXIT
  # The note an install with --no-managed-runner-firewall left goes too: it would say the firewall is off.
  sed -e "s/^COMPOSE_PROFILES=managed-runners-docker\$/COMPOSE_PROFILES=managed-runners-docker,$FW_PROFILE/" \
      -e "/^# The managed runners' host firewall is OFF:/,/--enable-managed-runner-firewall adds it\.\$/d" .env >"$NEW_ENV"
  if [ -n "$FW_LOCK_LINE" ]; then echo "$FW_LOCK_LINE" >>"$NEW_ENV"; fi
  mv "$NEW_ENV" .env
  trap - EXIT
  if [ "$START" -eq 0 ]; then
    echo "✓ The managed runners' firewall rules are in force. No runner container starts until its service runs, which keeps"
    echo "  them: docker compose up -d --wait $FW_SERVICE"
    exit 0
  fi
  echo "==> Starting the managed runners' firewall"
  docker compose build "$FW_SERVICE"
  docker compose up -d --wait --wait-timeout 120 --no-deps "$FW_SERVICE"
  firewall_reach_check "$gateway"
  echo "✓ The managed runners' firewall is on: they reach the gateway's port $MR_API_PORT, DNS and public addresses only."
  exit 0
fi

# ── managed runners ─────────────────────────────────────────────────────────────────────────────────

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
  # published port, at the host's address on this network. IPv4 only, whatever Docker's defaults: the
  # firewall's rules are IPv4's, and they reject anything IPv6 from it.
  if ! docker network inspect "$MR_NETWORK" >/dev/null 2>&1; then
    echo "==> Creating the managed runners' network $MR_NETWORK"
    docker network create --driver bridge --ipv6=false --opt com.docker.network.bridge.enable_icc=false "$MR_NETWORK" >/dev/null
  fi
  [ "$(docker network inspect -f '{{index .Options "com.docker.network.bridge.enable_icc"}}' "$MR_NETWORK")" = false ] \
    || die "network $MR_NETWORK exists and lets containers reach one another; remove it or create it with com.docker.network.bridge.enable_icc=false"
  local address
  MR_GATEWAY=""
  for address in $(docker network inspect -f '{{range .IPAM.Config}}{{.Gateway}} {{end}}' "$MR_NETWORK"); do
    case "$address" in *.*.*.*) MR_GATEWAY="$address"; break ;; esac
  done
  [ -n "$MR_GATEWAY" ] || die "network $MR_NETWORK has no IPv4 gateway address"

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
    "serverUrl": "http://$MR_GATEWAY:$MR_API_PORT",
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
    if [ "$FIREWALL" -eq 0 ]; then
      echo "# The managed runners' host firewall is OFF: installed with --no-managed-runner-firewall, so a managed runner"
      echo "# can reach every service this host listens to and the private networks behind it (docs/self-hosting.md,"
      echo "# \"Isolation and its limits\"). scripts/install-server.sh --enable-managed-runner-firewall adds it."
    fi
    mr_lines
  else
    echo "ORBIT_MANAGED_RUNNERS_ENABLED=false"
  fi
}

if [ "$MANAGED" -eq 1 ] && [ "$FIREWALL" -eq 1 ]; then
  firewall_preflight
fi
if [ "$MANAGED" -eq 1 ]; then
  prepare_managed_runners
fi
if [ "$MANAGED" -eq 1 ] && [ "$FIREWALL" -eq 1 ]; then
  firewall_configure "$MR_GATEWAY"
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
  if [ "$MANAGED" -eq 1 ] && [ "$FIREWALL" -eq 1 ]; then
    echo "  The managed runners' firewall rules are in force; its service starts with the stack and keeps them."
  fi
  if [ "$MANAGED" -eq 1 ] && [ "$FIREWALL" -eq 0 ]; then
    echo "!! warning: $FIREWALL_OFF_WARNING" >&2
  fi
  echo "✓ Configuration written. Start the stack with: docker compose up -d --build --wait"
  exit 0
fi

if [ "$ENABLE_EXISTING" -eq 1 ]; then
  # Only the channel (and the firewall) are built: the apiserver is recreated from the image it runs now, so
  # switching managed runners on deploys no other change. --no-deps leaves postgres alone.
  if [ "$FIREWALL" -eq 1 ]; then
    echo "==> Starting the managed runners' firewall"
    docker compose build "$FW_SERVICE"
    docker compose up -d --wait --wait-timeout 120 --no-deps "$FW_SERVICE"
  fi
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
  if [ "$FIREWALL" -eq 1 ]; then
    firewall_reach_check "$MR_GATEWAY"
    echo "✓ The managed runners' firewall is on: they reach the gateway's port $MR_API_PORT, DNS and public addresses only."
  else
    echo "!! warning: $FIREWALL_OFF_WARNING" >&2
  fi
fi
if [ "$ENABLE_EXISTING" -eq 1 ]; then
  echo "✓ Managed runners are on: every account that signs in from now on gets one."
else
  echo "✓ Orbit is running. Open ${PUBLIC_ORIGIN:-http://localhost:2086}: the first visitor creates the administrator at /setup."
fi
