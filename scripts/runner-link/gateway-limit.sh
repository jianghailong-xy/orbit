#!/usr/bin/env bash
# The link gateway alone, loaded level after level, to find what one gateway on one machine carries. One real link
# gateway built from this checkout (TLS on, MODE_LINK, a real NATS) and, in place of the apiservers and the database it
# forwards to, the stub backend (src/link-gateway/cmd/linkstub), loaded by loadgen shards (src/link-gateway/cmd/loadgen)
# from several source addresses. No apiserver, no Postgres, no web gateway. README.md, "The gateway alone", says what
# each level needs of the kernel.
#
#   scripts/runner-link/gateway-limit.sh --name hpc-3k --levels 3000 --ramp 60s --settle 60s --steady 5m \
#     --gateway-cpus 4 --gateway-memory 4G --shards 2 --sources 127.0.0.2,127.0.0.3 -- -volatile
#
# Arguments after -- go to every loadgen shard. Each level plays the fleet's first <level> runners at the cell's traffic
# per connection: a heartbeat every 30 s (the gateway's Welcome interval) and --events-per-connection durable events a
# second, as -ramp-rate <level>/<ramp>, -settle and -duration from the level's ramp, settle and steady times. The
# gateway runs on from level to level; each level's loadgen shards start, run and end on their own.
#
# Options:
#   --name <name>                the run's name, letters, digits, _ and -: results in <dir>/runs/<name> (the time, UTC)
#   --levels <n,n,...>           connections at each level, rising (required)
#   --ramp, --settle, --steady   each level's times: one for every level, or one per level (60s, 60s, 5m)
#   --gap <duration>             the pause before the first level, the idle gateway's figures, and between levels (20s)
#   --gateway-cpus <n>           the gateway's CPU allowance in cores (cpu.max, which GOMAXPROCS follows); 0 for none (4)
#   --gateway-memory <size>      the gateway's memory allowance (memory.max, no swap); 0 for none (8G)
#   --gateway-cpuset <cpus>      the CPUs the gateway runs on (AllowedCPUs), e.g. 0-7 (all)
#   --rig-cpuset <cpus>          the CPUs the stubs and the loadgen shards run on (all)
#   --gateway-env <KEY=VALUE>    one more setting for the gateway, e.g. LINK_HANDSHAKE_RATE=400; may repeat
#   --shards <n>                 loadgen processes playing the fleet between them (2)
#   --sources <a,b,...>          the local addresses every shard's connections leave from (127.0.0.2,127.0.0.3)
#   --stubs <n>                  stub processes, one per backend address the gateway forwards to: a cell's 4 apiservers (4)
#   --stub-delay <duration>      how long after a call arrives a stub answers it (5ms)
#   --events-per-connection <r>  durable events a second per connection: the cell's 2,000 over 15,000 (0.1333)
#   --loadgen-memory <size>      each shard's memory allowance (6G)
#   --no-probe                   build the gateway without the runtime probe (gateway-limit-probe.go): no goroutine count,
#                                and GC pauses from gctrace alone
#   --dir <dir>                  where runs are kept ($GATEWAY_LIMIT_DIR or /var/tmp/orbit-gateway-limit)
#
# Results in <dir>/runs/<name>/:
#   report.md, report.json  each level's figures (gateway-limit-report.mjs)
#   run.json                the configuration; the commit and the probe file's sha256, which with the product source make
#                           the binary under test; the host and its kernel settings
#   levels/<n>/             level.json (when it ran, how each shard exited) and shard-<i>/ (series.jsonl, summary.json,
#                           histograms.json, errors.log, stderr)
#   samples.jsonl           every 5 s: CPU, CPU pressure and memory of each part's cgroup (the gateway, each stub, each
#                           shard, NATS); the gateway's RSS and threads; the host's CPU, load, memory and swap; the
#                           kernel's TCP, socket, conntrack, softirq and softnet counters
#   metrics.prom            every 15 s: the gateway's /metrics, each scrape after a "# scrape <ms>" line
#   probe.jsonl             every 15 s: the runtime probe's goroutines, GC pauses and heap
#   stub.jsonl              every 15 s: each stub's GET /stub/stats
#   sockets.jsonl           every 15 s: the gateway's open file descriptors, and its established connections by the address
#                           they came from (ss)
#   logs/                   the gateway's log (with GODEBUG=gctrace=1's line for each GC), the stubs' and NATS's
#
# The run holds the host's load-test lock (/var/tmp/orbit-loadgen.lock) from start to end, one load-test stack at a time.
# It starts only with GATEWAY_LIMIT_MIN_AVAILABLE_MB (4096) of memory available, and stops when the host stays below it
# for 15 s. It tears everything down as soon as it ends, however it ends. Ports from GATEWAY_LIMIT_PORT_BASE (62400): the
# link +43, metrics +64, probe +65, NATS +22 and +23, stubs +80 on. NATS runs as docker-compose.yml runs it
# (GATEWAY_LIMIT_NATS_IMAGE, nats:2.15-alpine, with src/link-gateway/nats.conf), on the host's network.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
log() { printf '%s gateway-limit: %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; }
die() {
  log "$*"
  exit 1
}

name="$(date -u +%Y%m%dT%H%M%SZ)"
levels="" ramp="60s" settle="60s" steady="5m" gap="20s"
gateway_cpus=4 gateway_memory=8G gateway_cpuset="" rig_cpuset=""
gateway_env=()
shards=2 sources="127.0.0.2,127.0.0.3" stubs=4 stub_delay=5ms epc=0.1333 loadgen_memory=6G probe=1
base_dir="${GATEWAY_LIMIT_DIR:-/var/tmp/orbit-gateway-limit}"
loadgen_args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --name) name="$2"; shift 2 ;;
    --levels) levels="$2"; shift 2 ;;
    --ramp) ramp="$2"; shift 2 ;;
    --settle) settle="$2"; shift 2 ;;
    --steady) steady="$2"; shift 2 ;;
    --gap) gap="$2"; shift 2 ;;
    --gateway-cpus) gateway_cpus="$2"; shift 2 ;;
    --gateway-memory) gateway_memory="$2"; shift 2 ;;
    --gateway-cpuset) gateway_cpuset="$2"; shift 2 ;;
    --rig-cpuset) rig_cpuset="$2"; shift 2 ;;
    --gateway-env) gateway_env+=("$2"); shift 2 ;;
    --shards) shards="$2"; shift 2 ;;
    --sources) sources="$2"; shift 2 ;;
    --stubs) stubs="$2"; shift 2 ;;
    --stub-delay) stub_delay="$2"; shift 2 ;;
    --events-per-connection) epc="$2"; shift 2 ;;
    --loadgen-memory) loadgen_memory="$2"; shift 2 ;;
    --no-probe) probe=0; shift ;;
    --dir) base_dir="$2"; shift 2 ;;
    --) shift; loadgen_args=("$@"); break ;;
    -h | --help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done

# --- What was asked. --------------------------------------------------------------------------------------------------
# to_seconds reads a Go duration of whole hours, minutes and seconds (90s, 5m, 1h30m) into $secs.
to_seconds() {
  local v="$1"
  [[ -n "$v" && "$v" =~ ^([0-9]+h)?([0-9]+m)?([0-9]+s)?$ ]] || die "$v is not a duration such as 90s, 5m or 1h30m"
  secs=0
  [ -z "${BASH_REMATCH[1]}" ] || secs=$((secs + ${BASH_REMATCH[1]%h} * 3600))
  [ -z "${BASH_REMATCH[2]}" ] || secs=$((secs + ${BASH_REMATCH[2]%m} * 60))
  [ -z "${BASH_REMATCH[3]}" ] || secs=$((secs + ${BASH_REMATCH[3]%s}))
}
[[ "$name" =~ ^[A-Za-z0-9_-]+$ ]] || die "--name is letters, digits, underscores and hyphens"
[ -n "$levels" ] || die "--levels is required, e.g. --levels 1000,2000,3000"
IFS=, read -r -a level_list <<<"$levels"
prev=0
for l in "${level_list[@]}"; do
  [[ "$l" =~ ^[1-9][0-9]*$ ]] && [ "$l" -gt "$prev" ] || die "--levels is a rising list of connection counts, e.g. 1000,2000,3000"
  prev="$l"
done
max_level="$prev"
# per_level fills the array named $1 with the durations of list $2, given for option $3, one per level, in seconds.
per_level() {
  local -n into="$1"
  local -a items
  local i
  IFS=, read -r -a items <<<"$2"
  [ "${#items[@]}" -eq 1 ] || [ "${#items[@]}" -eq "${#level_list[@]}" ] || die "$3 takes one duration, or one per level"
  into=()
  for i in "${!level_list[@]}"; do
    to_seconds "${items[$((${#items[@]} == 1 ? 0 : i))]}"
    into+=("$secs")
  done
}
per_level ramp_list "$ramp" --ramp
per_level settle_list "$settle" --settle
per_level steady_list "$steady" --steady
to_seconds "$gap"
gap_s="$secs"
for v in "${ramp_list[@]}" "${steady_list[@]}"; do [ "$v" -gt 0 ] || die "--ramp and --steady must be longer than 0s"; done
[[ "$shards" =~ ^[1-9][0-9]*$ ]] || die "--shards is a number of processes"
[[ "$stubs" =~ ^[1-9][0-9]*$ ]] || die "--stubs is a number of processes"
[[ "$gateway_cpus" =~ ^[0-9]+(\.[0-9]+)?$ ]] || die "--gateway-cpus is a number of cores, 0 for no limit"
[[ "$epc" =~ ^[0-9]+(\.[0-9]+)?$ ]] || die "--events-per-connection is a number of events a second"
[[ "$stub_delay" =~ ^[0-9]+(ms|s)$ ]] || die "--stub-delay is a duration such as 5ms"
IFS=, read -r -a source_list <<<"$sources"
[ "${#source_list[@]}" -ge 1 ] || die "--sources names at least one address"
for kv in "${gateway_env[@]}"; do [[ "$kv" =~ ^[A-Z][A-Z0-9_]*=.*$ ]] || die "--gateway-env takes KEY=VALUE, not $kv"; done
for tool in go openssl docker jq curl node systemd-run systemctl ss flock awk sha256sum; do
  command -v "$tool" > /dev/null || die "$tool is required"
done

port_base="${GATEWAY_LIMIT_PORT_BASE:-62400}"
link_port=$((port_base + 43)) metrics_port=$((port_base + 64)) probe_port=$((port_base + 65))
nats_port=$((port_base + 22)) nats_monitor_port=$((port_base + 23)) stub_base=$((port_base + 80))
link_url="wss://localhost:$link_port"
min_available_kb=$((${GATEWAY_LIMIT_MIN_AVAILABLE_MB:-4096} * 1024))
nats_image="${GATEWAY_LIMIT_NATS_IMAGE:-nats:2.15-alpine}"
out="$base_dir/runs/$name"
[ -e "$out" ] && die "$out exists: choose another --name"

# --- What the host allows: refused before anything starts. ------------------------------------------------------------
read -r port_lo port_hi < /proc/sys/net/ipv4/ip_local_port_range
ports=$((port_hi - port_lo + 1))
per_source=$(((max_level + ${#source_list[@]} - 1) / ${#source_list[@]}))
# Each source address has one ephemeral port per connection to the gateway's one address; renewals and TIME_WAIT need room.
[ "$per_source" -le $((ports * 9 / 10)) ] ||
  die "$max_level connections from ${#source_list[@]} source address(es) is $per_source each, past 90% of the $ports ephemeral ports ($port_lo-$port_hi): add --sources, or widen net.ipv4.ip_local_port_range (README.md)"
nr_open="$(cat /proc/sys/fs/nr_open)"
fd_limit=$((nr_open < 1048576 ? nr_open : 1048576))
[ "$fd_limit" -ge $((max_level + 10000)) ] || die "fs.nr_open ($nr_open) leaves no room for $max_level connections' file descriptors"
warnings=()
ct_max="$(cat /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null || echo)"
ct_count="$(cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null || echo 0)"
if [ -n "$ct_max" ] && [ $((ct_count + max_level * 12 / 10)) -gt "$ct_max" ]; then
  warnings+=("nf_conntrack_max is $ct_max with $ct_count tracked already: $max_level more connections may fill it (README.md)")
fi
somaxconn="$(cat /proc/sys/net/core/somaxconn)"
[ "$somaxconn" -ge 1024 ] || warnings+=("net.core.somaxconn is $somaxconn: the gateway's listen backlog follows it")
for i in "${!level_list[@]}"; do
  rate=$(((level_list[i] + ramp_list[i] - 1) / ramp_list[i]))
  if [ "$rate" -gt 200 ] && [[ " ${gateway_env[*]} " != *" LINK_HANDSHAKE_RATE="* ]]; then
    warnings+=("level ${level_list[i]} ramps at $rate/s, past the gateway's 200 handshakes a second (LINK_HANDSHAKE_RATE): expect refusals, or set --gateway-env LINK_HANDSHAKE_RATE")
  fi
done
for w in "${warnings[@]}"; do log "warning: $w"; done
for p in "$link_port" "$metrics_port" "$probe_port" "$nats_port" "$nats_monitor_port" $(seq "$stub_base" $((stub_base + stubs - 1))); do
  [ -z "$(ss -Hltn "( sport = :$p )")" ] || die "port $p is in use: is another gateway-limit run up? (GATEWAY_LIMIT_PORT_BASE moves the ports)"
done

# --- One load test at a time, with memory to spare. --------------------------------------------------------------------
exec 9>> /var/tmp/orbit-loadgen.lock
if ! flock -n 9; then
  log "waiting for the host's load-test lock (/var/tmp/orbit-loadgen.lock)"
  flock 9
fi
avail_kb() { awk '/^MemAvailable/{print $2}' /proc/meminfo; }
[ "$(avail_kb)" -ge "$min_available_kb" ] ||
  die "the host has $(($(avail_kb) / 1024)) MiB available, under GATEWAY_LIMIT_MIN_AVAILABLE_MB (${GATEWAY_LIMIT_MIN_AVAILABLE_MB:-4096}): not starting"

mkdir -p "$out/logs" "$out/bin" "$out/levels"
(umask 077 && mkdir -p "$out/secrets")
unit="gl-$name"
nats_name="$unit-nats"
sampler_pids=()
teardown() {
  local rc=$? u pattern
  trap - EXIT INT TERM
  for p in "${sampler_pids[@]}"; do kill "$p" 2> /dev/null || true; done
  wait "${sampler_pids[@]}" 2> /dev/null || true
  # Shards first, so nothing is left dialing; then the gateway (SIGTERM: it drains whatever is left, then exits), the
  # stubs (SIGTERM: each writes its stats) and NATS.
  systemctl kill --signal=SIGINT "$unit-loadgen-*.scope" 2> /dev/null || true
  for pattern in "$unit-loadgen-*.scope" "$unit-gateway.scope" "$unit-stub-*.scope"; do
    for u in $(systemctl list-units --plain --no-legend "$pattern" 2> /dev/null | awk '{print $1}'); do
      timeout 30 systemctl stop "$u" 2> /dev/null || systemctl kill --signal=SIGKILL "$u" 2> /dev/null || true
    done
  done
  if docker inspect "$nats_name" > /dev/null 2>&1; then
    docker logs "$nats_name" > "$out/logs/nats.log" 2>&1 || true
    docker rm -f "$nats_name" > /dev/null 2>&1 || true
  fi
  log "torn down"
  if [ -s "$out/run.json" ] && [ -d "$out/levels" ]; then
    node "$here/gateway-limit-report.mjs" "$out" > "$out/report.md" 2> "$out/report.err" &&
      log "report: $out/report.md" || log "the report could not be written (see $out/report.err)"
  fi
  exit "$rc"
}
trap teardown EXIT
trap 'exit 130' INT TERM

# --- The binaries, from this checkout. ---------------------------------------------------------------------------------
sha="$(git -C "$repo" rev-parse HEAD)"
dirty=false
[ -z "$(git -C "$repo" status --porcelain -- src/link-gateway scripts/runner-link)" ] || dirty=true
probe_file="$here/gateway-limit-probe.go"
probe_sha="$(sha256sum "$probe_file" | cut -d' ' -f1)"
overlay=()
if [ "$probe" = 1 ]; then
  printf '{"Replace":{"%s":"%s"}}\n' "$repo/src/link-gateway/zz_gateway_limit_probe.go" "$probe_file" > "$out/probe-overlay.json"
  overlay=(-overlay "$out/probe-overlay.json")
fi
log "building the gateway$([ "$probe" = 1 ] && echo " with the runtime probe"), the stub and the loadgen from ${sha:0:12}$([ "$dirty" = true ] && echo ' (with uncommitted changes)')"
(cd "$repo/src/link-gateway" &&
  CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${sha:0:12}" "${overlay[@]}" -o "$out/bin/link-gateway" . &&
  go build -trimpath -o "$out/bin/linkstub" ./cmd/linkstub &&
  go build -trimpath -o "$out/bin/loadgen" ./cmd/loadgen)

# --- Keys, certificates and the fleet: made for this run alone. --------------------------------------------------------
sec="$out/secrets"
openssl genpkey -algorithm ed25519 -out "$sec/signing.pem" 2> /dev/null
public_keys="$(openssl pkey -in "$sec/signing.pem" -pubout | base64 -w0)"
openssl rand -hex 32 > "$sec/gateway-token"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 7 -subj "/CN=gateway-limit CA ($name)" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -keyout "$sec/ca.key" -out "$sec/ca.pem" 2> /dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj "/CN=localhost" \
  -keyout "$sec/server.key" -out "$sec/server.csr" 2> /dev/null
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n' > "$sec/server.ext"
openssl x509 -req -in "$sec/server.csr" -CA "$sec/ca.pem" -CAkey "$sec/ca.key" -CAcreateserial -days 7 \
  -extfile "$sec/server.ext" -out "$sec/server.pem" 2> /dev/null
for who in apiserver gateway; do
  pair="$("$out/bin/link-gateway" nkey)"
  sed -n 's/^seed=//p' <<<"$pair" > "$sec/nats_${who}_seed"
  sed -n 's/^public=//p' <<<"$pair" > "$sec/nats_${who}_key"
done
"$out/bin/linkstub" fleet -runners "$max_level" -out "$out/fleet.jsonl" 2> "$out/logs/fleet.log"

# --- run.json: everything a reader needs to repeat the run. ------------------------------------------------------------
backend_urls="$(for i in $(seq 0 $((stubs - 1))); do printf 'http://127.0.0.1:%d,' $((stub_base + i)); done)"
backend_urls="${backend_urls%,}"
kernel_settings() {
  local k
  printf '{'
  for k in net/ipv4/ip_local_port_range net/core/somaxconn net/ipv4/tcp_max_syn_backlog net/core/netdev_max_backlog \
    net/ipv4/tcp_mem net/ipv4/tcp_rmem net/ipv4/tcp_wmem net/core/rmem_max net/core/wmem_max net/netfilter/nf_conntrack_max \
    net/netfilter/nf_conntrack_buckets fs/file-max fs/nr_open net/ipv4/tcp_tw_reuse vm/swappiness; do
    printf '"%s":"%s",' "${k//\//.}" "$(tr -s '\t ' ' ' < "/proc/sys/$k" 2> /dev/null || echo absent)"
  done
  printf '"ulimitNofile":"%s"}' "$fd_limit"
}
jq -n --arg name "$name" --arg sha "$sha" --argjson dirty "$dirty" --arg go "$(go version)" \
  --argjson probe "$([ "$probe" = 1 ] && echo true || echo false)" --arg probeSha "$probe_sha" \
  --arg probeFile "scripts/runner-link/gateway-limit-probe.go" \
  --argjson levels "$(printf '%s\n' "${level_list[@]}" | jq -cs 'map(tonumber)')" \
  --argjson ramp "$(printf '%s\n' "${ramp_list[@]}" | jq -cs 'map(tonumber)')" \
  --argjson settle "$(printf '%s\n' "${settle_list[@]}" | jq -cs 'map(tonumber)')" \
  --argjson steady "$(printf '%s\n' "${steady_list[@]}" | jq -cs 'map(tonumber)')" \
  --argjson gap "$gap_s" --arg gatewayCpus "$gateway_cpus" --arg gatewayMemory "$gateway_memory" \
  --arg gatewayCpuset "$gateway_cpuset" --arg rigCpuset "$rig_cpuset" \
  --argjson gatewayEnv "$(printf '%s\n' "${gateway_env[@]}" | jq -R . | jq -cs 'map(select(. != ""))')" \
  --argjson shards "$shards" --argjson sources "$(printf '%s\n' "${source_list[@]}" | jq -R . | jq -cs .)" \
  --argjson stubs "$stubs" --arg stubDelay "$stub_delay" --argjson epc "$epc" --arg loadgenMemory "$loadgen_memory" \
  --argjson loadgenArgs "$(printf '%s\n' "${loadgen_args[@]}" | jq -R . | jq -cs 'map(select(. != ""))')" \
  --argjson warnings "$(printf '%s\n' "${warnings[@]}" | jq -R . | jq -cs 'map(select(. != ""))')" \
  --argjson hostCpus "$(nproc)" --arg cpuModel "$(awk -F': ' '/^model name/{print $2; exit}' /proc/cpuinfo)" \
  --argjson hostMemKb "$(awk '/^MemTotal/{print $2}' /proc/meminfo)" --arg kernel "$(uname -r)" \
  --argjson kernelSettings "$(kernel_settings)" --arg linkPort "$link_port" --arg backends "$backend_urls" \
  --arg natsImage "$nats_image" --argjson loadTestLock true \
  '{name: $name, sha: $sha, dirty: $dirty, go: $go,
    binaryUnderTest: {source: "src/link-gateway at the commit above", probe: $probe,
                      probeFile: (if $probe then $probeFile else null end), probeSha256: (if $probe then $probeSha else null end)},
    levels: $levels, rampSeconds: $ramp, settleSeconds: $settle, steadySeconds: $steady, gapSeconds: $gap,
    gateway: {cpus: $gatewayCpus, memory: $gatewayMemory, cpuset: $gatewayCpuset, env: $gatewayEnv, tls: "files, ECDSA P-256",
              mode: "link", gctrace: true, linkPort: ($linkPort | tonumber), backends: ($backends | split(","))},
    rig: {shards: $shards, sources: $sources, stubs: $stubs, stubDelay: $stubDelay, eventsPerConnection: $epc,
          loadgenMemory: $loadgenMemory, cpuset: $rigCpuset, loadgenArgs: $loadgenArgs, natsImage: $natsImage},
    host: {cpus: $hostCpus, cpuModel: $cpuModel, memKb: $hostMemKb, kernel: $kernel, settings: $kernelSettings},
    loadTestLock: $loadTestLock, warnings: $warnings}' > "$out/run.json"

# --- NATS, the stubs and the gateway. ---------------------------------------------------------------------------------
wait_for() { # <what> <seconds> <command...>
  local what="$1" limit="$2" i
  shift 2
  for ((i = 0; i < limit * 5; i++)); do
    "$@" > /dev/null 2>&1 && return 0
    sleep 0.2
  done
  die "$what did not come up within ${limit}s"
}
docker rm -f "$nats_name" > /dev/null 2>&1 || true
docker run -d --name "$nats_name" --network host --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  -v "$repo/src/link-gateway/nats.conf:/etc/orbit-nats/nats.conf:ro" \
  -e RUNNER_LINK_NATS_APISERVER_KEY="$(cat "$sec/nats_apiserver_key")" -e RUNNER_LINK_NATS_GATEWAY_KEY="$(cat "$sec/nats_gateway_key")" \
  "$nats_image" --config /etc/orbit-nats/nats.conf -a 127.0.0.1 -p "$nats_port" -m "$nats_monitor_port" > /dev/null 9>&-
wait_for NATS 30 curl -fsS "http://127.0.0.1:$nats_monitor_port/healthz"
nats_cgroup="/sys/fs/cgroup/system.slice/docker-$(docker inspect -f '{{.Id}}' "$nats_name").scope"

# start_scope <unit> <log> <systemd property...> -- <command...>: the command in a transient scope of its own, in the
# background, with an environment of its own and room for its connections' file descriptors.
start_scope() {
  local u="$1" logf="$2" props=()
  shift 2
  while [ "$1" != -- ]; do props+=("$1"); shift; done
  shift
  systemd-run --scope --quiet --unit "$u" "${props[@]}" \
    sh -c 'ulimit -n "$1" && shift && exec "$@"' sh "$fd_limit" "$@" > "$logf" 2>&1 9>&- &
}
rig_props=()
[ -z "$rig_cpuset" ] || rig_props+=(-p "AllowedCPUs=$rig_cpuset")
for i in $(seq 0 $((stubs - 1))); do
  start_scope "$unit-stub-$i" "$out/logs/stub-$i.log" "${rig_props[@]}" -- env -i PATH=/usr/bin:/bin \
    "$out/bin/linkstub" serve -listen "127.0.0.1:$((stub_base + i))" -key "$sec/signing.pem" \
    -gateway-token-file "$sec/gateway-token" -link-url "$link_url" -delay "$stub_delay" -stats-out "$out/stub-$i.json"
done
for i in $(seq 0 $((stubs - 1))); do wait_for "stub $i" 15 curl -fsS "http://127.0.0.1:$((stub_base + i))/stub/stats"; done

gateway_props=(-p MemorySwapMax=0)
[ "$gateway_cpus" = 0 ] || gateway_props+=(-p "CPUQuota=$(awk -v c="$gateway_cpus" 'BEGIN{printf "%d", c * 100}')%")
[ "$gateway_memory" = 0 ] || gateway_props+=(-p "MemoryMax=$gateway_memory")
[ -z "$gateway_cpuset" ] || gateway_props+=(-p "AllowedCPUs=$gateway_cpuset")
gateway_vars=(
  LINK_LISTEN_ADDR="127.0.0.1:$link_port" LINK_METRICS_ADDR="127.0.0.1:$metrics_port"
  LINK_TLS_MODE=files LINK_TLS_CERT_FILE="$sec/server.pem" LINK_TLS_KEY_FILE="$sec/server.key"
  LINK_PUBLIC_KEYS="$public_keys" LINK_API_URL="http://127.0.0.1:$stub_base" LINK_GATEWAY_TOKEN="$(cat "$sec/gateway-token")"
  LINK_MODE=link LINK_INTERNAL_API_URLS="$backend_urls"
  LINK_NATS_URL="nats://127.0.0.1:$nats_port" LINK_NATS_SEED="$(cat "$sec/nats_gateway_seed")"
  # As staging's load test sets them (staging.loadgen.compose.yml): Hello, Welcome, Drain and Close logged, not every
  # frame; and every runner admitted from the few addresses the shards dial from, the limit across all clients kept.
  LINK_FRAME_LOG=lifecycle LINK_IP_RATE=100000 LINK_IP_BURST=100000
  GODEBUG=gctrace=1
)
[ "$probe" = 0 ] || gateway_vars+=(ORBIT_GATEWAY_LIMIT_PROBE_ADDR="127.0.0.1:$probe_port")
gateway_vars+=("${gateway_env[@]}")
start_scope "$unit-gateway" "$out/logs/gateway.log" "${gateway_props[@]}" -- \
  env -i PATH=/usr/bin:/bin "${gateway_vars[@]}" "$out/bin/link-gateway" serve
wait_for "the gateway" 30 curl -fsS "http://127.0.0.1:$metrics_port/healthz"
wait_for "the gateway's NATS connection" 30 sh -c "curl -fsS http://127.0.0.1:$metrics_port/metrics | grep -qx 'link_nats_connected 1'"
[ "$probe" = 0 ] || wait_for "the runtime probe" 10 curl -fsS "http://127.0.0.1:$probe_port/"
gateway_cgroup="/sys/fs/cgroup$(systemctl show -p ControlGroup --value "$unit-gateway.scope")"
gateway_pid="$(head -1 "$gateway_cgroup/cgroup.procs")"
# The gateway's start to the millisecond (/proc/<pid>/stat), which gctrace's times count from.
start_ms="$(awk -v btime="$(awk '/^btime/{print $2}' /proc/stat)" -v tck="$(getconf CLK_TCK)" \
  '{ sub(/^.*\) /, ""); printf "%.0f", (btime + $20 / tck) * 1000 }' "/proc/$gateway_pid/stat")"
jq --argjson pid "$gateway_pid" --argjson startMs "$start_ms" --arg cgroup "$gateway_cgroup" \
  '. + {gatewayPid: $pid, gatewayStartMs: $startMs, gatewayCgroup: $cgroup}' "$out/run.json" > "$out/run.json.new" &&
  mv "$out/run.json.new" "$out/run.json"
log "gateway pid $gateway_pid up (cpu.max $(cat "$gateway_cgroup/cpu.max"), memory.max $(cat "$gateway_cgroup/memory.max")), $stubs stub(s), NATS"

# --- Samplers. --------------------------------------------------------------------------------------------------------
# cg_json <cgroup dir>: its CPU time, throttling, memory and CPU pressure, as one JSON object.
cg_json() {
  awk 'FILENAME ~ /cpu\.stat$/ { if ($1 == "usage_usec") u = $2; if ($1 == "throttled_usec") t = $2; if ($1 == "nr_throttled") n = $2 }
    FILENAME ~ /memory\.current$/ { m = $1 }
    FILENAME ~ /memory\.peak$/ { pk = $1 }
    FILENAME ~ /memory\.stat$/ { if ($1 == "anon") a = $2; if ($1 == "sock") s = $2 }
    FILENAME ~ /memory\.events$/ { if ($1 == "oom_kill") o = $2 }
    FILENAME ~ /cpu\.pressure$/ { split($0, f, "total="); if ($1 == "some") ps = f[2]; if ($1 == "full") pf = f[2] }
    END { printf "{\"cpuUsec\":%.0f,\"throttledUsec\":%.0f,\"nrThrottled\":%.0f,\"memBytes\":%.0f,\"memPeakBytes\":%.0f,\"anonBytes\":%.0f,\"sockBytes\":%.0f,\"oomKills\":%.0f,\"psiSomeUsec\":%.0f,\"psiFullUsec\":%.0f}",
      u, t, n, m, pk, a, s, o, ps, pf }' \
    "$1/cpu.stat" "$1/memory.current" "$1/memory.peak" "$1/memory.stat" "$1/memory.events" "$1/cpu.pressure" 2> /dev/null
}
# hex_sums <file> <columns...>: each named column of a per-CPU table of hex counters (its first line names them), summed.
hex_sums() {
  local f="$1" i c
  shift
  local -a header row
  local -A sum=()
  {
    read -r -a header
    while read -r -a row; do
      for i in "${!header[@]}"; do sum[${header[$i]}]=$((${sum[${header[$i]}]:-0} + 16#${row[$i]:-0})); done
    done
  } < "$f"
  for c in "$@"; do printf ',"%s":%d' "$c" "${sum[$c]:-0}"; done
}
kernel_json() {
  printf '{'
  awk '$1 == "TcpExt:" { if (!h) { for (i = 2; i <= NF; i++) n[i] = $i; h = 1 } else { for (i = 2; i <= NF; i++) v[n[i]] = $i } }
    END { printf "\"listenOverflows\":%.0f,\"listenDrops\":%.0f,\"tcpBacklogDrop\":%.0f,\"tcpMemoryPressures\":%.0f,\"tcpAbortOnMemory\":%.0f,\"tcpReqQFullDrop\":%.0f,\"tcpTimeouts\":%.0f,\"pruneCalled\":%.0f",
      v["ListenOverflows"], v["ListenDrops"], v["TCPBacklogDrop"], v["TCPMemoryPressures"], v["TCPAbortOnMemory"], v["TCPReqQFullDrop"], v["TCPTimeouts"], v["PruneCalled"] }' /proc/net/netstat
  awk '$1 == "Tcp:" { if (!h) { for (i = 2; i <= NF; i++) n[i] = $i; h = 1 } else { for (i = 2; i <= NF; i++) v[n[i]] = $i } }
    END { printf ",\"tcpActiveOpens\":%.0f,\"tcpPassiveOpens\":%.0f,\"tcpAttemptFails\":%.0f,\"tcpEstabResets\":%.0f,\"tcpCurrEstab\":%.0f,\"tcpRetransSegs\":%.0f,\"tcpInErrs\":%.0f,\"tcpOutRsts\":%.0f",
      v["ActiveOpens"], v["PassiveOpens"], v["AttemptFails"], v["EstabResets"], v["CurrEstab"], v["RetransSegs"], v["InErrs"], v["OutRsts"] }' /proc/net/snmp
  awk '$1 == "sockets:" { u = $3 } $1 == "TCP:" { for (i = 2; i < NF; i += 2) t[$i] = $(i + 1) }
    END { printf ",\"socketsUsed\":%.0f,\"tcpInuse\":%.0f,\"tcpOrphan\":%.0f,\"tcpTw\":%.0f,\"tcpAlloc\":%.0f,\"tcpMemPages\":%.0f", u, t["inuse"], t["orphan"], t["tw"], t["alloc"], t["mem"] }' /proc/net/sockstat
  awk '$1 == "NET_RX:" { for (i = 2; i <= NF; i++) rx += $i } $1 == "NET_TX:" { for (i = 2; i <= NF; i++) tx += $i }
    END { printf ",\"netRxSoftirqs\":%.0f,\"netTxSoftirqs\":%.0f", rx, tx }' /proc/softirqs
  if [ -r /proc/sys/net/netfilter/nf_conntrack_count ]; then
    printf ',"conntrackCount":%s,"conntrackMax":%s' "$(cat /proc/sys/net/netfilter/nf_conntrack_count)" "$(cat /proc/sys/net/netfilter/nf_conntrack_max)"
    hex_sums /proc/net/stat/nf_conntrack drop early_drop insert_failed invalid clashres
  fi
  # softnet_stat has no header: its first columns are processed, dropped and time_squeeze.
  printf '%s' "$( (echo "processed dropped time_squeeze" && cut -d' ' -f1-3 /proc/net/softnet_stat) > "$out/.softnet" && hex_sums "$out/.softnet" dropped time_squeeze)"
  printf '}'
}
sample_fast() {
  local low=0 t line d u p pid cpu gw_ok=1
  while :; do
    t="$(date +%s%3N)"
    line="{\"t\":$t,\"cgroups\":{"
    p=""
    for d in /sys/fs/cgroup/system.slice/"$unit"-*.scope "$nats_cgroup"; do
      [ -f "$d/cpu.stat" ] || continue
      u="$(basename "$d" .scope)"
      [ "$d" = "$nats_cgroup" ] && u=nats
      line+="$p\"${u#"$unit"-}\":$(cg_json "$d")"
      p=","
    done
    line+="}"
    pid="$(head -1 "$gateway_cgroup/cgroup.procs" 2> /dev/null || true)"
    if [ -n "$pid" ] && [ -r "/proc/$pid/status" ]; then
      line+=",\"gateway\":$(awk '/^VmRSS/{r = $2} /^VmHWM/{h = $2} /^Threads/{n = $2} END{printf "{\"rssKb\":%.0f,\"hwmKb\":%.0f,\"threads\":%.0f}", r, h, n}' "/proc/$pid/status")"
    elif [ "$gw_ok" = 1 ]; then
      gw_ok=0
      # The gateway ended under load (an OOM kill at its allowance, a crash): the limit, when it is the gateway's. The
      # shards are stopped, as they would only redial a gateway that is gone.
      printf '{"t":%s,"oomKills":%s}\n' "$t" "$(awk '$1 == "oom_kill" {print $2}' "$gateway_cgroup/memory.events" 2> /dev/null || echo null)" > "$out/gateway-ended.json"
      systemctl kill --signal=SIGINT "$unit-loadgen-*.scope" 2> /dev/null || true
    fi
    cpu="$(awk '/^cpu /{print $2","$3","$4","$5","$6","$7","$8","$9; exit}' /proc/stat)"
    line+=",\"host\":{\"cpu\":[$cpu],\"load\":[$(cut -d' ' -f1-3 /proc/loadavg | tr ' ' ',')]"
    line+=",\"memAvailKb\":$(avail_kb),\"swapFreeKb\":$(awk '/^SwapFree/{print $2}' /proc/meminfo)"
    line+=",\"pswpin\":$(awk '/^pswpin/{print $2}' /proc/vmstat),\"pswpout\":$(awk '/^pswpout/{print $2}' /proc/vmstat)"
    line+=",\"psiSomeUsec\":$(awk -F'total=' '/^some/{print $2 + 0}' /proc/pressure/cpu)}"
    line+=",\"kernel\":$(kernel_json)}"
    printf '%s\n' "$line" >> "$out/samples.jsonl"
    if [ "$(avail_kb)" -lt "$min_available_kb" ]; then low=$((low + 1)); else low=0; fi
    if [ "$low" -ge 3 ] && [ ! -e "$out/stopped-for-memory" ]; then
      date -u +%Y-%m-%dT%H:%M:%SZ > "$out/stopped-for-memory"
      systemctl kill --signal=SIGINT "$unit-loadgen-*.scope" 2> /dev/null || true
    fi
    sleep 5
  done
}
sample_slow() {
  local t body pid i ss_out
  while :; do
    t="$(date +%s%3N)"
    if body="$(curl -fsS --max-time 10 "http://127.0.0.1:$metrics_port/metrics")"; then
      printf '# scrape %s\n%s\n' "$t" "$body" >> "$out/metrics.prom"
    fi
    if [ "$probe" = 1 ] && body="$(curl -fsS --max-time 5 "http://127.0.0.1:$probe_port/")"; then
      printf '%s\n' "$body" >> "$out/probe.jsonl"
    fi
    for i in $(seq 0 $((stubs - 1))); do
      if body="$(curl -fsS --max-time 5 "http://127.0.0.1:$((stub_base + i))/stub/stats")"; then
        jq -c --argjson stub "$i" '. + {stub: $stub}' <<<"$body" >> "$out/stub.jsonl" 2> /dev/null || true
      fi
    done
    pid="$(head -1 "$gateway_cgroup/cgroup.procs" 2> /dev/null || true)"
    if [ -n "$pid" ]; then
      ss_out="$(ss -Htn state established "( sport = :$link_port )" | awk '{ n = split($4, a, ":"); ip = a[1]; for (i = 2; i < n; i++) ip = ip ":" a[i]; c[ip]++ }
        END { s = ""; for (ip in c) { printf "%s\"%s\":%d", s, ip, c[ip]; s = "," } }')"
      printf '{"t":%s,"fds":%s,"bySource":{%s}}\n' "$t" "$(find "/proc/$pid/fd" -mindepth 1 -maxdepth 1 2> /dev/null | wc -l)" "$ss_out" >> "$out/sockets.jsonl"
    fi
    sleep 15
  done
}
sample_fast & sampler_pids+=($!)
sample_slow & sampler_pids+=($!)
# The gateway idle, with NATS and the stubs up and no runner: what each level's figures are taken above.
idle_from="$(date +%s%3N)"
log "the gateway idles for ${gap_s}s first: the figures each level's are taken above"
sleep "$gap_s"
jq --argjson from "$idle_from" --argjson to "$(date +%s%3N)" '. + {idleFromMs: $from, idleToMs: $to}' "$out/run.json" > "$out/run.json.new" &&
  mv "$out/run.json.new" "$out/run.json"

# --- The levels. ------------------------------------------------------------------------------------------------------
for i in "${!level_list[@]}"; do
  level="${level_list[$i]}"
  if [ -e "$out/gateway-ended.json" ] || [ -e "$out/stopped-for-memory" ]; then break; fi
  if [ "$(avail_kb)" -lt "$min_available_kb" ]; then
    log "the host has $(($(avail_kb) / 1024)) MiB available, under the floor: stopping before level $level"
    date -u +%Y-%m-%dT%H:%M:%SZ > "$out/stopped-for-memory"
    break
  fi
  rate="$(awk -v l="$level" -v r="${ramp_list[$i]}" 'BEGIN{printf "%.3f", l / r}')"
  events="$(awk -v l="$level" -v e="$epc" 'BEGIN{printf "%.3f", l * e}')"
  dir="$out/levels/$level"
  mkdir -p "$dir"
  log "level $level: ramp ${ramp_list[$i]}s ($rate/s), settle ${settle_list[$i]}s, steady ${steady_list[$i]}s, $events events/s, $shards shard(s) from ${#source_list[@]} address(es)"
  started="$(date +%s%3N)"
  pids=()
  for s in $(seq 0 $((shards - 1))); do
    mkdir -p "$dir/shard-$s"
    start_scope "$unit-loadgen-$level-$s" "$dir/shard-$s/stderr" -p "MemoryMax=$loadgen_memory" -p MemorySwapMax=0 "${rig_props[@]}" -- \
      env -i PATH=/usr/bin:/bin sh -c 'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh \
      "$out/bin/loadgen" -fleet "$out/fleet.jsonl" -api "http://127.0.0.1:$((stub_base + s % stubs))" \
      -link-url "$link_url" -connect "127.0.0.1:$link_port" -ca "$sec/ca.pem" -out "$dir/shard-$s" -runners "$level" \
      -shard "$s/$shards" -source "$sources" -histograms -ramp-rate "$rate" -settle "${settle_list[$i]}s" \
      -duration "${steady_list[$i]}s" -event-rate "$events" "${loadgen_args[@]}"
    pids+=($!)
  done
  codes=()
  for p in "${pids[@]}"; do
    c=0
    wait "$p" || c=$?
    codes+=("$c")
  done
  ended="$(date +%s%3N)"
  jq -n --argjson level "$level" --argjson startedMs "$started" --argjson endedMs "$ended" --argjson rampRate "$rate" \
    --argjson eventRate "$events" --argjson ramp "${ramp_list[$i]}" --argjson settle "${settle_list[$i]}" \
    --argjson steady "${steady_list[$i]}" --argjson exits "$(printf '%s\n' "${codes[@]}" | jq -cs 'map(tonumber)')" \
    '{level: $level, startedMs: $startedMs, endedMs: $endedMs, rampRate: $rampRate, eventRate: $eventRate,
      rampSeconds: $ramp, settleSeconds: $settle, steadySeconds: $steady, shardExits: $exits}' > "$dir/level.json"
  log "level $level done: shards exited ${codes[*]}"
  if [ "$i" -lt $((${#level_list[@]} - 1)) ]; then sleep "$gap_s"; fi
done
# One more of each scrape after the last level's drain.
sleep 16
[ ! -e "$out/stopped-for-memory" ] || log "stopped at $(cat "$out/stopped-for-memory"): the host's available memory stayed under the floor"
[ ! -e "$out/gateway-ended.json" ] || log "the gateway ended under load: $(cat "$out/gateway-ended.json")"
