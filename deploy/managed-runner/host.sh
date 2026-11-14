# The managed runners' host, prepared the same way by scripts/install-server.sh (managed runners on the deployment's own
# host) and by the channel-host kit, deploy/managed-runner/remote-host/remote-host.sh (on another host): their network, their
# image, and their host firewall. Sourced, never run. The caller sets REPO_ROOT, MR_DIR (the managed runners' directory,
# relative to REPO_ROOT or absolute), MR_NETWORK, MR_API_PORT, FW_IMAGE and FIREWALL_HELP, defines die, and runs from
# REPO_ROOT.

# ── the managed runners' network ────────────────────────────────────────────────────────────────────

# Sets MR_GATEWAY: this host's address on the network.
managed_runner_network() {
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
}

# ── the managed runner image ────────────────────────────────────────────────────────────────────────

# Builds orbit-managed-runner:local from deploy/managed-runner/image at this checkout, stamped with commit $1.
managed_runner_image_build_from() {
  echo "==> Building the managed runner image from deploy/managed-runner/image (local, never pushed)"
  # No provenance attestation, which BuildKit makes anew for every build: in Docker's containerd image store it
  # would give the same image a new ID each time. /upgrade builds it the same way and compares the IDs.
  docker build --provenance=false -f deploy/managed-runner/image/Dockerfile --build-arg "ORBIT_SOURCE_SHA=$1" \
    -t orbit-managed-runner:local .
}

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
