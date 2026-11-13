#!/usr/bin/env bash
# The channel host of managed runners on another machine (docs/self-hosting.md, "Managed runners on another host";
# docs/managed-runner-remote-host-design.md, items 3-5, D2 and D3). Run as root, from a checkout of this repository on
# the channel host, which builds the managed runner image here and never pushes it.
#
#   install --listen <private IPv4 of this host> --allow-peer <apiserver host's address> [...]
#           the managed runners' network, the channel's token and channel.json, the firewall's config.json, the images,
#           both services of compose.yml started; then the entry to add to the server's profile.json and where the token is
#   upgrade <commit>
#           that commit checked out, the images rebuilt, channel.json switched to the new runner image and the channel
#           recreated on it. Run after each deploy of the server, with the commit it deployed (D3)
#   status  what runs here: the instance, the image channel.json names and the one built, both services, the firewall's
#           status and the runner containers
#
# Network, image and firewall are prepared by the same code as scripts/install-server.sh's (deploy/managed-runner/host.sh),
# and the switch to a new image is the one /upgrade makes on a single host (.claude/skills/upgrade/upgrade.sh), for
# channel.json alone: the server's profile names "image": "channel" and takes the ID this channel reports.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: deploy/managed-runner/remote-host/remote-host.sh install --listen ADDRESS --allow-peer ADDRESS [--allow-peer ADDRESS ...]
                                                              [--port PORT] [--instance ID] [--commit SHA]
       deploy/managed-runner/remote-host/remote-host.sh upgrade SHA
       deploy/managed-runner/remote-host/remote-host.sh status

  --listen ADDRESS      the private IPv4 address of this host the channel listens on (10/8, 172.16/12, 192.168/16, 100.64/10)
  --allow-peer ADDRESS  an apiserver host's address the channel takes connections from; at least one
  --port PORT           the channel's port (default 7300)
  --instance ID         the channel's instance ID, the label value of everything it makes (default orbit-<8 hex>)
  --commit SHA          build from this commit (default: the checkout as it is, which must be clean)

  ORBIT_CHANNEL_HOST_DIR  the kit's directory (default data/channel-host in this checkout)
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

ORIGINAL_ARGS=("$@")
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

MR_DIR="${ORBIT_CHANNEL_HOST_DIR:-data/channel-host}"
MR_NETWORK=orbit-managed-runners
# The firewall leaves a runner one port of this host's address on its network: on a single host, the gateway's. Nothing
# of Orbit listens there on a channel host, and the channel's own port must not be it.
MR_API_PORT=2086
MR_TAG=orbit-managed-runner:local
FW_IMAGE=orbit-managed-runner-firewall:local
FW_LOCK_LINE=""
FIREWALL_HELP="Fix that first: a channel host always firewalls its managed runners (docs/self-hosting.md, \"Isolation and its limits\")."
COMPOSE_FILE=deploy/managed-runner/remote-host/compose.yml
MOUNT=/var/lib/orbit-managed-runners
# shellcheck source=../host.sh
source "$REPO_ROOT/deploy/managed-runner/host.sh"

abs_dir() {
  case "$MR_DIR" in /*) echo "$MR_DIR" ;; *) echo "$REPO_ROOT/$MR_DIR" ;; esac
}
dc() {
  docker compose -f "$COMPOSE_FILE" --env-file "$MR_DIR/compose.env" "$@"
}
# A program of the channel's image on the kit's directory, read-only, with no network.
in_channel_image() {
  docker run --rm --network none -v "$(abs_dir):$MOUNT:ro" "$@"
}
# One member of channel.json, read with the channel image's Python.
channel_field() {
  in_channel_image --entrypoint python3 orbit-docker-channel:local -I -c \
    "import json, sys; v = json.load(open('$MOUNT/channel.json'))$1; print(v if isinstance(v, str) else json.dumps(v))"
}
# The image ID a file names: its one "image" member, sha256:<64 hex> (as /upgrade reads it).
image_in() {
  local ids
  ids="$(grep -oE '"image"[[:space:]]*:[[:space:]]*"sha256:[0-9a-f]{64}"' "$1" | grep -oE 'sha256:[0-9a-f]{64}' || true)"
  [ -n "$ids" ] && [ "$(printf '%s\n' "$ids" | grep -c .)" -eq 1 ] \
    || die "$1 must name the managed runner image once, as \"image\": \"sha256:<64 hex>\""
  printf '%s\n' "$ids"
}
built_image() {
  local id
  id="$(docker image inspect -f '{{.Id}}' "$MR_TAG")"
  [[ "$id" =~ ^sha256:[0-9a-f]{64}$ ]] || die "$MR_TAG has no local image ID of the form sha256:<64 hex>"
  printf '%s\n' "$id"
}

# One install or upgrade at a time, with /upgrade's lock: a directory holding its owner's pid. The pid survives the exec
# into a new checkout below, so the process that comes back from it finds the lock its own.
LOCK_DIR="/tmp/orbit-channel-host.lock"
take_lock() {
  local holder
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    holder="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
    if [ "$holder" != "$$" ]; then
      if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
        die "another install or upgrade is in progress (pid $holder, lock $LOCK_DIR)"
      fi
      echo "warning: taking over a stale lock (holder ${holder:-unknown} is gone)" >&2
      rm -rf "$LOCK_DIR"
      mkdir "$LOCK_DIR" 2>/dev/null || die "another install or upgrade claimed the stale lock first"
    fi
  fi
  trap 'rm -rf "$LOCK_DIR"' EXIT
  echo "$$" >"$LOCK_DIR/pid"
}

# The commit to build, checked out on a detached HEAD, and this script started again from it, so that every later step
# is that commit's. Images are built from the working tree, so it must hold what the commit holds: uncommitted changes to
# tracked files stop it, as /upgrade stops on them.
check_out() {
  local want="$1" full dirty
  dirty="$(git status --porcelain --untracked-files=no 2>/dev/null || true)"
  [ -z "$dirty" ] || die "uncommitted changes in $REPO_ROOT would be built into the image: commit or remove them first
$(printf '%s\n' "$dirty" | sed 's/^/       /')"
  if ! full="$(git rev-parse -q --verify "$want^{commit}")"; then
    echo "==> Fetching: $want is not in this checkout"
    git fetch -q origin || die "git fetch origin failed"
    full="$(git rev-parse -q --verify "$want^{commit}")" || die "no commit $want in this checkout or in origin"
  fi
  if [ "$full" != "$(git rev-parse HEAD)" ]; then
    echo "==> Checking out $full"
    git -c advice.detachedHead=false checkout -q --detach "$full"
  fi
  if [ "${ORBIT_CHANNEL_HOST_AT:-}" != "$full" ]; then
    [ -x "$SCRIPT_DIR/remote-host.sh" ] || die "commit $full has no channel-host kit (deploy/managed-runner/remote-host)"
    ORBIT_CHANNEL_HOST_AT="$full" exec "$SCRIPT_DIR/remote-host.sh" "${ORIGINAL_ARGS[@]}"
  fi
}

# ── install ─────────────────────────────────────────────────────────────────────────────────────────

install() {
  local listen="" port=7300 instance="" commit="" peers=() peer image_id address listed
  while [ $# -gt 0 ]; do
    case "$1" in
      --listen) listen="${2:?--listen needs an address}"; shift ;;
      --allow-peer) peers+=("${2:?--allow-peer needs an address}"); shift ;;
      --port) port="${2:?--port needs a port}"; shift ;;
      --instance) instance="${2:?--instance needs an ID}"; shift ;;
      --commit) commit="${2:?--commit needs a commit}"; shift ;;
      -h|--help) usage; exit 0 ;;
      *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
    esac
    shift
  done
  [ -n "$listen" ] || die "--listen is required: the private address of this host the apiserver reaches the channel at"
  [ "${#peers[@]}" -gt 0 ] || die "--allow-peer is required: the address the apiserver's host connects from"
  [[ "$port" =~ ^[0-9]+$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || die "--port must be 1 to 65535"
  [ "$port" -ne "$MR_API_PORT" ] || die "--port must not be $MR_API_PORT, the one port of this host the firewall leaves a runner"
  [ -n "$instance" ] || instance="orbit-$(openssl rand -hex 4)"
  [ ! -e "$MR_DIR/channel.json" ] || die "$MR_DIR/channel.json exists: this host is installed. Use upgrade <sha> or status."
  [ ! -e "$MR_DIR/state" ] || die "$MR_DIR/state exists: a Docker channel has run from this checkout."
  if docker container inspect orbit-docker-channel >/dev/null 2>&1; then
    die "a container orbit-docker-channel exists on this host already: a host runs one Docker channel"
  fi
  if listed="$(ip -4 -o addr show 2>/dev/null | awk '{ sub(/\/.*/, "", $4); print $4 }')" && [ -n "$listed" ]; then
    printf '%s\n' "$listed" | grep -qxF "$listen" || die "$listen is not an address of this host (it has $(printf '%s ' $listed))"
  fi
  command -v openssl >/dev/null || die "openssl is needed to make the channel's token"
  docker compose version >/dev/null 2>&1 || die "Docker with the Compose plugin (docker compose) is needed"

  take_lock
  check_out "${commit:-HEAD}"
  local source_sha
  source_sha="$(git rev-parse HEAD)"

  firewall_preflight
  managed_runner_network
  managed_runner_image_build_from "$source_sha"
  image_id="$(built_image)"

  echo "==> Writing $MR_DIR (the Docker channel's token and channel.json)"
  ( umask 077 && mkdir -p "$MR_DIR" )
  chmod 700 "$MR_DIR"
  ( umask 077 && openssl rand -hex 32 >"$MR_DIR/token" )
  local peer_list=""
  for peer in "${peers[@]}"; do peer_list="${peer_list:+$peer_list, }\"$peer\""; done
  # The same limits as a single host's install. channel.json names paths inside the channel's container, where
  # compose.yml mounts this directory at /var/lib/orbit-managed-runners.
  ( umask 077 && cat >"$MR_DIR/channel.json.new" <<EOF
{
  "schemaVersion": 1,
  "instanceId": "$instance",
  "listen": { "tcp": { "host": "$listen", "port": $port }, "allowPeers": [$peer_list] },
  "tokenFile": "$MOUNT/token",
  "dockerSocket": "/var/run/docker.sock",
  "stateDir": "$MOUNT/state",
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
  ( umask 077 && {
    echo "# Written by deploy/managed-runner/remote-host/remote-host.sh install: what compose.yml reads."
    echo "ORBIT_CHANNEL_HOST_DIR=$(abs_dir)"
    [ -z "$FW_LOCK_LINE" ] || echo "$FW_LOCK_LINE"
  } >"$MR_DIR/compose.env" )
  echo "==> Building the Docker channel"
  dc build docker-channel
  echo "==> Checking channel.json"
  in_channel_image orbit-docker-channel:local check-config --config "$MOUNT/channel.json.new" \
    || die "the channel refuses the configuration written to $MR_DIR/channel.json.new (above)"
  mv -f "$MR_DIR/channel.json.new" "$MR_DIR/channel.json"

  firewall_configure "$MR_GATEWAY"

  echo "==> Starting the managed runners' firewall and the Docker channel"
  dc up -d --wait --wait-timeout 120 managed-runner-firewall docker-channel
  dc ps

  cat <<EOF

✓ This host serves managed runners as instance $instance, at http://$listen:$port for ${peers[*]}.

  On the server, add this host to docker.hosts in the managed runners' profile.json:

    { "instanceId": "$instance", "channel": { "url": "http://$listen:$port" }, "tokenFile": "$MOUNT/$instance.token" }

  and copy the channel's token, $(abs_dir)/token, into the server's managed runners directory as $instance.token,
  mode 0600 like the files beside it. A profile whose hosts are all remote names "image": "channel" under runner
  and an https runner.serverUrl. Then recreate the apiserver (docs/self-hosting.md, "Managed runners on another host").
  After each deploy of the server: $0 upgrade <the commit it deployed>
EOF
}

# ── upgrade ─────────────────────────────────────────────────────────────────────────────────────────

upgrade() {
  [ $# -eq 1 ] || { usage >&2; exit 2; }
  [ -f "$MR_DIR/channel.json" ] && [ -f "$MR_DIR/compose.env" ] || die "$MR_DIR holds no channel.json: install first"
  take_lock
  check_out "$1"
  local source_sha before image_id switch=0
  source_sha="$(git rev-parse HEAD)"
  before="$(image_in "$MR_DIR/channel.json")"

  echo "==> Building the Docker channel and the managed runners' firewall"
  dc build docker-channel managed-runner-firewall
  managed_runner_image_build_from "$source_sha"
  image_id="$(built_image)"

  # As /upgrade switches it: the file replaced whole by a rename, once its copy is whole and the channel takes it, and
  # .image-switch marking a switch written and not yet started on, which the next run starts on whatever it built.
  if [ "$before" = "$image_id" ] && [ ! -e "$MR_DIR/.image-switch" ]; then
    echo "==> The managed runner image is unchanged ($image_id)"
  else
    switch=1
    echo "$image_id" >"$MR_DIR/.image-switch"
    cp -p "$MR_DIR/channel.json" "$MR_DIR/channel.json.new"
    sed -E "s/(\"image\"[[:space:]]*:[[:space:]]*\")sha256:[0-9a-f]{64}\"/\\1$image_id\"/" "$MR_DIR/channel.json" >"$MR_DIR/channel.json.new"
    if [ "$(image_in "$MR_DIR/channel.json.new")" != "$image_id" ] \
      || [ "$(wc -c <"$MR_DIR/channel.json.new")" -ne "$(wc -c <"$MR_DIR/channel.json")" ]; then
      die "could not write the new image ID into a copy of $MR_DIR/channel.json; nothing was recreated"
    fi
    in_channel_image orbit-docker-channel:local check-config --config "$MOUNT/channel.json.new" \
      || die "the channel refuses $MR_DIR/channel.json.new (above); nothing was recreated"
    mv -f "$MR_DIR/channel.json.new" "$MR_DIR/channel.json"
    echo "==> The managed runner image is now $image_id in channel.json"
    echo "    (it was $before: containers made from it keep running on it until they stop)"
  fi

  # The firewall first, recreated only if its image changed; it leaves its rules in place while it restarts.
  echo "==> Recreating the managed runners' firewall if it changed"
  dc up -d --wait --wait-timeout 120 --no-deps managed-runner-firewall
  if [ "$switch" -eq 1 ]; then
    echo "==> Recreating docker-channel to read channel.json"
    dc up -d --wait --wait-timeout 120 --no-deps --force-recreate docker-channel
    rm -f "$MR_DIR/.image-switch"
  else
    echo "==> Recreating docker-channel if it changed"
    dc up -d --wait --wait-timeout 120 --no-deps docker-channel
  fi
  echo "✓ Upgraded to $source_sha."
  status
}

# ── status ──────────────────────────────────────────────────────────────────────────────────────────

status() {
  [ $# -eq 0 ] || { usage >&2; exit 2; }
  [ -f "$MR_DIR/channel.json" ] || die "$MR_DIR holds no channel.json: this host is not installed"
  local instance configured built revision
  instance="$(channel_field "['instanceId']")"
  configured="$(image_in "$MR_DIR/channel.json")"
  built="$(docker image inspect -f '{{.Id}}' "$MR_TAG" 2>/dev/null || echo none)"
  revision="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$configured" 2>/dev/null || echo unknown)"
  echo "Instance:     $instance"
  echo "Listens on:   $(channel_field "['listen']['tcp']") for $(channel_field "['listen']['allowPeers']")"
  echo "Checkout:     $(git rev-parse HEAD)"
  echo "Image:        $configured in channel.json, built from $revision"
  if [ "$built" != "$configured" ]; then
    echo "              $MR_TAG is $built: not the one channel.json names"
  fi
  if [ -e "$MR_DIR/.image-switch" ]; then
    echo "              a switch to $(cat "$MR_DIR/.image-switch") is unfinished: run upgrade again"
  fi
  echo "Firewall:     $(cat "$MR_DIR/firewall/status.json" 2>/dev/null | tr -d '\n' | sed -E 's/[[:space:]]+/ /g' || echo 'no status')"
  echo "Services:"
  dc ps --format '  {{.Service}}: {{.Status}}' 2>/dev/null || dc ps
  echo "Runner containers of $instance:"
  docker ps -a --filter "label=orbit.managed-runner.instance=$instance" --filter label=orbit.managed-runner.kind=runner \
    --format '  {{.Names}} {{.Status}} {{.Image}}'
  echo "Data volumes: $(docker volume ls -q --filter "label=orbit.managed-runner.instance=$instance" | grep -c '^mr-data-' || true)"
}

case "${1:-}" in
  install) shift; install "$@" ;;
  upgrade) shift; upgrade "$@" ;;
  status) shift; status "$@" ;;
  -h|--help) usage ;;
  *) usage >&2; exit 2 ;;
esac
