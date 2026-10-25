#!/usr/bin/env bash
# Runs one load test against the staging stack (src/link-gateway/cmd/loadgen, task C2) and collects what the stack saw
# beside what the runners saw, then writes the report (loadgen-report.mjs).
#
#   scripts/runner-link/loadgen-seed.sh arm                          # fresh running sessions and the fleet file
#   scripts/runner-link/loadgen-run.sh --name full-1h -- -duration 1h -event-rate 2000
#
# Arguments after -- go to loadgen; the fleet, the API, the link address and the CA are filled in from the stack. The
# stack must run in MODE_LINK with the load test's settings (ORBIT_LINK_STAGING_MODE=link ORBIT_LINK_STAGING_LOADGEN=1).
#
# Results go to <state>/loadgen/runs/<name>/:
#   report.md, report.json   the verdict and every figure it rests on (loadgen-report.mjs)
#   series.jsonl, summary.json, errors.log, loadgen.stderr   what the runners saw (loadgen)
#   samples.jsonl            every 5 s: CPU, CPU pressure and memory of the stack's containers and the loadgen, the host's
#                            CPU, load, memory and swap
#   slices.jsonl             every 15 s: CPU of every service and container on the host, for what else ran
#   metrics.prom             every 15 s: the link gateway's /metrics, each scrape after a "# scrape <ms>" line
#   db.jsonl                 every 15 s: the database's sessions by state, transactions, statements, rows and WAL
#                            position
#   pgss.json, db-before.json, db-after.json, sizes.txt, logs/   the database's statements, totals and the containers' logs
#
# The loadgen runs in a scope of its own (systemd-run), so an OOM kill takes it and not the runner service whose
# sessions share this host. On a shared host the run also stops itself when the host runs short of memory: after three
# samples in a row (15 s) below LOADGEN_MIN_AVAILABLE_MB (800) of MemAvailable, the loadgen is sent SIGINT, writes its
# summary and exits, and run.json's `stoppedForMemory` says so.
#
# --mark-every <seconds> moves every runner's change count that often during the run (runner_presence.changes, task
# O1), as a writer of something a heartbeat delivers does: each beat then reconciles in full. loadgen-baseline.mjs
# --full takes such a run to tell an unflagged beat's cost from a full reconcile's.
set -euo pipefail
# shellcheck source=staging-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/staging-lib.sh"

name="$(date -u +%Y%m%dT%H%M%SZ)"
mark_every=""
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --name) name="$2"; shift 2 ;;
    --) shift; args=("$@"); break ;;
    --mark-every) mark_every="$2"; shift 2 ;;
    -h|--help) sed -n '2,29p' "$0"; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done
[[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || die "--name is letters, digits, dots, underscores and hyphens"
[ -z "$mark_every" ] || [[ "$mark_every" =~ ^[1-9][0-9]*$ ]] || die "--mark-every is a whole number of seconds"
[ -f "$env_file" ] || die "no staging stack in $state: run staging-up.sh first"
[ "$(setting STAGING_MODE http)" = link ] || die "the stack is not in MODE_LINK: staging-up.sh with ORBIT_LINK_STAGING_MODE=link"
[ "$(setting STAGING_LOADGEN 0)" = 1 ] || die "the stack lacks the load test's settings: staging-up.sh with ORBIT_LINK_STAGING_LOADGEN=1"
fleet="$state/loadgen/fleet.jsonl"
[ -s "$fleet" ] || die "no fleet in $fleet: run loadgen-seed.sh seed, then arm"
out="$state/loadgen/runs/$name"
[ -e "$out" ] && die "$out exists: choose another --name"
mkdir -p "$out/logs"

pg="$project-postgres"
services=(postgres apiserver link-gateway gateway nats)
[ "$(setting STAGING_BACKENDS 1)" = 2 ] && services+=(apiserver-b)
declare -A cgroup
for svc in "${services[@]}"; do
  id="$(docker inspect -f '{{.Id}}' "$project-$svc")" || die "$project-$svc is not running"
  cgroup[$svc]="/sys/fs/cgroup/system.slice/docker-$id.scope"
  [ -d "${cgroup[$svc]}" ] || die "no cgroup at ${cgroup[$svc]} for $project-$svc (cgroup v2 with the systemd driver is expected)"
done
unit="c2-loadgen-$name"
cgroup[loadgen]="/sys/fs/cgroup/system.slice/$unit.scope"
gateway_ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$project-link-gateway")"
api="http://$(setting STAGING_BIND 127.0.0.1):$(setting STAGING_HTTP_PORT 18086)"
metrics="http://127.0.0.1:$(setting STAGING_METRICS_PORT 19464)/metrics"

log "building loadgen from $(git -C "$repo" rev-parse --short HEAD)"
(cd "$repo/src/link-gateway" && go build -trimpath -o "$out/loadgen" ./cmd/loadgen)

psql_at() { docker exec -i "$pg" psql -U orbit -d orbit -X -At -v ON_ERROR_STOP=1 "$@"; }
db_totals() {
  psql_at -c "SELECT json_build_object(
    't', (extract(epoch FROM clock_timestamp()) * 1000)::bigint,
    'xactCommit', xact_commit, 'xactRollback', xact_rollback, 'blksRead', blks_read, 'blksHit', blks_hit,
    'statements', (SELECT sum(calls) FROM pg_stat_statements),
    'tupInserted', tup_inserted, 'tupUpdated', tup_updated, 'tupDeleted', tup_deleted, 'tempBytes', temp_bytes,
    'deadlocks', deadlocks, 'conflicts', conflicts,
    'walBytes', pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0'),
    'backends', (SELECT json_object_agg(k, n) FROM (SELECT coalesce(state, 'none') || ':' || coalesce(wait_event_type, '-') AS k, count(*) AS n
                 FROM pg_stat_activity WHERE datname = 'orbit' GROUP BY 1) a),
    'lockWaits', (SELECT count(*) FROM pg_locks WHERE NOT granted))
  FROM pg_stat_database WHERE datname = 'orbit'"
}

# --- The run's configuration. ------------------------------------------------------------------------------------------
{
  printf '{"name":"%s","project":"%s","sha":"%s","dirty":%s,"dbCpus":"%s","backends":"%s","hostCpus":%s,"hostMemKb":%s,' \
    "$name" "$project" "$(git -C "$repo" rev-parse HEAD)" \
    "$([ -n "$(git -C "$repo" status --porcelain -- src scripts)" ] && echo true || echo false)" \
    "$(setting STAGING_DB_CPUS 0)" "$(setting STAGING_BACKENDS 1)" "$(nproc)" "$(awk '/^MemTotal/{print $2}' /proc/meminfo)"
  printf '"markEverySeconds":%s,' "${mark_every:-null}"
  if [ ${#args[@]} -gt 0 ]; then printf '"loadgenArgs":%s,' "$(printf '%s\n' "${args[@]}" | jq -R . | jq -cs .)"; else printf '"loadgenArgs":[],'; fi
  printf '"containers":{'
  first=1
  for svc in "${services[@]}"; do
    [ "$first" = 1 ] || printf ','
    first=0
    printf '"%s":{"image":"%s","cgroup":"%s","cpuMax":"%s","memoryMax":"%s"}' "$svc" "$(docker inspect -f '{{.Config.Image}}' "$project-$svc")" \
      "$(basename "${cgroup[$svc]}")" "$(cat "${cgroup[$svc]}/cpu.max")" "$(cat "${cgroup[$svc]}/memory.max")"
  done
  printf '}}\n'
} > "$out/run.json"
jq . "$out/run.json" > /dev/null || die "run.json is not JSON"

# --- Samplers. --------------------------------------------------------------------------------------------------------
min_available_kb=$(( ${LOADGEN_MIN_AVAILABLE_MB:-800} * 1024 ))
sample_cgroups() {
  local t line svc p usage thr mem some full avail low=0
  while :; do
    avail="$(awk '/^MemAvailable/{print $2}' /proc/meminfo)"
    if [ "$avail" -lt "$min_available_kb" ]; then low=$((low + 1)); else low=0; fi
    if [ "$low" -ge 3 ] && [ ! -e "$out/stopped-for-memory" ]; then
      date -u +%Y-%m-%dT%H:%M:%SZ > "$out/stopped-for-memory"
      systemctl kill --signal=SIGINT "$unit.scope" 2>/dev/null || true
    fi
    t="$(date +%s%3N)"
    line="{\"t\":$t"
    for svc in "${!cgroup[@]}"; do
      p="${cgroup[$svc]}"
      [ -f "$p/cpu.stat" ] || continue
      usage="$(awk '/^usage_usec/{print $2}' "$p/cpu.stat")"
      thr="$(awk '/^throttled_usec/{print $2}' "$p/cpu.stat")"
      mem="$(cat "$p/memory.current" 2>/dev/null || echo 0)"
      read -r some full < <(awk -F'total=' '/^some/{s=$2} /^full/{f=$2} END{print s+0, f+0}' "$p/cpu.pressure")
      line+=",\"$svc\":{\"cpuUsec\":${usage:-0},\"throttledUsec\":${thr:-0},\"memBytes\":$mem,\"psiSomeUsec\":$some,\"psiFullUsec\":$full}"
    done
    line+=",\"host\":{\"cpu\":[$(awk '/^cpu /{print $2","$3","$4","$5","$6","$7","$8","$9; exit}' /proc/stat)]"
    line+=",\"load\":[$(cut -d' ' -f1-3 /proc/loadavg | tr ' ' ',')]"
    line+=",\"memAvailKb\":$(awk '/^MemAvailable/{print $2}' /proc/meminfo),\"swapFreeKb\":$(awk '/^SwapFree/{print $2}' /proc/meminfo)"
    line+=",\"pswpin\":$(awk '/^pswpin/{print $2}' /proc/vmstat),\"pswpout\":$(awk '/^pswpout/{print $2}' /proc/vmstat)"
    line+=",\"psiSomeUsec\":$(awk -F'total=' '/^some/{print $2+0}' /proc/pressure/cpu)}}"
    printf '%s\n' "$line" >> "$out/samples.jsonl"
    sleep 5
  done
}
sample_slices() {
  local t d n line
  while :; do
    t="$(date +%s%3N)"
    line="{\"t\":$t"
    for d in /sys/fs/cgroup/system.slice/*/ /sys/fs/cgroup/user.slice/; do
      [ -f "$d/cpu.stat" ] || continue
      n="$(basename "$d")"
      n="${n//\\/\\\\}" # systemd escapes a unit name's dashes as \x2d
      line+=",\"$n\":$(awk '/^usage_usec/{print $2}' "$d/cpu.stat")"
    done
    printf '%s}\n' "$line" >> "$out/slices.jsonl"
    sleep 15
  done
}
sample_metrics() {
  local body
  while :; do
    if body="$(curl -fsS --max-time 10 "$metrics")"; then
      printf '# scrape %s\n%s\n' "$(date +%s%3N)" "$body" >> "$out/metrics.prom"
    fi
    sleep 15
  done
}
sample_db() {
  while :; do
    db_totals >> "$out/db.jsonl" 2>> "$out/db.err" || true
    sleep 15
  done
}
mark_runners() {
  while :; do
    psql_at -c 'UPDATE "runner_presence" SET "changes" = "changes" + 1' > /dev/null 2>> "$out/db.err" || true
    sleep "$mark_every"
  done
}
pids=()
stop_samplers() {
  local p
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  wait "${pids[@]}" 2>/dev/null || true
  pids=()
}
trap stop_samplers EXIT

# The deployment preloads pg_stat_statements; the staging database has not created the extension yet the first time.
psql_at -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements" -c "SELECT pg_stat_statements_reset()" > /dev/null
db_totals > "$out/db-before.json"
sample_cgroups & pids+=($!)
sample_slices & pids+=($!)
sample_metrics & pids+=($!)
sample_db & pids+=($!)
if [ -n "$mark_every" ]; then mark_runners & pids+=($!); fi

# --- The run. ---------------------------------------------------------------------------------------------------------
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
log "run $name: loadgen ${args[*]} (results in $out)"
rc=0
systemd-run --scope --quiet --unit "$unit" -p MemoryMax=6G \
  sh -c 'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh \
  "$out/loadgen" -fleet "$fleet" -api "$api" -link-url wss://link-gateway:8443 -connect "$gateway_ip:8443" \
  -ca "$state/tls/ca.pem" -out "$out" "${args[@]}" > "$out/loadgen.stdout" 2> "$out/loadgen.stderr" || rc=$?
log "loadgen exited $rc"
if [ -e "$out/stopped-for-memory" ]; then
  log "stopped at $(cat "$out/stopped-for-memory"): the host's available memory stayed under ${LOADGEN_MIN_AVAILABLE_MB:-800} MB"
  jq --arg at "$(cat "$out/stopped-for-memory")" '. + {stoppedForMemory: $at}' "$out/run.json" > "$out/run.json.new" && mv "$out/run.json.new" "$out/run.json"
fi
# The run's running sessions end now, before the reaper reads the fleet's silence (loadgen-seed.sh disarm).
bash "$here/loadgen-seed.sh" disarm || log "the running sessions could not be ended; arm ends them before the next run"
sleep 16 # one more scrape of everything after the drain
stop_samplers

# --- What the stack recorded. -----------------------------------------------------------------------------------------
db_totals > "$out/db-after.json"
psql_at -c "SELECT coalesce(json_agg(q), '[]') FROM (
  SELECT queryid::text, calls, round(total_exec_time::numeric, 1) AS total_ms, round(mean_exec_time::numeric, 3) AS mean_ms,
         round(max_exec_time::numeric, 1) AS max_ms, rows, shared_blks_hit, shared_blks_read, wal_bytes::bigint,
         left(regexp_replace(query, '\s+', ' ', 'g'), 400) AS query
  FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 60) q" > "$out/pgss.json"
psql_at -c "SELECT s.relname, pg_size_pretty(pg_total_relation_size(s.relid)), s.n_live_tup, s.n_dead_tup
  FROM pg_stat_user_tables s
  WHERE s.schemaname = 'public' AND s.relname IN ('run_event', 'tool_call', 'session', 'runner', 'runner_presence', 'workspace')" > "$out/sizes.txt"
df -h / "$state" >> "$out/sizes.txt"
for svc in "${services[@]}"; do
  docker logs --since "$started" "$project-$svc" > "$out/logs/$svc.log" 2>&1 || true
done

node "$here/loadgen-report.mjs" "$out" > "$out/report.md" || log "the report could not be written (see $out)"
log "report: $out/report.md"
exit "$rc"
