#!/usr/bin/env bash
# Starts the runner link staging stack, or brings a running one up to this checkout: postgres, the apiserver, web, the
# web gateway, the link gateway and NATS, from the root docker-compose.yml under a Compose project of its own (README.md
# beside this file). Running it again converges: images are rebuilt from this checkout and changed containers
# recreated, while the database, the secrets, the TLS material and the seeded account are kept. staging-down.sh stops
# it.
#
#   scripts/runner-link/staging-up.sh                # build, start, seed, smoke-check
#   scripts/runner-link/staging-up.sh --rotate-cert  # also give the link gateway a new certificate, in place
#   scripts/runner-link/staging-up.sh --no-build     # reuse the images built last time
#
# Settings are environment variables; a run without one keeps the value the last run recorded, else the default:
#   ORBIT_LINK_STAGING_PROJECT       Compose project and container name prefix   orbit-link-staging
#   ORBIT_LINK_STAGING_DIR           state: database, secrets, TLS, env file      /var/tmp/<project>
#   ORBIT_LINK_STAGING_BIND          address the host ports listen on             127.0.0.1
#   ORBIT_LINK_STAGING_HOST          the name clients use, in URLs and the cert  localhost
#   ORBIT_LINK_STAGING_HTTP_PORT     web and /api, through the web gateway        18086
#   ORBIT_LINK_STAGING_LINK_PORT     the link gateway                             18443
#   ORBIT_LINK_STAGING_METRICS_PORT  the link gateway's metrics, on 127.0.0.1     19464
#   ORBIT_LINK_STAGING_TLS           files (a staging CA), or acme (Pebble)       files
#   ORBIT_LINK_STAGING_NATS_PORT     NATS's client port, on the bind address      14222
#   ORBIT_LINK_STAGING_NATS_MONITOR_PORT  NATS's monitoring, on 127.0.0.1         18222
#   ORBIT_LINK_STAGING_MODE          http (shadow) or link (forwarding)           http
#   ORBIT_LINK_STAGING_BACKENDS      apiservers the gateway forwards to: 1 to 16  1
#   ORBIT_LINK_STAGING_LINK_BACKENDS which of them it forwards to: all, or names  all
#                                    such as apiserver-b, comma-separated (the web's requests reach apiserver)
#   ORBIT_LINK_STAGING_GATEWAYS      link gateway nodes: 1, or 2 behind a TCP balancer            1
#                                    (staging.gateways.compose.yml), which then takes the link port
#   ORBIT_LINK_STAGING_METRICS_PORT_B  the second node's metrics, on 127.0.0.1                    19465
#   ORBIT_LINK_STAGING_HANDSHAKE_RATE_B  the second node's LINK_HANDSHAKE_RATE, a second          200
#   ORBIT_LINK_STAGING_HANDSHAKE_BURST_B the second node's LINK_HANDSHAKE_BURST                   400
#   ORBIT_LINK_STAGING_LOADGEN       1: the load test's settings (staging.loadgen.compose.yml)   0
#   ORBIT_LINK_STAGING_DB_CPUS       with LOADGEN=1, the database's CPU allocation; 0 is unlimited   0
#   ORBIT_LINK_STAGING_DB_MEM        with LOADGEN=1, the database's memory limit (Compose mem_limit)  4g
#   ORBIT_LINK_STAGING_MERGE_WINDOW  the link gateway's LINK_EVENT_MERGE_WINDOW: 0 forwards each event
#                                    batch alone; "default" is the gateway's own                         default
#   ORBIT_LINK_STAGING_INGEST_RATE   the link gateway's LINK_DRILL_INGEST_RATE: the durable events a second it
#                                    forwards at most, for a load test of a slow ingest; off forwards them as they come  off
#   ORBIT_LINK_STAGING_MERGE_CALLS   the link gateway's LINK_EVENT_MERGE_CALLS_PER_BACKEND: merged calls out at once
#                                    to each apiserver, 1 to 8; "default" is the gateway's own (4)                       default
set -euo pipefail
# shellcheck source=staging-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/staging-lib.sh"

rotate=0
build=1
for arg in "$@"; do
  case "$arg" in
    --rotate-cert) rotate=1 ;;
    --no-build) build=0 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) die "unknown option $arg (see --help)" ;;
  esac
done
for tool in docker openssl curl node flock git base64; do
  command -v "$tool" >/dev/null || die "$tool is required"
done
lock_state

bind="${ORBIT_LINK_STAGING_BIND:-$(setting STAGING_BIND 127.0.0.1)}"
host="${ORBIT_LINK_STAGING_HOST:-$(setting STAGING_HOST localhost)}"
http_port="${ORBIT_LINK_STAGING_HTTP_PORT:-$(setting STAGING_HTTP_PORT 18086)}"
link_port="${ORBIT_LINK_STAGING_LINK_PORT:-$(setting STAGING_LINK_PORT 18443)}"
metrics_port="${ORBIT_LINK_STAGING_METRICS_PORT:-$(setting STAGING_METRICS_PORT 19464)}"
tls_mode="${ORBIT_LINK_STAGING_TLS:-$(setting STAGING_TLS files)}"
nats_port="${ORBIT_LINK_STAGING_NATS_PORT:-$(setting STAGING_NATS_PORT 14222)}"
nats_monitor_port="${ORBIT_LINK_STAGING_NATS_MONITOR_PORT:-$(setting STAGING_NATS_MONITOR_PORT 18222)}"
pebble_port="${ORBIT_LINK_STAGING_PEBBLE_PORT:-$(setting STAGING_PEBBLE_MGMT_PORT 15000)}"
mode="${ORBIT_LINK_STAGING_MODE:-$(setting STAGING_MODE http)}"
backends="${ORBIT_LINK_STAGING_BACKENDS:-$(setting STAGING_BACKENDS 1)}"
link_backends="${ORBIT_LINK_STAGING_LINK_BACKENDS:-$(setting STAGING_LINK_BACKENDS all)}"
loadgen="${ORBIT_LINK_STAGING_LOADGEN:-$(setting STAGING_LOADGEN 0)}"
db_cpus="${ORBIT_LINK_STAGING_DB_CPUS:-$(setting STAGING_DB_CPUS 0)}"
db_mem="${ORBIT_LINK_STAGING_DB_MEM:-$(setting STAGING_DB_MEM 4g)}"
merge_window="${ORBIT_LINK_STAGING_MERGE_WINDOW:-$(setting STAGING_MERGE_WINDOW_SETTING default)}"
gateways="${ORBIT_LINK_STAGING_GATEWAYS:-$(setting STAGING_GATEWAYS 1)}"
metrics_port_b="${ORBIT_LINK_STAGING_METRICS_PORT_B:-$(setting STAGING_METRICS_PORT_B 19465)}"
handshake_rate="${ORBIT_LINK_STAGING_HANDSHAKE_RATE_B:-$(setting STAGING_HANDSHAKE_RATE_B 200)}"
handshake_burst="${ORBIT_LINK_STAGING_HANDSHAKE_BURST_B:-$(setting STAGING_HANDSHAKE_BURST_B 400)}"
ingest_rate="${ORBIT_LINK_STAGING_INGEST_RATE:-$(setting STAGING_INGEST_RATE_SETTING off)}"
merge_calls="${ORBIT_LINK_STAGING_MERGE_CALLS:-$(setting STAGING_MERGE_CALLS_SETTING default)}"
acme_domain="link.orbit-staging.test"
case "$tls_mode" in files|acme) ;; *) die "ORBIT_LINK_STAGING_TLS must be files or acme, not $tls_mode" ;; esac
case "$mode" in http|link) ;; *) die "ORBIT_LINK_STAGING_MODE must be http or link, not $mode" ;; esac
case "$loadgen" in 0|1) ;; *) die "ORBIT_LINK_STAGING_LOADGEN must be 0 or 1, not $loadgen" ;; esac
[[ "$db_cpus" =~ ^[0-9]+(\.[0-9]+)?$ ]] || die "ORBIT_LINK_STAGING_DB_CPUS must be a number of CPUs, not $db_cpus"
[[ "$db_mem" =~ ^[1-9][0-9]*[mg]$ ]] || die "ORBIT_LINK_STAGING_DB_MEM must be a size such as 4g or 16384m, not $db_mem"
[[ "$merge_window" =~ ^(default|0|[0-9]+ms)$ ]] || die "ORBIT_LINK_STAGING_MERGE_WINDOW must be default, 0 or a window such as 100ms, not $merge_window"
gateway_merge_window="$merge_window"
[ "$merge_window" = default ] && gateway_merge_window=""
[[ "$ingest_rate" =~ ^(off|[1-9][0-9]*)$ ]] || die "ORBIT_LINK_STAGING_INGEST_RATE must be off or events a second such as 300, not $ingest_rate"
gateway_ingest_rate="$ingest_rate"
[ "$ingest_rate" = off ] && gateway_ingest_rate=""
[[ "$merge_calls" =~ ^(default|[1-8])$ ]] || die "ORBIT_LINK_STAGING_MERGE_CALLS must be default or 1 to 8 merged calls an apiserver, not $merge_calls"
gateway_merge_calls="$merge_calls"
[ "$merge_calls" = default ] && gateway_merge_calls=""
[[ "$backends" =~ ^([1-9]|1[0-6])$ ]] || die "ORBIT_LINK_STAGING_BACKENDS must be 1 to 16, not $backends"
case "$gateways" in 1|2) ;; *) die "ORBIT_LINK_STAGING_GATEWAYS must be 1 or 2, not $gateways" ;; esac
[[ "$handshake_rate" =~ ^[0-9]+(\.[0-9]+)?$ ]] || die "ORBIT_LINK_STAGING_HANDSHAKE_RATE_B must be handshakes a second, not $handshake_rate"
[[ "$handshake_burst" =~ ^[1-9][0-9]*$ ]] || die "ORBIT_LINK_STAGING_HANDSHAKE_BURST_B must be a positive whole number, not $handshake_burst"
# The first apiserver, then apiserver-b, apiserver-c and on (extra_backends), each the first one's whole definition on
# the same database; the link gateway forwards to all of them, round robin, or to those ORBIT_LINK_STAGING_LINK_BACKENDS
# names: with apiserver-b alone, every call of a runner lands on a process the web's requests never reach
# (staging-check-relay.sh).
extras=()
mapfile -t extras < <(extra_backends "$backends")
linked=(apiserver "${extras[@]}")
if [ "$link_backends" != all ]; then
  IFS=, read -r -a linked <<<"$link_backends"
  for b in "${linked[@]}"; do
    [[ " apiserver ${extras[*]} " == *" $b "* ]] || die "ORBIT_LINK_STAGING_LINK_BACKENDS names $b, which is not one of the stack's apiservers: apiserver ${extras[*]}"
  done
fi
backend_urls=""
for b in "${linked[@]}"; do backend_urls+="${backend_urls:+,}http://$b:3001"; done

# --- Secrets: made once and kept, so a rerun keeps the database's tokens valid. -----------------------------------
secrets="$state/secrets"
mkdir -p "$secrets" "$state/postgres" "$state/pg-archive" "$state/tls" "$state/gateway/tls"
chmod 700 "$secrets"
for name in jwt_secret provider_secret_key gateway_token owner_password; do
  [ -s "$secrets/$name" ] || (umask 077; openssl rand -base64 32 | tr -d '\n' > "$secrets/$name")
done
[ -s "$secrets/runner-link.pem" ] || (umask 077; openssl genpkey -algorithm ed25519 -out "$secrets/runner-link.pem")
signing_key="$(base64 -w0 "$secrets/runner-link.pem")"
public_key="$(openssl pkey -in "$secrets/runner-link.pem" -pubout | base64 -w0)"

# --- TLS. -------------------------------------------------------------------------------------------------------------
tls="$state/tls"
gw="$state/gateway"
if [ ! -s "$tls/ca.pem" ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
    -subj "/CN=Orbit runner link staging CA ($project)" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -keyout "$tls/ca.key" -out "$tls/ca.pem" 2>/dev/null
  chmod 600 "$tls/ca.key"
fi
# What a client trusts for the link: the system's roots and the staging CA (SSL_CERT_FILE takes one file).
system_roots=/etc/ssl/certs/ca-certificates.crt
{ [ -f "$system_roots" ] && cat "$system_roots"; cat "$tls/ca.pem"; } > "$tls/ca-bundle.pem"

sans="DNS:localhost,DNS:link-gateway,IP:127.0.0.1"
if [[ "$host" =~ ^[0-9.]+$ || "$host" == *:* ]]; then
  [ "$host" = 127.0.0.1 ] || sans="$sans,IP:$host"
else
  [ "$host" = localhost ] || sans="$sans,DNS:$host"
fi
issue=$rotate
[ -s "$gw/tls/fullchain.pem" ] || issue=1
[ "$(cat "$tls/server.sans" 2>/dev/null)" = "$sans" ] || issue=1
if [ -s "$gw/tls/fullchain.pem" ] && ! openssl x509 -checkend $((7 * 86400)) -noout -in "$gw/tls/fullchain.pem" >/dev/null; then
  issue=1
fi
if [ "$issue" = 1 ]; then
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj "/CN=$host" \
    -keyout "$tls/server.key.new" -out "$tls/server.csr" 2>/dev/null
  printf 'subjectAltName=%s\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n' \
    "$sans" > "$tls/server.ext"
  openssl x509 -req -in "$tls/server.csr" -CA "$tls/ca.pem" -CAkey "$tls/ca.key" -CAcreateserial -days 30 \
    -extfile "$tls/server.ext" -out "$tls/server.pem.new" 2>/dev/null
  # Readable by the container's root, which runs with every capability dropped and so reads by mode alone. Each file is
  # renamed into place; the gateway takes the pair once both are there (it reads a mismatched pair again before it
  # gives up on it).
  chmod 644 "$tls/server.key.new" "$tls/server.pem.new"
  mv -f "$tls/server.key.new" "$gw/tls/privkey.pem"
  mv -f "$tls/server.pem.new" "$gw/tls/fullchain.pem"
  printf '%s' "$sans" > "$tls/server.sans"
  log "link gateway certificate: serial $(openssl x509 -noout -serial -in "$gw/tls/fullchain.pem" | cut -d= -f2), $(openssl x509 -noout -enddate -in "$gw/tls/fullchain.pem")"
fi

pebble_image="ghcr.io/letsencrypt/pebble@sha256:ddf230642b1a584f519f32e347de1b05a6e4c1f6c35c1863b33effeab5f78199"
if [ "$tls_mode" = acme ]; then
  mkdir -p "$state/pebble"
  # Pebble as it ships, but validating TLS-ALPN-01 on the gateway's own port.
  cid="$(docker create "$pebble_image")"
  docker cp "$cid:/test/config/pebble-config.json" "$state/pebble/pebble-config.json.orig" >/dev/null
  docker cp "$cid:/test/certs/pebble.minica.pem" "$gw/pebble.minica.pem" >/dev/null
  docker rm "$cid" >/dev/null
  node -e '
    const fs = require("fs");
    const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    c.pebble.tlsPort = 8443;
    fs.writeFileSync(process.argv[2], JSON.stringify(c, null, 2));
  ' "$state/pebble/pebble-config.json.orig" "$state/pebble/pebble-config.json"
  link_url="wss://$acme_domain:8443"
  acme_domains="$acme_domain"
else
  link_url="wss://$host:$link_port"
  acme_domains=""
fi

# --- NATS's two nkey users (src/link-gateway/nats.conf): made once, by the gateway image, and kept. ------------------
nats_key() { [ -s "$secrets/nats_$1_seed" ] && [ -s "$secrets/nats_$1_key" ]; }
make_nats_keys() {
  local who pair
  for who in apiserver gateway; do
    nats_key "$who" && continue
    pair="$(docker run --rm "$project-link-gateway:local" nkey)" || die "the link gateway image made no nkey"
    (umask 077
      sed -n 's/^seed=//p' <<<"$pair" > "$secrets/nats_${who}_seed"
      sed -n 's/^public=//p' <<<"$pair" > "$secrets/nats_${who}_key")
    log "NATS user $who: a new nkey, public $(cat "$secrets/nats_${who}_key")"
  done
}
read_nats() { [ -s "$secrets/nats_$1_$2" ] && tr -d '\n' < "$secrets/nats_$1_$2"; }

# --- The env file Compose reads (and nothing else: see staging-lib.sh). -----------------------------------------------
write_env() {
(
  umask 077
  cat > "$env_file.new" <<EOF
STAGING_PROJECT=$project
STAGING_DIR=$state
STAGING_TLS=$tls_mode
STAGING_BIND=$bind
STAGING_HOST=$host
STAGING_HTTP_PORT=$http_port
STAGING_LINK_PORT=$link_port
STAGING_METRICS_PORT=$metrics_port
STAGING_NATS_PORT=$nats_port
STAGING_NATS_MONITOR_PORT=$nats_monitor_port
STAGING_PEBBLE_MGMT_PORT=$pebble_port
STAGING_ACME_DOMAIN=$acme_domain
JWT_SECRET=$(cat "$secrets/jwt_secret")
PROVIDER_SECRET_KEY=$(cat "$secrets/provider_secret_key")
PUBLIC_ORIGIN=http://$host:$http_port
ORBIT_SOURCE_SHA=$(git -C "$repo" rev-parse HEAD)
RUNNER_LINK_SIGNING_KEY=$signing_key
RUNNER_LINK_URL=$link_url
RUNNER_LINK_GATEWAY_TOKEN=$(cat "$secrets/gateway_token")
RUNNER_LINK_PUBLIC_KEY=$public_key
RUNNER_LINK_GATEWAY_DIR=$gw
RUNNER_LINK_ACME_DOMAINS=$acme_domains
STAGING_REPO=$repo
STAGING_MODE=$mode
STAGING_BACKENDS=$backends
STAGING_LINK_BACKENDS=$link_backends
STAGING_BACKEND_URLS=$backend_urls
STAGING_LOADGEN=$loadgen
STAGING_DB_CPUS=$db_cpus
STAGING_DB_MEM=$db_mem
STAGING_MERGE_WINDOW_SETTING=$merge_window
STAGING_MERGE_WINDOW=$gateway_merge_window
STAGING_GATEWAYS=$gateways
STAGING_METRICS_PORT_B=$metrics_port_b
STAGING_HANDSHAKE_RATE_B=$handshake_rate
STAGING_HANDSHAKE_BURST_B=$handshake_burst
STAGING_INGEST_RATE_SETTING=$ingest_rate
STAGING_INGEST_RATE=$gateway_ingest_rate
STAGING_MERGE_CALLS_SETTING=$merge_calls
STAGING_MERGE_CALLS=$gateway_merge_calls
RUNNER_LINK_NATS_APISERVER_SEED=$(read_nats apiserver seed || true)
RUNNER_LINK_NATS_APISERVER_KEY=$(read_nats apiserver key || true)
RUNNER_LINK_NATS_GATEWAY_SEED=$(read_nats gateway seed || true)
RUNNER_LINK_NATS_GATEWAY_KEY=$(read_nats gateway key || true)
EOF
  mv -f "$env_file.new" "$env_file"
)
}
write_env

# --- Build and start. The runner-link profile is named here explicitly: it is what starts the link gateway and NATS. --
profiles=(--profile runner-link)
services=(postgres apiserver web gateway link-gateway nats)
[ "$tls_mode" = acme ] && services+=(pebble)
if [ "$backends" -ge 2 ]; then
  profiles+=(--profile staging-backend-b)
  services+=("${extras[@]}")
fi
if [ "$gateways" = 2 ]; then
  services+=(link-gateway-b link-balancer)
else
  # Left from a run with two: the link port is the first node's again.
  docker rm -f "$project-link-gateway-b" "$project-link-balancer" >/dev/null 2>&1 || true
fi
if [ "$build" = 1 ]; then
  log "building the apiserver, web and link gateway images from $(git -C "$repo" rev-parse --short HEAD)"
  compose "${profiles[@]}" build apiserver web link-gateway
elif ! docker image inspect "$project-link-gateway:local" >/dev/null 2>&1; then
  compose "${profiles[@]}" build link-gateway
fi
if ! nats_key apiserver || ! nats_key gateway; then
  make_nats_keys
  write_env
fi
# Apiservers left from a run with more are stopped, while their definitions are still read: the gateway no longer names
# them. Then the third and later ones are written (compose_files reads the file).
stale=()
while read -r b; do
  [[ " ${extras[*]} " == *" $b "* ]] || stale+=("$b")
done < <(docker ps -a --format '{{.Names}}' | sed -n "s/^$project-\(apiserver-[b-p]\)$/\1/p")
if [ ${#stale[@]} -gt 0 ]; then
  compose --profile staging-backend-b rm -sf "${stale[@]}" >/dev/null 2>&1 || true
fi
generated="$state/backends.compose.yml"
if [ "$backends" -gt 2 ]; then
  {
    echo "# Written by staging-up.sh for ORBIT_LINK_STAGING_BACKENDS=$backends: the apiservers past apiserver-b, each defined as"
    echo "# apiserver-b is in staging.compose.yml."
    echo "services:"
    for b in "${extras[@]:1}"; do
      printf '  %s:\n    profiles: [staging-backend-b]\n    extends:\n      file: ${STAGING_REPO}/docker-compose.yml\n' "$b"
      printf '      service: apiserver\n    build: !reset null\n    image: ${STAGING_PROJECT}-apiserver:local\n'
      printf '    container_name: ${STAGING_PROJECT}-%s\n    depends_on:\n      postgres:\n        condition: service_healthy\n' "$b"
      printf '      apiserver:\n        condition: service_healthy\n'
      if [ "$loadgen" = 1 ]; then printf '    mem_limit: 3g\n'; fi
    done
  } > "$generated.new"
  mv -f "$generated.new" "$generated"
else
  rm -f "$generated"
fi
log "starting ${services[*]} as project $project, $gateways link gateway node(s) in MODE_${mode^^} over $backends backend(s), merge window $merge_window, merged calls an apiserver $merge_calls, ingest rate $ingest_rate$([ "$gateways" = 1 ] || echo ", the second node's handshakes $handshake_rate/s after a burst of $handshake_burst")"
compose "${profiles[@]}" up -d --wait --wait-timeout 1500 "${services[@]}"

# --- Seed and check. --------------------------------------------------------------------------------------------------
origin="http://$bind:$http_port"
metrics="http://127.0.0.1:$metrics_port/metrics"
for _ in $(seq 1 120); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$origin/api/auth/setup-status")" = 200 ] && break
  sleep 2
done
node "$here/staging-seed.mjs" "$origin" "$state" "$metrics" "$project" > "$state/staging.json.log"

curl -fsS "$metrics" > "$state/metrics.txt" || die "the link gateway's metrics do not answer at $metrics"
grep -q '^link_revocation_fetches_total{result="ok"} [1-9]' "$state/metrics.txt" ||
  die "the link gateway has not read the revocation list (see: $(basename "$0") logs, or docker logs $project-link-gateway)"
# Hints: the gateway and the apiserver are both connected to NATS.
for _ in $(seq 1 30); do
  grep -q '^link_nats_connected 1$' <(curl -fsS "$metrics") && break
  sleep 1
done
grep -q '^link_nats_connected 1$' <(curl -fsS "$metrics") || die "the link gateway is not connected to NATS (docker logs $project-link-gateway)"
# The apiserver dials again every 5 s when NATS came up after it.
for _ in $(seq 1 30); do
  grep -q 'connected to NATS at ' <(docker logs "$project-apiserver" 2>&1) && break
  sleep 1
done
grep -q 'connected to NATS at ' <(docker logs "$project-apiserver" 2>&1) ||
  die "the apiserver is not connected to NATS (docker logs $project-apiserver | grep RunnerHints)"
# The listener the gateway forwards runner calls to.
for name in "$project-apiserver" "${extras[@]/#/$project-}"; do
  for _ in $(seq 1 30); do
    grep -q 'runner link calls are served on 0.0.0.0:3001' <(docker logs "$name" 2>&1) && break
    sleep 1
  done
  grep -q 'runner link calls are served on 0.0.0.0:3001' <(docker logs "$name" 2>&1) ||
    die "$name does not serve runner link calls (docker logs $name | grep RunnerLink)"
done
if [ "$tls_mode" = files ]; then
  # The link answers TLS for the name clients use, with the staging CA, and refuses a plain request with 426.
  code="$(curl -s -o /dev/null -w '%{http_code}' --cacert "$tls/ca.pem" --resolve "$host:$link_port:$bind" "https://$host:$link_port/")"
  [ "$code" = 426 ] || die "https://$host:$link_port/ answered $code, not 426"
fi

log "staging stack $project is up"
cat <<EOF
  web and API      $origin            (owner: owner@orbit-staging.test, password in $secrets/owner_password)
  runner link      $link_url
  link metrics     $metrics
  NATS             nats://$bind:$nats_port, monitoring http://127.0.0.1:$nats_monitor_port (nkey users: $secrets/nats_*)
  link mode        MODE_${mode^^}, forwarding to $backend_urls
  state            $state             (staging.json describes all of it)
  test client      $here/staging-client.sh -duration 60s
  stop             $here/staging-down.sh
EOF
