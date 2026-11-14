#!/usr/bin/env bash
# A gateway restart under load (series E of task 34paLvEDFObkoBxYLAJSN). One link gateway started exactly as
# gateway-limit.sh starts it (same binaries, keys, fleet, env and cgroup: taken from a finished gateway-limit run, whose
# bin/, secrets/ and fleet.jsonl it reuses), the stubs and NATS likewise, loaded by loadgen shards to --level
# connections at cell traffic. Once every runner is connected and --before seconds have passed, the gateway gets
# SIGTERM; when its process has exited a new one starts in its place with LINK_HANDSHAKE_RATE from --rates ("default"
# sets none: the product's default, 100 a second per CPU).
# That repeats once per rate. It times each drain (SIGTERM to exit) and each return (until link_connections is back
# at the level), and samples the gateway every second.
#
#   restart-drill.sh --name E-400k --from /var/tmp/orbit-gateway-limit/runs/A-cell --level 400000 \
#     --rates default,28000 [--first-rate 10000] [--ramp-rate 2000] [--before 120] [--hold 60] [--max-back 2700] \
#     [--shards 20] [--sources a,b,...] [--stubs 4] [--gateway-cpus 28] [--gateway-memory 110G] \
#     [--gateway-cpuset 0-13,28-41] [--rig-cpuset 14-27,42-55]
#
# Results in $GATEWAY_LIMIT_DIR/runs/<name>/ (/var/tmp/orbit-gateway-limit): events.jsonl (milestones), gw.jsonl (every
# second: the gateway's connections, handshake counters, CPU and memory; the rig's CPU), logs/gateway-<k>.log, loadgen
# shard dirs, stub logs. restart-drill-report.py reads them:  python3 -I restart-drill-report.py <run dir>
#
# The host needs what gateway-limit.sh needs at the level (README.md, "What each level needs of the kernel"), and this
# shell a hard nofile limit of min(fs.nr_open, 1048576). It holds the host's load-test lock like gateway-limit.sh.
set -euo pipefail
log() { printf '%s restart-drill: %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; }
die() { log "$*"; exit 1; }

name="" from="" level="" rates="" first_rate=10000 ramp_rate=2000 settle=60 before=120 hold=60 max_back=2700
shards=20 stubs=4 stub_delay=5ms epc=0.1333 gw_cpus=28 gw_mem=110G gw_cpuset="0-13,28-41" rig_cpuset="14-27,42-55"
sources="$(seq -s, -f '127.0.0.%g' 2 25)" interval=5s
while [ $# -gt 0 ]; do
  case "$1" in
    --name) name="$2"; shift 2 ;;
    --from) from="$2"; shift 2 ;;
    --level) level="$2"; shift 2 ;;
    --rates) rates="$2"; shift 2 ;;
    --first-rate) first_rate="$2"; shift 2 ;;
    --ramp-rate) ramp_rate="$2"; shift 2 ;;
    --settle) settle="$2"; shift 2 ;;
    --before) before="$2"; shift 2 ;;
    --hold) hold="$2"; shift 2 ;;
    --max-back) max_back="$2"; shift 2 ;;
    --shards) shards="$2"; shift 2 ;;
    --sources) sources="$2"; shift 2 ;;
    --stubs) stubs="$2"; shift 2 ;;
    --gateway-cpus) gw_cpus="$2"; shift 2 ;;
    --gateway-memory) gw_mem="$2"; shift 2 ;;
    --gateway-cpuset) gw_cpuset="$2"; shift 2 ;;
    --rig-cpuset) rig_cpuset="$2"; shift 2 ;;
    *) die "unknown option $1" ;;
  esac
done
[ -n "$name" ] && [ -d "$from/bin" ] && [ -n "$level" ] && [ -n "$rates" ] || die "need --name, --from <run dir>, --level, --rates"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
out="${GATEWAY_LIMIT_DIR:-/var/tmp/orbit-gateway-limit}/runs/$name"
[ -e "$out" ] && die "$out exists"
port_base=62400
link_port=$((port_base + 43)) metrics_port=$((port_base + 64)) probe_port=$((port_base + 65))
nats_port=$((port_base + 22)) nats_monitor_port=$((port_base + 23)) stub_base=$((port_base + 80))
link_url="wss://localhost:$link_port"
nr_open="$(cat /proc/sys/fs/nr_open)"
fd_limit=$((nr_open < 1048576 ? nr_open : 1048576))
[ "$(ulimit -Hn)" -ge "$fd_limit" ] || die "raise this shell's hard nofile limit to $fd_limit first (prlimit)"
exec 9>> /var/tmp/orbit-loadgen.lock
if ! flock -n 9; then log "waiting for the load-test lock"; flock 9; fi
for p in "$link_port" "$metrics_port" "$probe_port" "$nats_port" "$nats_monitor_port" $(seq "$stub_base" $((stub_base + stubs - 1))); do
  [ -z "$(ss -Hltn "( sport = :$p )")" ] || die "port $p is in use"
done

mkdir -p "$out/logs" "$out/levels/$level"
bin="$from/bin" sec="$from/secrets" fleet="$from/fleet.jsonl"
unit="gl-$name"
nats_name="$unit-nats"
events="$out/events.jsonl"
ev() { printf '{"t":%s,"event":"%s"%s}\n' "$(date +%s%3N)" "$1" "${2:+,$2}" >> "$events"; log "$1 ${2:-}"; }
sampler_pid=""
teardown() {
  local rc=$? u
  trap - EXIT INT TERM
  [ -z "$sampler_pid" ] || kill "$sampler_pid" 2> /dev/null || true
  systemctl kill --signal=SIGINT "$unit-loadgen-*.scope" 2> /dev/null || true
  for u in $(systemctl list-units --plain --no-legend "$unit-loadgen-*.scope" 2> /dev/null | awk '{print $1}'); do
    timeout 60 systemctl stop "$u" 2> /dev/null || systemctl kill --signal=SIGKILL "$u" 2> /dev/null || true
  done
  for u in $(systemctl list-units --plain --no-legend "$unit-gw-*.scope" "$unit-stub-*.scope" 2> /dev/null | awk '{print $1}'); do
    timeout 100 systemctl stop "$u" 2> /dev/null || systemctl kill --signal=SIGKILL "$u" 2> /dev/null || true
  done
  if docker inspect "$nats_name" > /dev/null 2>&1; then
    docker logs "$nats_name" > "$out/logs/nats.log" 2>&1 || true
    docker rm -f "$nats_name" > /dev/null 2>&1 || true
  fi
  ev torn_down
  exit "$rc"
}
trap teardown EXIT
trap 'exit 130' INT TERM

start_scope() {
  local u="$1" logf="$2" props=()
  shift 2
  while [ "$1" != -- ]; do props+=("$1"); shift; done
  shift
  systemd-run --scope --quiet --unit "$u" "${props[@]}" \
    sh -c 'ulimit -n "$1" && shift && exec "$@"' sh "$fd_limit" "$@" > "$logf" 2>&1 9>&- &
}
wait_for() {
  local what="$1" limit="$2" i
  shift 2
  for ((i = 0; i < limit * 5; i++)); do
    "$@" > /dev/null 2>&1 && return 0
    sleep 0.2
  done
  die "$what did not come up within ${limit}s"
}

# NATS and the stubs, as gateway-limit.sh runs them.
docker rm -f "$nats_name" > /dev/null 2>&1 || true
docker run -d --name "$nats_name" --network host --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  -v "$repo/src/link-gateway/nats.conf:/etc/orbit-nats/nats.conf:ro" \
  -e RUNNER_LINK_NATS_APISERVER_KEY="$(cat "$sec/nats_apiserver_key")" -e RUNNER_LINK_NATS_GATEWAY_KEY="$(cat "$sec/nats_gateway_key")" \
  nats:2.15-alpine --config /etc/orbit-nats/nats.conf -a 127.0.0.1 -p "$nats_port" -m "$nats_monitor_port" > /dev/null 9>&-
wait_for NATS 30 curl -fsS "http://127.0.0.1:$nats_monitor_port/healthz"
for i in $(seq 0 $((stubs - 1))); do
  start_scope "$unit-stub-$i" "$out/logs/stub-$i.log" -p "AllowedCPUs=$rig_cpuset" -- env -i PATH=/usr/bin:/bin \
    "$bin/linkstub" serve -listen "127.0.0.1:$((stub_base + i))" -key "$sec/signing.pem" \
    -gateway-token-file "$sec/gateway-token" -link-url "$link_url" -delay "$stub_delay" -stats-out "$out/stub-$i.json"
done
for i in $(seq 0 $((stubs - 1))); do wait_for "stub $i" 15 curl -fsS "http://127.0.0.1:$((stub_base + i))/stub/stats"; done

# The gateway, as gateway-limit.sh starts it; k numbers the processes, rate is LINK_HANDSHAKE_RATE or "default".
backend_urls="$(for i in $(seq 0 $((stubs - 1))); do printf 'http://127.0.0.1:%d,' $((stub_base + i)); done)"
backend_urls="${backend_urls%,}"
public_keys="$(openssl pkey -in "$sec/signing.pem" -pubout | base64 -w0)"
gw_unit=""
start_gateway() {
  local k="$1" rate="$2" vars
  vars=(
    LINK_LISTEN_ADDR="127.0.0.1:$link_port" LINK_METRICS_ADDR="127.0.0.1:$metrics_port"
    LINK_TLS_MODE=files LINK_TLS_CERT_FILE="$sec/server.pem" LINK_TLS_KEY_FILE="$sec/server.key"
    LINK_PUBLIC_KEYS="$public_keys" LINK_API_URL="http://127.0.0.1:$stub_base" LINK_GATEWAY_TOKEN="$(cat "$sec/gateway-token")"
    LINK_INTERNAL_API_URLS="$backend_urls"
    LINK_NATS_URL="nats://127.0.0.1:$nats_port" LINK_NATS_SEED="$(cat "$sec/nats_gateway_seed")"
    LINK_FRAME_LOG=lifecycle LINK_IP_RATE=100000 LINK_IP_BURST=100000
    GODEBUG=gctrace=1 ORBIT_GATEWAY_LIMIT_PROBE_ADDR="127.0.0.1:$probe_port"
  )
  [ "$rate" = default ] || vars+=(LINK_HANDSHAKE_RATE="$rate")
  gw_unit="$unit-gw-$k"
  start_scope "$gw_unit" "$out/logs/gateway-$k.log" -p MemorySwapMax=0 \
    -p "CPUQuota=$(awk -v c="$gw_cpus" 'BEGIN{printf "%d", c * 100}')%" -p "MemoryMax=$gw_mem" -p "AllowedCPUs=$gw_cpuset" -- \
    env -i PATH=/usr/bin:/bin "${vars[@]}" "$bin/link-gateway" serve
  echo "$gw_unit" > "$out/.gw_unit"
}
gw_pid() { head -1 "/sys/fs/cgroup/system.slice/$gw_unit.scope/cgroup.procs" 2> /dev/null || true; }
conns() { curl -fsS --max-time 2 "http://127.0.0.1:$metrics_port/metrics" 2> /dev/null | awk '$1 == "link_connections" {print $2}'; }
await_gateway() {
  wait_for "the gateway" 30 curl -fsS "http://127.0.0.1:$metrics_port/healthz"
  wait_for "the gateway's NATS connection" 30 sh -c "curl -fsS http://127.0.0.1:$metrics_port/metrics | grep -qx 'link_nats_connected 1'"
}

# Every second: the gateway's connections and handshake counters, its cgroup's CPU and memory; the rig's CPU.
sample() {
  local t u m cg pid rig
  set +e +o pipefail  # a failed scrape (the old process gone, the new one not up) must not end the sampler
  while :; do
    t="$(date +%s%3N)"
    u="$(cat "$out/.gw_unit" 2> /dev/null || true)"
    cg="/sys/fs/cgroup/system.slice/$u.scope"
    pid="$(head -1 "$cg/cgroup.procs" 2> /dev/null || true)"
    m="$(curl -fsS --max-time 1 "http://127.0.0.1:$metrics_port/metrics" 2> /dev/null | awk '
      $1 == "link_connections" { c = $2 } $1 == "link_draining" { d = $2 }
      /^link_handshakes_total\{result="ok"\}/ { ok = $2 } /^link_handshakes_total\{result="rate_limited"\}/ { rl = $2 }
      /^link_handshakes_total\{result="draining"\}/ { dr = $2 } /^link_tls_handshake_errors_total/ { te = $2 }
      END { printf "\"conns\":%s,\"draining\":%s,\"hsOk\":%s,\"hsRateLimited\":%s,\"hsDraining\":%s,\"tlsErrors\":%s",
        c == "" ? "null" : c, d == "" ? "null" : d, ok == "" ? "null" : ok, rl == "" ? "null" : rl, dr == "" ? "null" : dr, te == "" ? "null" : te }')"
    rig="$(cat /sys/fs/cgroup/system.slice/"$unit"-loadgen-*.scope/cpu.stat 2> /dev/null | awk '$1 == "usage_usec" {s += $2} END {printf "%.0f", s}')"
    printf '{"t":%s,"unit":"%s","pid":%s,%s,"gwCpuUsec":%s,"gwMemBytes":%s,"rigCpuUsec":%s,"stubCpuUsec":%s}\n' "$t" "$u" "${pid:-null}" \
      "${m:-\"conns\":null}" "$(awk '$1 == "usage_usec" {print $2}' "$cg/cpu.stat" 2> /dev/null || echo null)" \
      "$(cat "$cg/memory.current" 2> /dev/null || echo null)" "${rig:-0}" \
      "$(cat /sys/fs/cgroup/system.slice/"$unit"-stub-*.scope/cpu.stat 2> /dev/null | awk '$1 == "usage_usec" {s += $2} END {printf "%.0f", s}')" >> "$out/gw.jsonl"
    sleep 1
  done
}

jq -n --arg name "$name" --arg from "$from" --argjson level "$level" --arg rates "$rates" --argjson firstRate "$first_rate" \
  --argjson rampRate "$ramp_rate" --argjson settle "$settle" --argjson before "$before" --argjson hold "$hold" \
  --argjson shards "$shards" --arg sources "$sources" --arg gwCpus "$gw_cpus" --arg gwMem "$gw_mem" --arg gwCpuset "$gw_cpuset" \
  --arg rigCpuset "$rig_cpuset" --arg sha "$(git -C "$repo" rev-parse HEAD)" --arg epc "$epc" \
  '{name: $name, from: $from, sha: $sha, level: $level, rates: ($rates | split(",")), firstRate: $firstRate, rampRate: $rampRate,
    settle: $settle, before: $before, hold: $hold, shards: $shards, sources: ($sources | split(",")), eventsPerConnection: $epc,
    gateway: {cpus: $gwCpus, memory: $gwMem, cpuset: $gwCpuset}, rigCpuset: $rigCpuset, loadgenArgs: ["-volatile"]}' > "$out/run.json"

k=1
start_gateway "$k" "$first_rate"
await_gateway
ev gateway_up "\"k\":$k,\"rate\":\"$first_rate\",\"pid\":$(gw_pid)"
sample & sampler_pid=$!

# The fleet's first <level> runners at the cell's traffic, for long enough to outlast every restart.
event_rate="$(awk -v l="$level" -v e="$epc" 'BEGIN{printf "%.3f", l * e}')"
dir="$out/levels/$level"
for s in $(seq 0 $((shards - 1))); do
  mkdir -p "$dir/shard-$s"
  start_scope "$unit-loadgen-$level-$s" "$dir/shard-$s/stderr" -p MemoryMax=6G -p MemorySwapMax=0 -p "AllowedCPUs=$rig_cpuset" -- \
    env -i PATH=/usr/bin:/bin sh -c 'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh \
    "$bin/loadgen" -fleet "$fleet" -api "http://127.0.0.1:$((stub_base + s % stubs))" \
    -link-url "$link_url" -connect "127.0.0.1:$link_port" -ca "$sec/ca.pem" -out "$dir/shard-$s" -runners "$level" \
    -shard "$s/$shards" -source "$sources" -histograms -interval "$interval" -ramp-rate "$ramp_rate" -settle "${settle}s" \
    -duration 4h -event-rate "$event_rate" -volatile
done
ev loadgen_started "\"level\":$level,\"rampRate\":$ramp_rate,\"eventRate\":$event_rate"

# await_back <deadline seconds> <tag>: polls link_connections every second, writing when it first reaches 50, 90, 99
# and 100% of the level.
await_back() {
  local limit="$1" tag="$2" t0 c pct next=0
  local -a marks=(50 90 99 100)
  t0="$(date +%s)"
  while :; do
    c="$(conns || true)"
    if [ -n "$c" ]; then
      while [ "$next" -lt 4 ] && [ "$c" -ge $((level * ${marks[$next]} / 100)) ]; do
        ev "$tag" "\"pct\":${marks[$next]},\"conns\":$c"
        next=$((next + 1))
      done
      [ "$next" -lt 4 ] || return 0
    fi
    [ $(($(date +%s) - t0)) -lt "$limit" ] || { ev "${tag}_gave_up" "\"conns\":${c:-null}"; return 1; }
    sleep 1
  done
}
await_back $((level / ramp_rate + 300)) ramped
sleep "$settle"
ev steady_from
sleep "$before"

IFS=, read -r -a rate_list <<<"$rates"
for rate in "${rate_list[@]}"; do
  old_pid="$(gw_pid)"
  c0="$(conns || true)"
  ev sigterm "\"k\":$k,\"pid\":$old_pid,\"conns\":${c0:-null}"
  systemctl kill --signal=SIGTERM "$gw_unit.scope"
  t_term="$(date +%s)"
  while kill -0 "$old_pid" 2> /dev/null; do
    if [ $(($(date +%s) - t_term)) -ge 180 ]; then
      ev sigkill "\"k\":$k,\"pid\":$old_pid"
      systemctl kill --signal=SIGKILL "$gw_unit.scope" || true
    fi
    sleep 0.2
  done
  ev exited "\"k\":$k,\"pid\":$old_pid"
  k=$((k + 1))
  start_gateway "$k" "$rate"
  await_gateway
  ev gateway_up "\"k\":$k,\"rate\":\"$rate\",\"pid\":$(gw_pid)"
  await_back "$max_back" back || true
  sleep "$hold"
  c0="$(conns || true)"
  ev held "\"k\":$k,\"conns\":${c0:-null}"
done
ev done
