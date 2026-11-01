#!/usr/bin/env bash
# Drives the two gateway restarts of task C2b's step 4 against a load test that is already running: one release
# (SIGTERM, the gateway drains) and one crash (SIGKILL, every connection drops at once), each measured by
# reconnect-probe.sh. The first run's method, task comment "C2b 证据 11".
#
#   scripts/runner-link/reconnect-drill.sh --out <dir> [--first 10m] [--second 20m]
#
# Start it beside loadgen-run.sh, not inside it: it waits for the fleet to be whole, waits out the loadgen's settle, and
# then places each kill at --first and --second into the steady window. Each probe holds 5 minutes of baseline before
# its kill, so --first must be at least 5m and the two at least 8m apart.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=staging-lib.sh
source "$here/staging-lib.sh"

out=""
first=600
second=1200
connections="${PROBE_CONNECTIONS:-15000}"
settle="${DRILL_SETTLE:-180}"
baseline="${PROBE_BEFORE_WINDOW:-300}"
to_seconds() { case "$1" in *m) echo $(( ${1%m} * 60 )) ;; *s) echo "${1%s}" ;; *) echo "$1" ;; esac; }
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --first) first="$(to_seconds "$2")"; shift 2 ;;
    --second) second="$(to_seconds "$2")"; shift 2 ;;
    --connections) connections="$2"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done
[ -n "$out" ] || die "--out <dir> is required"
[ "$first" -ge "$baseline" ] || die "--first must be at least ${baseline}s: each probe holds that much baseline"
[ $(( second - first )) -ge $(( baseline + 180 )) ] || die "--first and --second must be at least $(( baseline + 180 ))s apart"
mkdir -p "$out"
metrics="http://127.0.0.1:$(setting STAGING_METRICS_PORT 19464)/metrics"
connections_now() { curl -fsS --max-time 2 "$metrics" 2>/dev/null | awk '/^link_connections /{print int($2); exit}'; }

log "waiting for the fleet to reach $connections connections"
for _ in $(seq 1 1800); do
  n="$(connections_now || true)"
  [ -n "${n:-}" ] && [ "$n" -ge "$connections" ] && break
  sleep 2
done
n="$(connections_now || true)"
[ -n "${n:-}" ] && [ "$n" -ge "$connections" ] || die "the fleet did not reach $connections (last ${n:-none})"
log "the fleet is whole; waiting out the loadgen's ${settle}s settle"
sleep "$settle"
steady="$(date +%s)"
printf '{"steadyOpenedAt":"%s","first":%s,"second":%s}\n' "$(date -u -d "@$steady" +%Y-%m-%dT%H:%M:%SZ)" "$first" "$second" > "$out/drill.json"
log "steady window open at $(date -u -d "@$steady" +%H:%M:%SZ); release at +$((first / 60))m, crash at +$((second / 60))m"

run_at() { # <offset-seconds> <signal> <name>
  local target=$(( steady + $1 - baseline )) now
  now="$(date +%s)"
  [ "$target" -gt "$now" ] && sleep $(( target - now ))
  log "probe $3 ($2): baseline starts now, kill in ${baseline}s"
  PROBE_BEFORE_WINDOW="$baseline" PROBE_CONNECTIONS="$connections" \
    bash "$here/reconnect-probe.sh" --out "$out/$3" --signal "$2" 2>&1 | sed "s/^/[$3] /"
}
run_at "$first" TERM release
run_at "$second" KILL crash
log "both probes done; reducing"
node "$here/reconnect-report.mjs" "$out/release" "$out/crash" > "$out/reconnect.json"
log "written to $out/reconnect.json"
