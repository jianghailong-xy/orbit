#!/usr/bin/env bash
# The runner link on a weak path (docs/runner-link-design.md §15.15; task 354YicPMgGZ170JyihWJh), drilled on a staging
# stack with real runners, shaped as ai-sg's path is: no proxy, plain ws:// to the web gateway's port (same-origin,
# weak-link.compose.yml), over a WireGuard tunnel with an MTU of 1280, with the loss, the delay and the rate under the
# tunnel (tc netem on both ends of the veth it runs over, so both directions). The runner runs in a network namespace of
# its own, whose only way to the stack is the tunnel.
#
#   weak-link-drill.sh net-up | net-down
#   weak-link-drill.sh shape LOSS% [RATE_KBIT [DELAY_MS [both|up|down]]]   (shape off: no netem)
#   weak-link-drill.sh stack [IMAGE]          the stack, up and same-origin; IMAGE runs another link gateway image
#   weak-link-drill.sh runner LABEL REF       build the runner and the scripted claude from REF (HEAD: this checkout's
#                                             worktree as it is; else a git ref), register it as LABEL and start it
#   weak-link-drill.sh start-runner LABEL | stop-runner LABEL
#   weak-link-drill.sh weak LABEL LOSS% MINUTES [TICKS [TICK_KIB [all|big]]]
#                                             the backlog run: a session whose engine wrote TICKS x TICK_KIB of durable
#                                             events while the path was cut, then MINUTES on the shaped path
#   weak-link-drill.sh dead LABEL quiet|busy|half-up|half-down
#                                             the path dies (loss 100%, or one direction of it): how soon, and by what,
#                                             the connection ends
#   weak-link-drill.sh drain LABEL TICKS TICK_KIB [DELAY_MS]
#                                             the backlog drained on a fast path: its rate
#   weak-link-drill.sh down                   the stack down, the network removed, the runners stopped
#
# Settings: the staging stack's own (staging-lib.sh), defaulting here to the project orbit-link-cdc3ac on ports 33xxx,
# bound to the tunnel's host address. Records go to <state>/client/weak-link/<run>/. Needs root, docker, wg, tc, node, go.
set -euo pipefail
export ORBIT_LINK_STAGING_PROJECT="${ORBIT_LINK_STAGING_PROJECT:-orbit-link-cdc3ac}"
export ORBIT_LINK_STAGING_DIR="${ORBIT_LINK_STAGING_DIR:-/var/tmp/$ORBIT_LINK_STAGING_PROJECT}"
export ORBIT_LINK_STAGING_HTTP_PORT="${ORBIT_LINK_STAGING_HTTP_PORT:-33086}"
export ORBIT_LINK_STAGING_LINK_PORT="${ORBIT_LINK_STAGING_LINK_PORT:-33443}"
export ORBIT_LINK_STAGING_METRICS_PORT="${ORBIT_LINK_STAGING_METRICS_PORT:-33464}"
export ORBIT_LINK_STAGING_NATS_PORT="${ORBIT_LINK_STAGING_NATS_PORT:-33422}"
export ORBIT_LINK_STAGING_NATS_MONITOR_PORT="${ORBIT_LINK_STAGING_NATS_MONITOR_PORT:-33822}"
# The tunnel: the host's end, which the stack's ports listen on, and the runner's.
wg_host=10.78.0.1 wg_runner=10.78.0.2 wg_port=51879
veth_host=10.79.0.1 veth_runner=10.79.0.2
export ORBIT_LINK_STAGING_BIND="${ORBIT_LINK_STAGING_BIND:-$wg_host}"
export ORBIT_LINK_STAGING_HOST="${ORBIT_LINK_STAGING_HOST:-$wg_host}"
# shellcheck source=../staging-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../staging-lib.sh"
source "$(dirname "${BASH_SOURCE[0]}")/../../lib/session-word.sh"
helper="$here/drills/drill-api.mjs"
overlay="$here/drills/weak-link.compose.yml"
ns=orbit-wl
dev_host=wlh0 dev_runner=wln0 wg_dev_host=wlwg0 wg_dev_runner=wlwg1
base="$state/weak-link"
records="$state/client/weak-link"
gateway="$project-link-gateway"
primary="$project-postgres"
origin="http://$wg_host:$ORBIT_LINK_STAGING_HTTP_PORT"
mkdir -p "$base" "$records"

now() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
say() { echo "$(now) $*" | tee -a "${timeline:-$records/drill.log}" >&2; }
fail() { say "FAIL: $*"; exit 1; }
json() { node -pe "const v = JSON.parse(process.argv[1]).$2; typeof v === 'object' ? JSON.stringify(v) : String(v)" "$1"; }
api() { node "$helper" "$origin" "$state" "$@"; }
psql_value() { docker exec "$primary" psql -U orbit -d orbit -tAc "$1"; }
psql_rows() { docker exec "$primary" psql -U orbit -d orbit -tA -F $'\t' -c "$1"; }
wait_until() { # SECONDS CMD...: CMD holds within SECONDS
  local deadline=$((SECONDS + $1))
  shift
  until "$@"; do
    [ $SECONDS -lt $deadline ] || return 1
    sleep 1
  done
}

# --- The path. --------------------------------------------------------------------------------------------------------
net_up() {
  ip netns list | grep -qw "$ns" && { say "net: $ns is up already"; return 0; }
  mkdir -p "$base/wg"
  umask 077
  [ -f "$base/wg/host.key" ] || { wg genkey > "$base/wg/host.key"; wg genkey > "$base/wg/runner.key"; }
  umask 022
  ip netns add "$ns"
  ip link add "$dev_host" type veth peer name "$dev_runner"
  ip link set "$dev_runner" netns "$ns"
  ip addr add "$veth_host/30" dev "$dev_host"
  ip link set "$dev_host" up
  ip -n "$ns" addr add "$veth_runner/30" dev "$dev_runner"
  ip -n "$ns" link set "$dev_runner" up
  ip -n "$ns" link set lo up
  ip link add "$wg_dev_host" type wireguard
  wg set "$wg_dev_host" listen-port "$wg_port" private-key "$base/wg/host.key" \
    peer "$(wg pubkey < "$base/wg/runner.key")" allowed-ips "$wg_runner/32"
  ip addr add "$wg_host/24" dev "$wg_dev_host"
  ip link set "$wg_dev_host" mtu 1280 up
  ip -n "$ns" link add "$wg_dev_runner" type wireguard
  ip netns exec "$ns" wg set "$wg_dev_runner" private-key "$base/wg/runner.key" \
    peer "$(wg pubkey < "$base/wg/host.key")" allowed-ips "$wg_host/32" endpoint "$veth_host:$wg_port" persistent-keepalive 25
  ip -n "$ns" addr add "$wg_runner/24" dev "$wg_dev_runner"
  ip -n "$ns" link set "$wg_dev_runner" mtu 1280 up
  ip netns exec "$ns" ping -c 2 -W 2 "$wg_host" > /dev/null || fail "net: the tunnel does not carry a ping"
  say "net: $ns up: runner $wg_runner -> tunnel (mtu 1280) -> $wg_host, over veth $veth_runner <-> $veth_host"
}
net_down() {
  ip link del "$wg_dev_host" 2> /dev/null || true
  ip link del "$dev_host" 2> /dev/null || true
  ip netns del "$ns" 2> /dev/null || true
}
# shape LOSS [RATE_KBIT [DELAY_MS [both|up|down [all|big]]]]: netem under the tunnel. up is the runner's way to the
# stack, down the stack's to the runner; the other direction is left as it was. all loses LOSS% of every packet; big
# only of the tunnel's packets over 1000 bytes, as ai-sg's path lost them (small pings 0%, 1200-byte ones 47% there and
# back): netem then delays and rates every packet, and an nftables rule drops the big ones at random.
nft_table=orbit_weak_link
shape() {
  local loss=$1 rate=${2:-400} delay=${3:-60} dir=${4:-both} which=${5:-all}
  tc qdisc del dev "$dev_host" root 2> /dev/null || true
  ip netns exec "$ns" tc qdisc del dev "$dev_runner" root 2> /dev/null || true
  nft delete table inet "$nft_table" 2> /dev/null || true
  ip netns exec "$ns" nft delete table inet "$nft_table" 2> /dev/null || true
  if [ "$loss" = off ]; then
    say "shape: off"
    return
  fi
  local netem_loss="${loss%\%}" rule=""
  if [ "$which" = big ]; then
    netem_loss=0
    rule="table inet $nft_table {
  chain out {
    type filter hook output priority 0; policy accept;
    oifname \"OIF\" meta length > 1000 numgen random mod 100 < ${loss%\%} drop
  }
}"
  fi
  local args=(netem delay "${delay}ms" loss "${netem_loss}%" limit 100)
  [ "$rate" = 0 ] || args+=(rate "${rate}kbit")
  if [ "$dir" = both ] || [ "$dir" = down ]; then
    tc qdisc replace dev "$dev_host" root "${args[@]}"
    [ -z "$rule" ] || nft -f - <<< "${rule/OIF/$dev_host}"
  fi
  if [ "$dir" = both ] || [ "$dir" = up ]; then
    ip netns exec "$ns" tc qdisc replace dev "$dev_runner" root "${args[@]}"
    [ -z "$rule" ] || ip netns exec "$ns" nft -f - <<< "${rule/OIF/$dev_runner}"
  fi
  say "shape: $dir ${args[*]}${rule:+; and ${loss%\%}% of the packets over 1000 bytes dropped}"
}

# --- The stack. -------------------------------------------------------------------------------------------------------
overlay_compose() {
  local files=()
  mapfile -t files < <(compose_files)
  env -i PATH="$PATH" HOME="${HOME:-/root}" DRILL_LINK_GATEWAY_IMAGE="${DRILL_LINK_GATEWAY_IMAGE:-}" \
    docker compose -p "$project" --project-directory "$repo" --env-file "$env_file" "${files[@]}" -f "$overlay" "$@"
}
stack() {
  [ -f "$state/staging.json" ] || "$here/staging-up.sh" > "$records/staging-up.log" 2>&1 ||
    fail "staging-up.sh (see $records/staging-up.log)"
  DRILL_LINK_GATEWAY_IMAGE="${1:-}" overlay_compose --profile runner-link up -d --no-deps --no-build --force-recreate \
    --wait link-gateway apiserver > "$records/stack-compose.log" 2>&1 || fail "stack: same-origin (see $records/stack-compose.log)"
  say "stack: $project same-origin at $origin, link gateway $(docker inspect -f '{{.Config.Image}}' "$gateway")"
}

# --- Runners. ---------------------------------------------------------------------------------------------------------
rdir() { echo "$base/runner-$1"; }
unit() { echo "$project-wl-$1.service"; }
runner_cmd() { # LABEL: the runner LABEL's binary as RUNNER, in the network namespace, the scripted claude its engine
  local d account_home
  d="$(rdir "$1")"
  account_home="$(getent passwd "$(id -un)" | cut -d: -f6)"
  RUNNER=(ip netns exec "$ns" /usr/bin/unshare -m --propagation private -- /bin/sh -c '
    d=$1 home=$2
    shift 2
    if [ -d "$home/.local/bin" ]; then mount --bind "$d/fakebin" "$home/.local/bin" || exit 1; fi
    for dir in .kimi-code/bin .opencode/bin; do
      if [ -d "$home/$dir" ]; then mount --bind "$d/empty" "$home/$dir" || exit 1; fi
    done
    exec "$@"' sh "$d" "$account_home"
    /usr/bin/env -i HOME="$d/home" ORBIT_HOME="$d/orbit" USER="$(id -un)" LOGNAME="$(id -un)"
    PATH="$d/fakebin:/usr/sbin:/usr/bin:/sbin:/bin" ORBIT_NO_SELFUPDATE=1 ORBIT_NO_ENGINE_UPDATE=1 TMPDIR="$d/tmp"
    "$d/bin/orbit")
}
runner_id() { node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).runnerId' "$(rdir "$1")/orbit/config.json"; }
runner() {
  local label=$1 ref=$2 d src
  d="$(rdir "$label")"
  systemctl stop "$(unit "$label")" 2> /dev/null || true
  rm -rf "$d"
  mkdir -p "$d"/{bin,home,orbit,fakebin,fake,empty,tmp,work,src}
  if [ "$ref" = HEAD ]; then
    src="$repo/src/runner-go"
    echo "$(git -C "$repo" rev-parse HEAD) $(git -C "$repo" status --short -- src/runner-go | wc -l) paths changed" > "$d/source"
  else
    git -C "$repo" archive "$ref" src/runner-go | tar -x -C "$d/src"
    src="$d/src/src/runner-go"
    echo "$(git -C "$repo" rev-parse "$ref") ($ref)" > "$d/source"
  fi
  (cd "$src" && go build -o "$d/bin/orbit" . && go test -c -o "$d/fake/orbit.test" .) > "$d/build.log" 2>&1 ||
    fail "runner $label: building from $ref (see $d/build.log)"
  cat > "$d/fakebin/claude" <<EOF
#!/bin/sh
case "\$1 \$2" in
"auth status") echo '{"loggedIn":true}'; exit 0 ;;
esac
ORBIT_FAKE_CLAUDE_DIR=$d/fake ORBIT_FAKE_CLAUDE_WAIT=3h exec $d/fake/orbit.test "\$@"
EOF
  chmod 755 "$d/fakebin/claude"
  local token name="weak-link-$label-$(date -u +%m%d-%H%M%S)"
  token="$(json "$(api enrollment-token "$name")" token)"
  runner_cmd "$label"
  "${RUNNER[@]}" register --server "$origin" --token "$token" --name "$name" --no-service --no-auto-install-engines \
    < /dev/null > "$d/register.log" 2>&1 || fail "runner $label: registering (see $d/register.log)"
  start_runner "$label"
  wait_until 180 grep -q 'carries the work of process' "$d/runner.log" || fail "runner $label: no link connection within 180 s"
  api workspace "$(runner_id "$label")" "$d/work" "$name" > "$d/workspace.json" || fail "runner $label: its workspace"
  say "runner $label: $name ($(runner_id "$label")) from $(cat "$d/source"), $("$d/bin/orbit" --version 2>&1 | head -n 1)"
}
start_runner() {
  local d
  d="$(rdir "$1")"
  runner_cmd "$1"
  touch "$d/runner.log"
  systemd-run --unit "$(unit "$1")" --collect --quiet -p KillMode=mixed -p TimeoutStopSec=60 \
    -p StandardOutput="append:$d/runner.log" -p StandardError="append:$d/runner.log" -- "${RUNNER[@]}" run
}
stop_runner() { systemctl stop "$(unit "$1")" 2> /dev/null || true; }

# --- Sessions. --------------------------------------------------------------------------------------------------------
# open_session LABEL NAME TICKS KIB: a session on runner LABEL whose prompt's answer is TICKS assistant messages of about
# KIB KiB each, tick K once NAME-K is released, then a result. Sets sid, suuid, fake.
open_session() {
  local d
  d="$(rdir "$1")"
  fake="$d/fake"
  node -e '
    const [file, name, ticks, kib] = process.argv.slice(1);
    const steps = [{ await: "user" }, { emit: "replay_user" }, { emit: "system_init", version: "2.1.300" }];
    const filler = "x".repeat(Number(kib) * 1024);
    for (let k = 1; k <= Number(ticks); k += 1) {
      steps.push({ await: "release", text: `${name}-${k}` });
      steps.push({ emit: "assistant", text: `Weak link drill ${name}: tick ${k}. ${filler}` });
    }
    steps.push({ emit: "result", text: `Weak link drill ${name}: done.` });
    for (let n = 2; n <= 30; n += 1) steps.push({ await: "user" }, { emit: "replay_user" }, { emit: "assistant", text: "ok" }, { emit: "result", text: "ok" });
    require("fs").writeFileSync(file, JSON.stringify(steps));' "$fake/script.json" "$2" "$3" "$4"
  local created
  created="$(api session "$(json "$(cat "$d/workspace.json")" id)" "Weak link drill $2")" || fail "session $2"
  sid="$(json "$created" id)" suuid="$(json "$created" uuid)"
  wait_until 120 session_running || fail "session $2 ($sid) is not RUNNING within 120 s"
  say "session $2: $sid ($suuid) RUNNING on runner $1, $3 ticks of $4 KiB"
}
session_running() { [ "$(psql_value "SELECT $(session_word_sql s) FROM session s WHERE s.id = '$suuid'")" = RUNNING ]; }
release() { # NAME FROM TO
  local k
  for ((k = $2; k <= $3; k++)); do : > "$fake/release-$1-$k"; done
}
# ticks NAME: the session's stored ticks as "ROWS DISTINCT LAST".
ticks() {
  psql_value "SELECT count(*) || ' ' || count(DISTINCT k) || ' ' || COALESCE(max(k), 0) FROM (SELECT
    substring(payload->>'text' FROM '^Weak link drill $1: tick ([0-9]+)\.')::int AS k FROM run_event
    WHERE session_id = '$suuid' AND type = 'assistant') t WHERE k IS NOT NULL"
}
stored() { local t; t="$(ticks "$1" 2> /dev/null)" || t="0 0 0"; t="${t#* }"; echo "${t%% *}"; }
stored_ge() { [ "$(stored "$1")" -ge "$2" ] 2> /dev/null; }
holes() {
  psql_value "SELECT COALESCE(string_agg(g::text, ',' ORDER BY g), '') FROM generate_series(1, (SELECT COALESCE(max(seq), 0)
    FROM run_event WHERE session_id = '$suuid')) g WHERE g NOT IN (SELECT seq FROM run_event WHERE session_id = '$suuid')"
}
seqs() {
  psql_value "SELECT count(*) || ' rows, seq ' || COALESCE(min(seq), 0) || '..' || COALESCE(max(seq), 0) || ', ' ||
    count(*) FILTER (WHERE type = 'tombstone') || ' tombstones' FROM run_event WHERE session_id = '$suuid'"
}
# drained_at NAME N: when the session's tick N was stored (the database's clock), as epoch seconds.
stored_at() {
  psql_value "SELECT extract(epoch FROM max(ingested_at)) FROM run_event WHERE session_id = '$suuid' AND type = 'assistant'"
}

# --- Records. ---------------------------------------------------------------------------------------------------------
begin_run() { # NAME: a run's records directory, emptied
  run_dir="$records/$1"
  rm -rf "$run_dir"
  mkdir -p "$run_dir"
  timeline="$run_dir/timeline.txt"
}
log_mark() { wc -l < "$(rdir "$1")/runner.log"; }
log_from() { awk -v from="$2" 'NR > from' "$(rdir "$1")/runner.log"; }
# logged LABEL FROM PATTERN: the runner's log holds PATTERN after line FROM.
logged() { log_from "$1" "$2" | grep -q -- "$3"; }
# connection_report LABEL FROM: what the runner's log says of its connections after line FROM.
connection_report() {
  local lines
  lines="$(log_from "$1" "$2")"
  echo "welcomed: $(grep -c 'carries the work of process\|replaced by' <<< "$lines" || true)"
  echo "ended: $(grep -c 'connection c-[0-9a-f]* ended (' <<< "$lines" || true)"
  echo "cannot connect: $(grep -c 'cannot connect' <<< "$lines" || true)"
  echo "heartbeat failed: $(grep -c 'heartbeat failed' <<< "$lines" || true)"
  echo "slow heartbeat lines: $(grep -c 'was answered .* after it was sent' <<< "$lines" || true)"
  echo "--- the causes"
  grep -o 'ended (.*); reconnecting' <<< "$lines" | sed -E 's/c-[0-9a-f]+/c-…/g; s/[0-9]+(\.[0-9]+)?(ms|s|µs)/N\2/g' |
    sort | uniq -c | sort -rn || true
}
collect() { # LABEL FROM SINCE: the run's logs
  log_from "$1" "$2" > "$run_dir/runner.log"
  docker logs --since "$3" "$gateway" > "$run_dir/link-gateway.log" 2>&1 || true
  docker logs --since "$3" "$project-gateway" > "$run_dir/web-gateway.log" 2>&1 || true
  connection_report "$1" "$2" > "$run_dir/connections.txt"
}

# --- Runs. ------------------------------------------------------------------------------------------------------------
weak() {
  local label=$1 loss=$2 minutes=$3 n=${4:-40} kib=${5:-128} which=${6:-all} name from since t0 end
  name="weak-$label-${loss%\%}-$which-$(date -u +%H%M%S)"
  begin_run "$name"
  say "weak: runner $label ($(cat "$(rdir "$label")/source")), loss $loss ($which packets), $minutes min, a backlog of $n x $kib KiB"
  shape off
  open_session "$label" "$name" "$n" "$kib"
  from="$(log_mark "$label")"
  since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  shape 100 0 0
  wait_until 120 logged "$label" "$from" 'connection c-[0-9a-f]* ended (' || fail "weak: the cut path's connection did not end within 120 s"
  say "weak: the path is cut and the connection ended: $(log_from "$label" "$from" | grep -o 'ended (.*' | head -n 1)"
  release "$name" 1 "$n"
  sleep 5
  say "weak: $n ticks released while cut (about $((n * kib / 1024)) MiB unacknowledged); stored so far $(stored "$name")"
  local mark
  mark="$(log_mark "$label")"
  shape "$loss" 400 60 both "$which"
  t0=$SECONDS
  end=$((SECONDS + minutes * 60))
  printf 'elapsed_s\tstored\twelcomed\tended\n' > "$run_dir/samples.tsv"
  while [ $SECONDS -lt $end ]; do
    local l
    l="$(log_from "$label" "$mark")"
    printf '%s\t%s\t%s\t%s\n' $((SECONDS - t0)) "$(stored "$name")" "$(grep -c 'carries the work of process\|replaced by' <<< "$l" || true)" \
      "$(grep -c 'connection c-[0-9a-f]* ended (' <<< "$l" || true)" >> "$run_dir/samples.tsv"
    sleep 10
  done
  local drained
  drained="$(awk -F'\t' -v n="$n" 'NR > 1 && $2 >= n { print $1; exit }' "$run_dir/samples.tsv")"
  say "weak: after $minutes min: ticks stored $(ticks "$name") (rows distinct last), all stored by ${drained:-never} s; seqs $(seqs); holes [$(holes)]"
  collect "$label" "$mark" "$since"
  say "weak: connections after the shaped path began: $(tr '\n' ';' < "$run_dir/connections.txt")"
  shape off
}

dead() {
  local label=$1 mode=$2 name from since cut ended_at
  name="dead-$label-$mode-$(date -u +%H%M%S)"
  begin_run "$name"
  shape off
  say "dead: runner $label ($(cat "$(rdir "$label")/source")), $mode"
  if [ "$mode" = busy ]; then
    open_session "$label" "$name" 2000 64
    # The engine writes 64 KiB every 0.2 s from now on, as long as the drill lasts.
    systemd-run --unit "$project-wl-ticker.service" --collect --quiet -- /bin/bash -c \
      'for ((k = 1; k <= 2000; k++)); do : > "$0/release-$1-$k"; sleep 0.2; done' "$fake" "$name"
    sleep 15
  fi
  # A connection that has settled: its first beat is behind it.
  sleep 5
  from="$(log_mark "$label")"
  since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  case "$mode" in
  quiet | busy) shape 100 0 0 both ;;
  half-up) shape 100 0 0 down ;; # the runner's frames reach the gateway; nothing comes back
  half-down) shape 100 0 0 up ;; # the gateway's frames reach the runner; nothing it sends arrives
  esac
  cut=$SECONDS
  wait_until 300 logged "$label" "$from" 'connection c-[0-9a-f]* ended (' || say "dead: no end within 300 s"
  ended_at=$((SECONDS - cut))
  say "dead: $mode: the runner ended its connection ${ended_at} s after the cut: $(log_from "$label" "$from" | grep -o 'ended (.*' | head -n 1)"
  systemctl stop "$project-wl-ticker.service" 2> /dev/null || true
  sleep 3
  collect "$label" "$from" "$since"
  grep -E 'connection (closed|ended|lost)|ping_timeout|write_timeout' "$run_dir/link-gateway.log" | tail -n 5 > "$run_dir/gateway-closes.txt" || true
  say "dead: the gateway's closes: $(tr '\n' '|' < "$run_dir/gateway-closes.txt" | cut -c1-600)"
  shape off
  wait_until 180 logged "$label" "$from" 'carries the work of process' || say "dead: no reconnect within 180 s of the path's return"
}

drain() {
  local label=$1 n=$2 kib=$3 delay=${4:-0} name from since t0 last
  name="drain-$label-$((n * kib / 1024))MiB-${delay}ms-$(date -u +%H%M%S)"
  begin_run "$name"
  shape off
  open_session "$label" "$name" "$n" "$kib"
  from="$(log_mark "$label")"
  since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  shape 100 0 0
  wait_until 120 logged "$label" "$from" 'connection c-[0-9a-f]* ended (' || fail "drain: the cut path's connection did not end"
  release "$name" 1 "$n"
  sleep 10
  local mark
  mark="$(log_mark "$label")"
  if [ "$delay" = 0 ]; then shape off; else shape 0 0 "$((delay / 2))"; fi
  wait_until 300 logged "$label" "$mark" 'carries the work of process' || fail "drain: no reconnect"
  t0="$(date +%s.%N)"
  wait_until 1800 stored_ge "$name" "$n" || say "drain: not drained within 30 min"
  last="$(stored_at)"
  local secs
  secs="$(awk -v a="$t0" -v b="$last" 'BEGIN { printf "%.1f", b - a }')"
  say "drain: $n x $kib KiB ($((n * kib / 1024)) MiB) drained in $secs s from the Welcome: $(awk -v s="$secs" -v m="$((n * kib))" 'BEGIN { printf "%.2f MiB/s", m / 1024 / s }'); seqs $(seqs); holes [$(holes)]"
  collect "$label" "$mark" "$since"
  shape off
}

case "${1:-}" in
net-up) net_up ;;
net-down) net_down ;;
shape) shift; timeline="$records/drill.log"; shape "$@" ;;
stack) stack "${2:-}" ;;
runner) runner "$2" "$3" ;;
start-runner)
  start_runner "$2"
  from=0
  wait_until 180 logged "$2" "$(($(log_mark "$2") - 1))" 'carries the work of process' || true
  ;;
stop-runner) stop_runner "$2" ;;
weak) shift; weak "$@" ;;
dead) dead "$2" "$3" ;;
drain) shift; drain "$@" ;;
down)
  for u in $(systemctl list-units --plain --no-legend "$project-wl-*" | awk '{print $1}'); do systemctl stop "$u" || true; done
  "$here/staging-down.sh"
  net_down
  ;;
*) sed -n '2,25p' "$0"; exit 2 ;;
esac
