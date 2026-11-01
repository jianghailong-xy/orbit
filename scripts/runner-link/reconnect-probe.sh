#!/usr/bin/env bash
# Measures one gateway restart while a load test runs: what the 15,000 runners' reconnect costs, and what the welcome
# route costs inside it (task C2b, step 4; rebuilt from the first run's method, task comment "C2b 证据 11").
#
#   scripts/runner-link/reconnect-probe.sh --out <dir> --signal TERM   # a release: the gateway drains, then exits
#   scripts/runner-link/reconnect-probe.sh --out <dir> --signal KILL   # a crash: every connection drops at once
#
# Run it while loadgen-run.sh is in its steady window; it writes to <dir> (a directory of its own, not the run's) and
# leaves the run alone. It does not stop or start the loadgen.
#
# What it records, around the kill:
#   depth-before.json   the running sessions' stored events: the depth a Welcome's walk covers
#   pgss-before.json / pgss-after.json   pg_stat_statements for the welcome walk's statement and the database's totals
#   metrics.jsonl       the link gateway's /metrics every second, from 30 s before the kill until 60 s after the fleet
#                       is whole again: the handshake histogram, the welcome route's results, connections, drains
#   cpu.jsonl           every second: the stack's containers' cgroup CPU and memory, the host's CPU
#   web.jsonl           the web gateway's link-token responses by status (its access log, tailed)
#   events.jsonl        what happened and when: the kill, the old process's exit, the new one's start, each milestone
#   reaped.json         the sessions the reaper failed over the window, and each apiserver's "not reaping" lines
#   probe.json          every figure above, reduced: the row this run contributes to the report
#
# On Docker 29.9.2 `docker kill` counts as a manual stop, so `restart: unless-stopped` does not bring the container
# back (the first run found this; the README's drill says otherwise). The probe waits --restart-after seconds and then
# runs `docker start` itself, and events.jsonl says which of the two started it.
set -euo pipefail
# shellcheck source=staging-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/staging-lib.sh"

out=""
signal=""
expect_connections="${PROBE_CONNECTIONS:-15000}"
restart_after="${PROBE_RESTART_AFTER:-5}"
before_window="${PROBE_BEFORE_WINDOW:-300}"
settle_after="${PROBE_SETTLE_AFTER:-60}"
give_up="${PROBE_GIVE_UP:-600}"
exit_wait="${PROBE_EXIT_WAIT:-180}"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --signal) signal="$2"; shift 2 ;;
    --connections) expect_connections="$2"; shift 2 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done
[ -n "$out" ] || die "--out <dir> is required"
case "$signal" in TERM|KILL) ;; *) die "--signal is TERM or KILL, not ${signal:-(none)}" ;; esac
[ -f "$env_file" ] || die "no staging stack in $state: run staging-up.sh first"
[ -e "$out" ] && die "$out exists: choose another --out"
mkdir -p "$out"

pg="$project-postgres"
gw="$project-link-gateway"
metrics="http://127.0.0.1:$(setting STAGING_METRICS_PORT 19464)/metrics"
psql_at() { docker exec -i "$pg" psql -U orbit -d orbit -X -At -v ON_ERROR_STOP=1 "$@"; }
now_ms() { date +%s%3N; }
note() { printf '{"t":%s,"at":"%s","what":%s}\n' "$(now_ms)" "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" "$(jq -Rn --arg s "$1" '$s')" >> "$out/events.jsonl"; }

services=(postgres apiserver apiserver-b apiserver-c apiserver-d link-gateway gateway nats)
declare -A cgroup=()
for svc in "${services[@]}"; do
  id="$(docker inspect -f '{{.Id}}' "$project-$svc" 2>/dev/null)" || continue
  [ -d "/sys/fs/cgroup/system.slice/docker-$id.scope" ] && cgroup[$svc]="/sys/fs/cgroup/system.slice/docker-$id.scope"
done
[ -n "${cgroup[link-gateway]:-}" ] || die "no cgroup for $project-link-gateway"

# The statement the welcome route's walk runs (src/apiserver/src/runner-api/runner-link-welcome.ts): one call a Welcome,
# one row a session the runner named. Matched on its shape, so a change of whitespace does not lose it.
welcome_pgss="SELECT coalesce(json_agg(q), '[]') FROM (
  SELECT queryid::text, calls, round(total_exec_time::numeric, 3) AS total_ms, round(mean_exec_time::numeric, 4) AS mean_ms,
         round(max_exec_time::numeric, 3) AS max_ms, rows, shared_blks_hit, shared_blks_read,
         left(regexp_replace(query, '\s+', ' ', 'g'), 200) AS query
  FROM pg_stat_statements
  WHERE query LIKE '%assigned_runner_id%' AND query LIKE '%run_event%' AND query LIKE '%row_number() OVER%') q"
db_exec_totals="SELECT json_build_object('statements', count(*), 'calls', coalesce(sum(calls), 0),
  'totalExecMs', round(coalesce(sum(total_exec_time), 0)::numeric, 1)) FROM pg_stat_statements"

# --- Before the kill. -------------------------------------------------------------------------------------------------
note "probe started, signal $signal"
# The depth each Welcome's walk covers: the stored events of the sessions a running runner names. loadgen's sessions are
# the fleet's running ones, leased to a runner's process.
psql_at -c "WITH running AS (
    SELECT s.id FROM \"session\" s
    WHERE s.\"kind\" = 'CONVERSATION' AND s.\"inbox_lease_owner\" IS NOT NULL
      AND s.\"status\" IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
      AND s.\"assigned_runner_id\" IS NOT NULL),
  depth AS (SELECT r.id, (SELECT count(*) FROM \"run_event\" e WHERE e.\"session_id\" = r.id AND e.\"seq\" > 0) AS n FROM running r)
  SELECT json_build_object('sessions', count(*), 'events', coalesce(sum(n), 0),
    'mean', round(avg(n), 1), 'min', min(n), 'p50', percentile_disc(0.5) WITHIN GROUP (ORDER BY n),
    'p90', percentile_disc(0.9) WITHIN GROUP (ORDER BY n), 'max', max(n)) FROM depth" > "$out/depth-before.json"
psql_at -c "$welcome_pgss" > "$out/pgss-welcome-before.json"
psql_at -c "$db_exec_totals" > "$out/pgss-totals-before.json"
# Each runner's sessions in its Hello: how many rows one welcome call asks for.
psql_at -c "WITH per_runner AS (
    SELECT s.\"assigned_runner_id\" AS runner, count(*) AS n FROM \"session\" s
    WHERE s.\"kind\" = 'CONVERSATION' AND s.\"status\" IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
      AND s.\"assigned_runner_id\" IS NOT NULL GROUP BY 1)
  SELECT json_build_object('runners', count(*), 'mean', round(avg(n), 2), 'max', max(n)) FROM per_runner" > "$out/hello-sessions.json"

sample_cpu() {
  local line svc p
  while :; do
    line="{\"t\":$(now_ms)"
    for svc in "${!cgroup[@]}"; do
      p="${cgroup[$svc]}"
      [ -f "$p/cpu.stat" ] || continue
      line+=",\"$svc\":{\"cpuUsec\":$(awk '/^usage_usec/{print $2}' "$p/cpu.stat")"
      line+=",\"memBytes\":$(cat "$p/memory.current" 2>/dev/null || echo 0)}"
    done
    line+=",\"host\":{\"cpu\":[$(awk '/^cpu /{print $2","$3","$4","$5","$6","$7","$8","$9; exit}' /proc/stat)]"
    line+=",\"memAvailKb\":$(awk '/^MemAvailable/{print $2}' /proc/meminfo)}}"
    printf '%s\n' "$line" >> "$out/cpu.jsonl"
    sleep 1
  done
}
# The link gateway's /metrics once a second, reduced to the series this probe reads. A scrape that fails (the process is
# gone) is recorded as "up":0, so the outage is in the series too.
sample_metrics() {
  local body t
  while :; do
    t="$(now_ms)"
    if body="$(curl -fsS --max-time 2 "$metrics" 2>/dev/null)"; then
      printf '%s\n' "$body" | awk -v t="$t" 'NF == 2 && $1 ~ /^link_(connections|draining|watched_sessions|ingest_queue_events|gateway_start_time_seconds)$/ || $1 ~ /^link_(handshakes_total|welcome_lookups_total|backend_calls_total|backend_retries_total|disconnects_total|token_refusals_total|event_batches_total|heartbeat_forwards_total)\{/ || $1 ~ /^link_drains_sent_total/ || $1 ~ /^link_handshake_duration_seconds/ { k = $1; gsub(/"/, "\\\"", k); s = s sep "\"" k "\":" $2; sep = "," } END { print "{\"t\":" t ",\"up\":1" (s == "" ? "" : "," s) "}" }' >> "$out/metrics.jsonl"
    else
      printf '{"t":%s,"up":0}\n' "$t" >> "$out/metrics.jsonl"
    fi
    sleep 1
  done
}
sample_cpu & cpu_pid=$!
sample_metrics & metrics_pid=$!
trap 'kill $cpu_pid $metrics_pid 2>/dev/null || true' EXIT

note "sampling; holding $before_window s of baseline before the kill"
sleep "$before_window"

# --- The kill. --------------------------------------------------------------------------------------------------------
old_pid="$(docker inspect -f '{{.State.Pid}}' "$gw")"
kill_ms="$(now_ms)"
note "docker kill -s $signal (old pid $old_pid)"
docker kill -s "$signal" "$gw"
printf '%s\n' "$kill_ms" > "$out/kill-ms"

# The old process's exit, and who starts the new one. docker's own event stream is the record of both.
docker events --since "$((kill_ms / 1000))" --filter "container=$gw" --format '{{json .}}' > "$out/docker-events.jsonl" 2>/dev/null &
events_pid=$!
trap 'kill $cpu_pid $metrics_pid $events_pid 2>/dev/null || true' EXIT

# The old process's exit. A SIGTERM drains first: Drain frames at LINK_DRAIN_BATCH a second, then the rest are closed at
# LINK_DRAIN_TIMEOUT (80 s), so the container keeps running that long. Wait for the old pid itself to be gone, not for
# the container to look stopped, or a drain that is still going would be taken for the restarted process.
exited_ms=""
for _ in $(seq 1 $(( exit_wait * 4 ))); do
  if [ "$(docker inspect -f '{{.State.Running}}' "$gw")" != true ] || [ "$(docker inspect -f '{{.State.Pid}}' "$gw")" != "$old_pid" ]; then
    exited_ms="$(now_ms)"; break
  fi
  sleep 0.25
done
if [ -n "$exited_ms" ]; then
  note "the old process is gone after $(( exited_ms - kill_ms )) ms"
else
  note "the old process is still running $exit_wait s after the kill: giving up"
  die "the gateway did not exit within $exit_wait s of SIGTERM"
fi

# Docker 29.9.2 does not apply the restart policy to an API kill; wait, then start it.
started_by="restart policy"
for _ in $(seq 1 $(( restart_after * 4 ))); do
  [ "$(docker inspect -f '{{.State.Running}}' "$gw")" = true ] && break
  sleep 0.25
done
if [ "$(docker inspect -f '{{.State.Running}}' "$gw")" != true ]; then
  started_by="docker start"
  note "the restart policy did not bring it back within $restart_after s: docker start"
  docker start "$gw" > /dev/null
fi
running_ms="$(now_ms)"
new_pid="$(docker inspect -f '{{.State.Pid}}' "$gw")"
note "the container runs again after $(( running_ms - kill_ms )) ms, started by $started_by (new pid $new_pid)"

# --- The reconnect. ---------------------------------------------------------------------------------------------------
# Milestones from the gateway's own link_connections, read from the series this probe is already writing.
connections_now() { curl -fsS --max-time 2 "$metrics" 2>/dev/null | awk '/^link_connections /{print $2; exit}'; }
declare -A milestone=()
deadline=$(( $(date +%s) + give_up ))
whole_ms=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  n="$(connections_now || true)"
  [ -n "${n:-}" ] || { sleep 1; continue; }
  n="${n%%.*}"
  for pct in 50 90 99; do
    if [ -z "${milestone[$pct]:-}" ] && [ "$n" -ge $(( expect_connections * pct / 100 )) ]; then
      milestone[$pct]="$(now_ms)"
      note "$pct% back ($n connections) after $(( milestone[$pct] - kill_ms )) ms"
    fi
  done
  if [ "$n" -ge "$expect_connections" ]; then whole_ms="$(now_ms)"; note "the fleet is whole ($n) after $(( whole_ms - kill_ms )) ms"; break; fi
  sleep 1
done
[ -n "$whole_ms" ] || note "the fleet did not reach $expect_connections within $give_up s (last $n)"

note "holding $settle_after s with the fleet back, then the after snapshots"
sleep "$settle_after"

# --- After. -----------------------------------------------------------------------------------------------------------
psql_at -c "$welcome_pgss" > "$out/pgss-welcome-after.json"
psql_at -c "$db_exec_totals" > "$out/pgss-totals-after.json"
psql_at -c "WITH running AS (
    SELECT s.id FROM \"session\" s
    WHERE s.\"kind\" = 'CONVERSATION' AND s.\"inbox_lease_owner\" IS NOT NULL
      AND s.\"status\" IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED') AND s.\"assigned_runner_id\" IS NOT NULL),
  depth AS (SELECT r.id, (SELECT count(*) FROM \"run_event\" e WHERE e.\"session_id\" = r.id AND e.\"seq\" > 0) AS n FROM running r)
  SELECT json_build_object('sessions', count(*), 'events', coalesce(sum(n), 0), 'mean', round(avg(n), 1),
    'min', min(n), 'max', max(n)) FROM depth" > "$out/depth-after.json"

kill $cpu_pid $metrics_pid $events_pid 2>/dev/null || true
sleep 0.5

# The reaper over the window: the sessions it failed, and the mass-silence hold that stopped it (task C2b's reaper fix).
# Each apiserver is read apart: the first run found one process reaping while the other three held.
: > "$out/reaper.log"
for svc in apiserver apiserver-b apiserver-c apiserver-d; do
  docker logs --since "$(date -u -d "@$(( kill_ms / 1000 - 10 ))" +%Y-%m-%dT%H:%M:%S)" "$project-$svc" 2>&1 \
    | grep -iE "reap|not reaping|mass|silen" | sed "s/^/$svc /" >> "$out/reaper.log" || true
done
# The reaper's own lines (src/apiserver/src/realtime/reaper.service.ts): "reaped session <id> -> <status> (<reason>)"
# for each session it ends, "not reaping <n> session(s) whose runner looks offline" when the mass-silence hold keeps
# them, and "a mass disconnection[ widened]: ..." when it records the hold.
jq -Rn --rawfile log "$out/reaper.log" '
  ($log | split("\n") | map(select(length > 0))) as $l
  | def per(re): [$l[] | select(test(re)) | split(" ")[0]] | group_by(.) | map({key: .[0], value: length}) | from_entries;
  {
    reapedSessions: ([$l[] | select(test("reaped session "))] | length),
    reapedByApiserver: per("reaped session "),
    notReapingLines: ([$l[] | select(test("not reaping "))] | length),
    notReapingSessions: ([$l[] | select(test("not reaping [0-9]+ session")) | capture("not reaping (?<n>[0-9]+) session").n | tonumber] | add // 0),
    notReapingByApiserver: per("not reaping "),
    massDisconnectLines: ([$l[] | select(test("a mass disconnection( widened)?: [0-9]+ of the"))] | length),
    massDisconnectByApiserver: per("a mass disconnection( widened)?: [0-9]+ of the")
  }' > "$out/reaped.json" 2>/dev/null || echo '{}' > "$out/reaped.json"

# The web gateway's link-token responses over the window: a Drain makes every runner mint a new token.
docker logs --since "$(date -u -d "@$(( kill_ms / 1000 - 10 ))" +%Y-%m-%dT%H:%M:%S)" "$project-gateway" 2>&1 \
  | grep -o '"POST /api/runner/link-token[^"]*" [0-9]\{3\}' | awk '{print $NF}' | sort | uniq -c \
  | awk '{printf "%s{\"status\":\"%s\",\"count\":%s}", sep, $2, $1; sep=","} END {printf "\n"}' \
  | sed 's/^/[/; s/$/]/' > "$out/web-link-token.json" || echo '[]' > "$out/web-link-token.json"

note "probe finished"
printf '{"signal":"%s","killMs":%s,"exitedMs":%s,"runningMs":%s,"startedBy":"%s","oldPid":%s,"newPid":%s,"wholeMs":%s,"milestones":{%s},"expectConnections":%s}\n' \
  "$signal" "$kill_ms" "${exited_ms:-null}" "$running_ms" "$started_by" "$old_pid" "$new_pid" "${whole_ms:-null}" \
  "$(for pct in 50 90 99; do printf '%s"p%s":%s' "${sep:-}" "$pct" "${milestone[$pct]:-null}"; sep=","; done)" \
  "$expect_connections" > "$out/probe.json"
jq . "$out/probe.json" > /dev/null || die "probe.json is not JSON"
log "probe written to $out"
