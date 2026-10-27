#!/usr/bin/env bash
# Durable events through the faults of docs/runner-link-design.md §10 (task C1a), drilled on a staging stack with a real
# runner in link mode, in the order §11.1 lists them: the link gateway killed, the apiserver killed, the database failed
# over, the network cut. One session streams output across all of them: its engine, the test suite's scripted claude
# (src/runner-go/fake_claude_test.go), writes a tick every ORBIT_DURABLE_EVENTS_TICK seconds, each a progress ping, a
# reply delta and an assistant message. What must hold after each fault, and over the whole session once its turn ends:
# its run_event seqs run from 1 without a hole, every tick is stored once, and the runner logs no dropped events. A
# refused event's tombstone holds its seq (task B5); over the link a progress ping and a delta take no durable seq at all
# (task B8), so neither leaves a hole, and neither may be stored.
#
#   durable-events-drill.sh prepare        The stack in the cut-over state, built from this checkout: the link gateway
#                                          following the server's switch and RUNNER_LINK_REQUIRED on, so the runner's
#                                          daemon calls go over the link alone and HTTPS refuses them. The runner and
#                                          the scripted claude built from this checkout; the runner registered and
#                                          started as a systemd unit of its own, on the link.
#   durable-events-drill.sh stream         Opens the session whose prompt streams ticks until finish.
#   durable-events-drill.sh gateway        Kills the link gateway for ORBIT_DURABLE_EVENTS_GATEWAY_SECONDS.
#   durable-events-drill.sh apiserver      Kills the apiserver for ORBIT_DURABLE_EVENTS_APISERVER_SECONDS.
#   durable-events-drill.sh database       Fails the database over to a standby streaming from it synchronously: the
#                                          primary killed, the standby promoted ORBIT_DURABLE_EVENTS_DATABASE_SECONDS
#                                          later and given the primary's name in the stack's network. Then switches back
#                                          into the stack's own container, a second, planned outage.
#   durable-events-drill.sh partition      Cuts the runner off the network for ORBIT_DURABLE_EVENTS_PARTITION_SECONDS: an
#                                          nftables rule drops every packet its unit's processes send.
#   durable-events-drill.sh finish         Releases the stream's last ticks, waits for its turn to end, and judges the
#                                          session whole.
#   durable-events-drill.sh rollback       A second session streams and the link gateway is killed; the runner is stopped
#                                          as a service manager stops it, with events not acknowledged; then
#                                          RUNNER_LINK_REQUIRED goes off and the runner starts again with
#                                          ORBIT_LINK_MODE=off, as a rollback does, and answers a message; then the
#                                          switch goes on and the runner takes the session back on the link. Records what
#                                          the session stored of what its engine wrote, after each step.
#   durable-events-drill.sh partition-off  The partition with RUNNER_LINK_REQUIRED off and the gateway telling the runner
#                                          MODE_LINK (ORBIT_LINK_STAGING_MODE=link), on a session of its own: past 5
#                                          minutes without the link the runner takes its work back to HTTPS. Not in all.
#   durable-events-drill.sh all            prepare, stream, gateway, apiserver, database, partition, finish, rollback.
#   durable-events-drill.sh report         Prints the records' summary.
#   durable-events-drill.sh stop           Stops the drill runner and the ticker, and undoes what a drill that died left.
#
# Settings, besides the staging stack's own (staging-lib.sh, staging-up.sh):
#   ORBIT_DURABLE_EVENTS_TICK               seconds from one tick to the next                               2
#   ORBIT_DURABLE_EVENTS_GATEWAY_SECONDS    how long the link gateway is down                               60
#   ORBIT_DURABLE_EVENTS_APISERVER_SECONDS  how long the apiserver is down                                  60
#   ORBIT_DURABLE_EVENTS_DATABASE_SECONDS   from the primary's death to the standby's promotion             20
#   ORBIT_DURABLE_EVENTS_PARTITION_SECONDS  how long the runner is cut off                                  600
#   ORBIT_DURABLE_EVENTS_CATCHUP            how long the stored ticks may take to catch up with the engine
#                                           once a fault ends                                               300
#
# Run it as root on a stack no other runner works on: the runner runs in a mount namespace of its own (as
# lost-answer-drill.sh's does) and in a systemd unit of its own, whose cgroup the partition's nftables rule matches. It
# needs docker, systemd, nft, jq, node, go and curl. The records go to <state>/client/durable-events/: timeline.txt is the
# drill's account, phases.tsv has a line per fault and one for the whole session, rollback.tsv a line per step of the
# rollback, and summary.txt the judgement; each phase leaves its samples, the ticks' release times and the runner's, the
# link gateway's and the apiserver's logs over it. The runner, its log, its spool and the scripted claude's records are
# in <state>/durable-events/; the runner keeps running after the drill until `durable-events-drill.sh stop`. Setting up
# exits non-zero at the first step that does not hold; a fault is judged whole, and all runs every phase before it exits
# non-zero for any.
set -euo pipefail
# shellcheck source=../staging-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../staging-lib.sh"

helper="$here/drills/rollback-drill.mjs"
out="$state/client/durable-events"
drill="$state/durable-events"
timeline="$out/timeline.txt"
table="$out/phases.tsv"
rollback_table="$out/rollback.tsv"
summary_file="$out/summary.txt"
unit="$project-durable-events.service"
ticker="$project-durable-events-ticker.service"
gateway="$project-link-gateway"
apiserver="$project-apiserver"
primary="$project-postgres"
standby="$project-postgres-standby"
standby_dir="$state/postgres-standby"
nft_table="${project//-/_}_durable_events"
tick="${ORBIT_DURABLE_EVENTS_TICK:-2}"
gateway_seconds="${ORBIT_DURABLE_EVENTS_GATEWAY_SECONDS:-60}"
apiserver_seconds="${ORBIT_DURABLE_EVENTS_APISERVER_SECONDS:-60}"
database_seconds="${ORBIT_DURABLE_EVENTS_DATABASE_SECONDS:-20}"
partition_seconds="${ORBIT_DURABLE_EVENTS_PARTITION_SECONDS:-600}"
catchup="${ORBIT_DURABLE_EVENTS_CATCHUP:-300}"
whole() { [[ "$2" =~ ^[1-9][0-9]*$ ]] || die "$1 must be a positive whole number of seconds, not $2"; }
whole ORBIT_DURABLE_EVENTS_TICK "$tick"
whole ORBIT_DURABLE_EVENTS_GATEWAY_SECONDS "$gateway_seconds"
whole ORBIT_DURABLE_EVENTS_APISERVER_SECONDS "$apiserver_seconds"
whole ORBIT_DURABLE_EVENTS_DATABASE_SECONDS "$database_seconds"
whole ORBIT_DURABLE_EVENTS_PARTITION_SECONDS "$partition_seconds"
whole ORBIT_DURABLE_EVENTS_CATCHUP "$catchup"
# How many ticks each session's prompt streams. The stream's last through every fault, each one's catch-up and the time
# between them; finish releases what is left at once. The rollback's stream is cut short by the runner's stop.
stream_ticks=$(((gateway_seconds + apiserver_seconds + database_seconds + partition_seconds + 4 * catchup + 600) / tick))
rollback_ticks=60
off_ticks=$(((partition_seconds + 2 * catchup + 300) / tick))
# What the runner logs when it loses events: an HTTPS batch dropped after the server refused it (session.go), and the
# link's own losses: a stream given up, events not sent or not kept, the spool losing what it held (link_events.go,
# link_events_spool.go).
drop_re='dropping [0-9]+ events'
loss_re='held events are not sent|are given up|they are not sent|they are not kept|could not be kept|lost so far'

now() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
say() { echo "$(now) $*" | tee -a "$timeline" >&2; }
fail() { say "FAIL: $*"; die "$* (records in $out)"; }
json() { node -pe "const v = JSON.parse(process.argv[1]).$2; typeof v === 'object' ? JSON.stringify(v) : String(v)" "$1"; }
epoch() { date -u -d "$1" +%s.%N; }
# seconds FROM TO: from one time to another, in seconds to the tenth.
seconds() { awk -v a="$(epoch "$1")" -v b="$(epoch "$2")" 'BEGIN { printf "%.1f", b - a }'; }
# wait_until SECONDS COMMAND...: COMMAND holds within SECONDS (tried every half second); non-zero otherwise.
wait_until() {
  local deadline=$((SECONDS + $1))
  shift
  until "$@"; do
    [ $SECONDS -lt $deadline ] || return 1
    sleep 0.5
  done
}

# --- The stack. -------------------------------------------------------------------------------------------------------
stack_settings() {
  [ -f "$env_file" ] || fail "no staging stack in $state: run prepare"
  origin="http://$(setting STAGING_BIND 127.0.0.1):$(setting STAGING_HTTP_PORT 18086)"
}
api() { node "$helper" "$origin" "$state" "$@"; }
switch_is() { [ "$(json "$(api switch get)" required)" = "$1" ]; }
# The database's primary: the stack's own container, but for the standby while the database phase has it promoted.
db() { cat "$drill/primary" 2>/dev/null || echo "$primary"; }
psql_value() { docker exec "$(db)" psql -U orbit -d orbit -tAc "$1"; }
psql_rows() { docker exec "$(db)" psql -U orbit -d orbit -tA -F $'\t' -c "$1"; }
health() { docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1"; }
# start_container NAME SECONDS: the container started again, and healthy (or running, without a health check). A
# `docker kill` is a stop to Docker, so its restart policy leaves it down until then.
start_container() {
  local deadline=$((SECONDS + $2)) h
  docker start "$1" > /dev/null
  while :; do
    h="$(health "$1")"
    case "$h" in healthy|running) return 0 ;; esac
    [ $SECONDS -lt $deadline ] || fail "$1 is $h $2 s after it was started again"
    sleep 1
  done
}
# kill_container NAME: the container killed, as a crash or a lost host ends it; noted, so that a drill that dies before
# it is started again leaves it started (restore_faults).
kill_container() { echo "$1" > "$drill/down"; docker kill "$1" > /dev/null; }
started_again() { start_container "$1" 300; rm -f "$drill/down"; }

# --- The runner. ------------------------------------------------------------------------------------------------------
account_home="$(getent passwd "$(id -u)" | cut -d: -f6)"
runner_id() { node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).runnerId' "$drill/orbit/config.json"; }
workspace_id() { json "$(cat "$drill/workspace.json")" id; }
# runner_cmd [NAME=VALUE...]: the drill runner's binary as the array RUNNER, with NAME=VALUE... in its environment: an
# environment of its own, kept on this checkout's build (ORBIT_NO_SELFUPDATE), in a mount namespace in which the engine
# installers' directories under this account's home show the scripted claude alone (lost-answer-drill.sh says why).
# Every step execs the next, so the command's pid is the runner's: its unit's main process.
runner_cmd() {
  RUNNER=(/usr/bin/unshare -m --propagation private -- /bin/sh -c '
    drill=$1 home=$2
    shift 2
    if [ -d "$home/.local/bin" ]; then mount --bind "$drill/fakebin" "$home/.local/bin" || exit 1; fi
    for dir in .kimi-code/bin .opencode/bin; do
      if [ -d "$home/$dir" ]; then mount --bind "$drill/empty" "$home/$dir" || exit 1; fi
    done
    exec "$@"' sh "$drill" "$account_home"
    /usr/bin/env -i HOME="$drill/home" ORBIT_HOME="$drill/orbit" USER="$(id -un)" LOGNAME="$(id -un)"
    PATH="$drill/fakebin:/usr/sbin:/usr/bin:/sbin:/bin" SSL_CERT_FILE="$state/tls/ca-bundle.pem"
    ORBIT_NO_SELFUPDATE=1 ORBIT_NO_ENGINE_UPDATE=1 TMPDIR="$drill/tmp" "$@" "$drill/bin/orbit")
}
# start_runner [NAME=VALUE...]: the drill runner as the systemd unit $unit, whose cgroup the partition cuts off. Stopping
# it is what a service manager does: SIGTERM to the runner, which drains its sessions and stops, and SIGKILL to what is
# left of it after 300 s.
start_runner() {
  runner_cmd "$@"
  touch "$drill/runner.log"
  systemd-run --unit "$unit" --collect --quiet -p KillMode=mixed -p TimeoutStopSec=300 \
    -p StandardOutput="append:$drill/runner.log" -p StandardError="append:$drill/runner.log" -- "${RUNNER[@]}" run
}
runner_running() { systemctl is-active --quiet "$unit"; }
runner_pid() { systemctl show -p MainPID --value "$unit"; }
stop_runner() {
  runner_running || return 0
  local pid
  pid="$(runner_pid)"
  systemctl stop "$unit" || true
  say "drill runner stopped (pid $pid)"
}
# presence: the runner's presence row, as "link_state process_id last_beat_at".
presence() {
  psql_value "SELECT link_state || ' ' || COALESCE(process_id::text, 'none') || ' ' ||
    to_char(last_beat_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') FROM runner_presence WHERE runner_id = '$(runner_id)'"
}
# wait_presence STATE SECONDS: the runner's last beat came over STATE (HTTP or LINK); non-zero when not within SECONDS.
wait_presence() {
  local deadline=$((SECONDS + $2))
  until [ "$(presence 2>/dev/null | cut -d' ' -f1)" = "$1" ]; do
    [ $SECONDS -lt $deadline ] || return 1
    runner_running || return 1
    sleep 1
  done
}
presence_heard() { [ -n "$(presence 2> /dev/null | cut -d' ' -f2)" ]; }
log_lines() { if [ -f "$drill/runner.log" ]; then wc -l < "$drill/runner.log"; else echo 0; fi; }
# log_since FROM PATTERN: the runner log's lines after line FROM that hold PATTERN, as a fixed string.
log_since() { awk -v from="$1" -v p="$2" 'NR > from && index($0, p)' "$drill/runner.log"; }
# log_since_re FROM REGEX: the same, matching an extended regular expression.
log_since_re() { awk -v from="$1" -v re="$2" 'NR > from && $0 ~ re' "$drill/runner.log"; }
# wait_log FROM PATTERN SECONDS: a line holding PATTERN after line FROM of the runner's log, within SECONDS.
wait_log() {
  local deadline=$((SECONDS + $3))
  until [ -n "$(log_since "$1" "$2" | head -n 1)" ]; do
    [ $SECONDS -lt $deadline ] || fail "no \"$2\" in the runner log within $3 s"
    sleep 0.5
  done
}

# --- Sessions and their ticks. ----------------------------------------------------------------------------------------
# write_script LABEL RUN TICKS KIND: the scripted claude's script for the next session's engine. Its prompt streams TICKS
# ticks, tick K once the drill releases LABEL-RUN-K (fake_claude_test.go, `await: release`), and ends with a result;
# every message after it is answered at once. KIND full makes each tick a progress ping (system/status, which nothing
# stores), a reply delta (live only) and an assistant message; durable makes it the assistant message alone, for a
# stream part of which may go over HTTPS, where the ping and the delta take a seq each and leave a hole by design. An
# engine reads its script when it starts, so the sessions opened before keep theirs.
write_script() {
  node -e '
    const [file, label, run, ticks, kind] = process.argv.slice(1);
    const answered = (text) => [{ emit: "assistant", text }, { emit: "result", text }];
    const steps = [{ await: "user" }, { emit: "replay_user" }, { emit: "system_init", version: "2.1.300" }];
    for (let k = 1; k <= Number(ticks); k += 1) {
      steps.push({ await: "release", text: `${label}-${run}-${k}` });
      if (kind === "full") {
        steps.push({ emit: "system_status" }, { emit: "text_delta", text: `Durable events drill, ${label}: tick ${k}` });
      }
      steps.push({ emit: "assistant", text: `Durable events drill, ${label}: tick ${k}.` });
    }
    steps.push({ emit: "result", text: `Durable events drill, ${label}: the stream is answered.` });
    for (let n = 2; n <= 30; n += 1) {
      steps.push({ await: "user" }, { emit: "replay_user" }, ...answered(`Durable events drill, ${label}: message ${n} is answered.`));
    }
    require("fs").writeFileSync(file, JSON.stringify(steps));' "$drill/fake/script.json" "$@"
}
# write_resume_script LABEL: what an engine the runner resumes (--resume) answers: every message at once, with an
# assistant message and a result.
write_resume_script() {
  node -e '
    const [file, label] = process.argv.slice(1);
    const steps = [];
    for (let n = 1; n <= 30; n += 1) {
      const text = `Durable events drill, ${label}: message ${n} of the resumed engine is answered.`;
      steps.push({ await: "user" }, { emit: "replay_user" });
      if (n === 1) steps.push({ emit: "system_init", version: "2.1.300" });
      steps.push({ emit: "assistant", text }, { emit: "result", text });
    }
    require("fs").writeFileSync(file, JSON.stringify(steps));' "$drill/fake/script-resume.json" "$1"
}
# open_session LABEL TICKS KIND PROMPT: a session whose prompt streams TICKS ticks of KIND (write_script), recorded in
# <drill>/LABEL.session as "ID UUID RUN TICKS" and loaded (load_session). The prompt ends with the session's marker
# (prompt_marker), which no other session's prompt holds.
open_session() {
  local created="" stamp _
  stamp="$(date -u +%H%M%S)"
  write_script "$1" "$stamp" "$2" "$3"
  for _ in $(seq 1 12); do
    created="$(api session "$(workspace_id)" "$4 [$1 run $stamp]" 2>>"$out/api-errors.log")" && break
    sleep 5
  done
  [ -n "$created" ] || fail "$1: the session could not be created (see $out/api-errors.log)"
  echo "$(json "$created" id) $(json "$created" uuid) $stamp $2" > "$drill/$1.session"
  : > "$out/$1-ticks.tsv"
  load_session "$1"
}
# load_session LABEL: the session LABEL as label, sid, suuid, run and ticks_total.
load_session() {
  [ -f "$drill/$1.session" ] || fail "no $1 session in $drill: run ${2:-$1}"
  label=$1
  read -r sid suuid run ticks_total < "$drill/$1.session"
}
session_status() { psql_value "SELECT status FROM session WHERE id = '$suuid'"; }
prompt_marker() { echo "[$label run $run]"; }
# start_ticker FROM: the loaded session's ticks from FROM on, released every ORBIT_DURABLE_EVENTS_TICK seconds by a
# systemd unit of its own, so that the stream goes on between phases run one at a time and whatever a fault does to the
# drill's own process. Each release is logged in <label>-ticks.tsv with its time.
start_ticker() {
  stop_ticker
  systemd-run --unit "$ticker" --collect --quiet -- /bin/bash -c '
    dir=$1 name=$2 from=$3 to=$4 every=$5 log=$6
    for ((k = from; k <= to; k++)); do
      : > "$dir/release-$name-$k"
      printf "%s\t%s\n" "$k" "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" >> "$log"
      sleep "$every"
    done' ticker "$drill/fake" "$label-$run" "$1" "$ticks_total" "$tick" "$out/$label-ticks.tsv"
}
stop_ticker() { systemctl stop "$ticker" 2> /dev/null || true; }
ticker_running() { systemctl is-active --quiet "$ticker"; }
# released: the last tick of the loaded session released.
released() { tail -n 1 "$out/$label-ticks.tsv" 2> /dev/null | cut -f1 | grep -E '^[0-9]+$' || echo 0; }
# release_rest: the rest of the loaded session's ticks released at once: its engine writes them and ends its turn.
release_rest() {
  local k
  stop_ticker
  for ((k = $(released) + 1; k <= ticks_total; k++)); do
    : > "$drill/fake/release-$label-$run-$k"
    printf '%s\t%s\n' "$k" "$(now)" >> "$out/$label-ticks.tsv"
  done
}
# ticks_query: the loaded session's stored ticks: tick (k), seq, created_at (the runner's time) and ingested_at.
ticks_query() {
  echo "SELECT substring(payload->>'text' FROM '^Durable events drill, $label: tick ([0-9]+)\\.\$')::int AS k, seq,
      created_at, ingested_at
    FROM run_event WHERE session_id = '$suuid' AND type = 'assistant'"
}
# stored_ticks: the loaded session's stored ticks as "ROWS DISTINCT LAST".
stored_ticks() {
  psql_value "SELECT count(*) || ' ' || count(DISTINCT k) || ' ' || COALESCE(max(k), 0) FROM ($(ticks_query)) t WHERE k IS NOT NULL"
}
stored_last() { local t; t="$(stored_ticks 2> /dev/null)" || t="0 0 0"; echo "${t##* }"; }
caught_up() { [ "$(stored_last)" -ge "$1" ] 2> /dev/null; }
# ranges_sql QUERY: QUERY's whole numbers (a column g) as ranges, "3-5,9", or nothing.
ranges_sql() {
  echo "SELECT COALESCE(string_agg(CASE WHEN lo = hi THEN lo::text ELSE lo || '-' || hi END, ',' ORDER BY lo), '')
    FROM (SELECT min(g) AS lo, max(g) AS hi FROM (SELECT g, g - row_number() OVER (ORDER BY g) AS grp FROM ($1) q) n
          GROUP BY grp) r"
}
# missing_ticks TO: the ticks 1..TO the loaded session has not stored, as ranges.
missing_ticks() {
  psql_value "$(ranges_sql "SELECT g FROM generate_series(1, $1) g
    WHERE g NOT IN (SELECT k FROM ($(ticks_query)) t WHERE k IS NOT NULL)")"
}
# holes: the seqs below the loaded session's last stored one that no row holds, as ranges.
holes() {
  psql_value "$(ranges_sql "SELECT g FROM generate_series(1, (SELECT COALESCE(max(seq), 0) FROM run_event
      WHERE session_id = '$suuid')) g
    WHERE g NOT IN (SELECT seq FROM run_event WHERE session_id = '$suuid')")"
}
# seqs: the loaded session's run_event as "ROWS FIRST LAST TOMBSTONES".
seqs() {
  psql_value "SELECT count(*) || ' ' || COALESCE(min(seq), 0) || ' ' || COALESCE(max(seq), 0) || ' ' ||
    count(*) FILTER (WHERE type = 'tombstone') FROM run_event WHERE session_id = '$suuid'"
}
# live_rows: the loaded session's rows that are a progress ping or a live event, of which none may be stored.
live_rows() {
  psql_value "SELECT count(*) FROM run_event WHERE session_id = '$suuid' AND (type IN ('text_delta', 'thinking_delta',
    'tool_output', 'background_output', 'task_progress') OR (type = 'system' AND payload->>'subtype' = 'status'))"
}
# tick_lags FROM TO: for the stored ticks FROM..TO, "N READ STORED_FIRST STORED_LAST": how many there are, the longest
# the runner took to record one after its release (created_at is the runner's time), and the shortest and longest from
# its release to its row (ingested_at, the database's), in seconds.
tick_lags() {
  psql_rows "SELECT k, extract(epoch FROM created_at), extract(epoch FROM ingested_at) FROM ($(ticks_query)) t
      WHERE k BETWEEN $1 AND $2" |
    node -e '
      const fs = require("fs");
      const released = new Map(fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean)
        .map((line) => { const [k, at] = line.split("\t"); return [Number(k), Date.parse(at) / 1000]; }));
      let n = 0, read = -Infinity, first = Infinity, last = -Infinity;
      for (const line of fs.readFileSync(0, "utf8").split("\n").filter(Boolean)) {
        const [k, created, ingested] = line.split("\t").map(Number);
        const at = released.get(k);
        if (at === undefined) continue;
        n += 1;
        read = Math.max(read, created - at);
        first = Math.min(first, ingested - at);
        last = Math.max(last, ingested - at);
      }
      console.log(n ? `${n} ${read.toFixed(1)} ${first.toFixed(1)} ${last.toFixed(1)}` : "0 - - -");' "$out/$label-ticks.tsv"
}
# deliveries MARKER: how many user messages holding MARKER reached the scripted claude's stdin.
deliveries() {
  awk -v marker="$1" 'index($0, "\"type\":\"user\"") && index($0, marker) { n++ } END { print n + 0 }' "$drill/fake/stdin.jsonl"
}
# engine_starts RUNTIME_SESSION_ID: how many times a session's engine was started, its conversation opened or resumed
# under that id (spawns.jsonl).
engine_starts() { if [ -f "$drill/fake/spawns.jsonl" ]; then grep -c -- "$1" "$drill/fake/spawns.jsonl" || true; else echo 0; fi; }
answered_with() {
  [ "$(psql_value "SELECT count(*) FROM conversation_turn WHERE session_id = '$suuid' AND kind = 'message'
    AND status = 'ANSWERED' AND content LIKE '%$1%'")" -ge 1 ] 2> /dev/null
}

# --- The faults. ------------------------------------------------------------------------------------------------------
# cut_off: every packet the runner unit's processes send is dropped, whatever it is for: the link, HTTPS, anything. What
# reaches them still arrives, and their answers do not leave.
cut_off() {
  local cg level
  cg="$(systemctl show -p ControlGroup --value "$unit")"
  cg="${cg#/}"
  level="$(awk -F/ '{ print NF }' <<< "$cg")"
  nft add table inet "$nft_table"
  nft add chain inet "$nft_table" out '{ type filter hook output priority 0; policy accept; }'
  nft add rule inet "$nft_table" out socket cgroupv2 level "$level" "\"$cg\"" counter drop
}
reconnect() { nft delete table inet "$nft_table" 2> /dev/null || true; }

# The database's failover. The standby is the primary's container in all but its data directory: the same image,
# entrypoint, command (its WAL archive included), environment and shared memory, in the stack's network as
# postgres-standby. It streams from the primary through the primary's unix socket (the volume pgbackup shares), which
# pg_hba trusts for replication, and the primary waits for it at every commit (synchronous_standby_names): a failover
# loses nothing the primary acknowledged only then, and the runner drops the events whose acknowledgement says they are
# stored. <drill>/database says how far it went, for restore_database.
start_standby() {
  local image net socket owner shm entry=() cmd=() args=() line
  image="$(docker inspect -f '{{.Config.Image}}' "$primary")"
  net="$(docker inspect -f '{{json .NetworkSettings.Networks}}' "$primary" | jq -r 'keys[0]')"
  socket="$(docker inspect -f '{{json .Mounts}}' "$primary" | jq -r '.[] | select(.Destination == "/var/run/postgresql") | .Name')"
  shm="$(docker inspect -f '{{.HostConfig.ShmSize}}' "$primary")"
  owner="$(docker run --rm --entrypoint sh "$image" -c 'echo "$(id -u postgres):$(id -g postgres)"')"
  mapfile -t entry < <(docker inspect -f '{{json .Config.Entrypoint}}' "$primary" | jq -r '.[]')
  mapfile -t cmd < <(docker inspect -f '{{json .Config.Cmd}}' "$primary" | jq -r '.[]')
  while IFS= read -r line; do args+=(-e "$line"); done < <(docker inspect -f '{{json .Config.Env}}' "$primary" | jq -r '.[]')
  while IFS= read -r line; do args+=(-v "$line"); done < <(docker inspect -f '{{json .Mounts}}' "$primary" |
    jq -r '.[] | select(.Type == "bind" and .Destination != "/var/lib/postgresql/data")
      | "\(.Source):\(.Destination)\(if .RW then "" else ":ro" end)"')
  docker rm -f "$standby" > /dev/null 2>&1 || true
  rm -rf "$standby_dir"
  mkdir -m 700 "$standby_dir"
  chown "$owner" "$standby_dir"
  docker run --rm --user "$owner" -v "$socket:/primary-socket" -v "$standby_dir:/standby" --entrypoint pg_basebackup \
    "$image" -h /primary-socket -U orbit -D /standby -X stream -R -c fast > "$out/database-basebackup.log" 2>&1 ||
    fail "database: the standby's base backup (see $out/database-basebackup.log)"
  echo standby > "$drill/database"
  docker run -d --name "$standby" --network "$net" --network-alias postgres-standby --shm-size "$shm" \
    -v "$standby_dir:/var/lib/postgresql/data" -v "$socket:/primary-socket" "${args[@]}" \
    --entrypoint "${entry[0]}" "$image" "${entry[@]:1}" "${cmd[@]}" > /dev/null
  wait_until 120 replicating streaming || fail "database: the standby is not streaming from the primary within 120 s"
  docker exec "$primary" psql -U orbit -d orbit -tAc "ALTER SYSTEM SET synchronous_standby_names = '*'" > /dev/null
  docker exec "$primary" psql -U orbit -d orbit -tAc "SELECT pg_reload_conf()" > /dev/null
  wait_until 60 replicating sync || fail "database: the standby is not synchronous within 60 s"
  standby_net="$net"
}
# replicating WHAT: the primary's one replica is streaming (WHAT streaming), or synchronous (WHAT sync).
replicating() {
  local column=state
  [ "$1" = sync ] && column=sync_state
  [ "$(docker exec "$primary" psql -U orbit -d orbit -tAc "SELECT string_agg($column, ',') FROM pg_stat_replication" 2> /dev/null)" = "$1" ]
}
# promote_standby: the standby promoted, and named postgres in the stack's network in the dead primary's place.
promote_standby() {
  docker exec -u postgres "$standby" pg_ctl promote -w -D /var/lib/postgresql/data > "$out/database-promote.log" 2>&1 ||
    fail "database: promoting the standby (see $out/database-promote.log)"
  echo "$standby" > "$drill/primary"
  echo promoted > "$drill/database"
  promoted_presence="$(psql_value "SELECT count(*) FROM runner_presence")"
  docker network disconnect "$standby_net" "$standby"
  docker network connect --alias postgres --alias postgres-standby "$standby_net" "$standby"
}
# switch_back: the promoted standby's data back in the stack's own container, which starts on it: the standby stopped
# cleanly (its image's stop signal is a fast shutdown), the data directories swapped, the primary's old one removed once
# the stack's container is up.
switch_back() {
  docker stop -t 120 "$standby" > /dev/null
  echo stopped > "$drill/database"
  rm -rf "$state/postgres-before-failover"
  mv "$state/postgres" "$state/postgres-before-failover"
  mv "$standby_dir" "$state/postgres"
  docker rm "$standby" > /dev/null
  rm -f "$drill/primary"
  start_container "$primary" 300
  rm -f "$drill/database"
  rm -rf "$state/postgres-before-failover"
}
# restore_database: whatever a database phase that died left, undone. Before the kill, the primary stops waiting for
# the standby, which goes. After the kill and before the promotion, the primary has every commit it acknowledged: it
# starts again, without the standby. After the promotion, the standby took the writes: it goes back into the stack's
# container (switch_back).
restore_database() {
  local step
  step="$(cat "$drill/database" 2> /dev/null || true)"
  [ -n "$step" ] || return 0
  say "restoring the database from step $step of a database phase"
  case "$step" in
    standby | killed)
      docker rm -f "$standby" > /dev/null 2>&1 || true
      rm -rf "$standby_dir"
      [ "$(health "$primary")" = healthy ] || start_container "$primary" 300
      docker exec "$primary" psql -U orbit -d orbit -tAc "ALTER SYSTEM RESET synchronous_standby_names" > /dev/null
      docker exec "$primary" psql -U orbit -d orbit -tAc "SELECT pg_reload_conf()" > /dev/null
      rm -f "$drill/database" ;;
    promoted) switch_back ;;
    stopped)
      if [ -d "$standby_dir" ]; then
        rm -rf "$state/postgres-before-failover"
        mv "$state/postgres" "$state/postgres-before-failover"
        mv "$standby_dir" "$state/postgres"
      fi
      docker rm -f "$standby" > /dev/null 2>&1 || true
      rm -f "$drill/primary"
      start_container "$primary" 300
      rm -f "$drill/database"
      rm -rf "$state/postgres-before-failover" ;;
  esac
}
# restore_faults: every fault a phase that died left, undone: the partition lifted, a killed container started, the
# database back in the stack's container.
restore_faults() {
  local down
  reconnect
  down="$(cat "$drill/down" 2> /dev/null || true)"
  if [ -n "$down" ]; then
    docker start "$down" > /dev/null 2>&1 || true
    rm -f "$drill/down"
  fi
  restore_database
}

# --- A fault on a streaming session, judged. --------------------------------------------------------------------------
# begin PHASE LABEL SWITCH: the session LABEL as the fault PHASE starts from: the runner on the link with
# RUNNER_LINK_REQUIRED SWITCH (true or false), the session running its prompt, and its stored ticks caught up with its
# engine's, so that whatever is not stored afterwards is the fault's.
begin() {
  phase=$1
  stack_settings
  load_session "$2"
  runner_running || fail "$phase: the drill runner is not running: run prepare"
  switch_is "$3" || fail "$phase: RUNNER_LINK_REQUIRED is not $3"
  wait_presence LINK 120 || fail "$phase: the runner's presence does not say LINK"
  ticker_running || fail "$phase: the ticker of session $sid has stopped: run $2 again"
  [ "$(session_status)" = RUNNING ] || fail "$phase: session $sid is $(session_status), not RUNNING: run $2 again"
  wait_until 120 caught_up "$(released)" || fail "$phase: session $sid's stored ticks do not catch up before the fault"
  since_at="$(now)"
  from="$(log_lines)"
  pid0="$(runner_pid)"
  process0="$(presence | cut -d' ' -f2)"
  apiserver0="$(docker inspect -f '{{.RestartCount}} {{.State.StartedAt}}' "$apiserver")"
  statuses=""
  : > "$out/$phase-samples.tsv"
}
# sample: a line of the fault's samples, taken every 2 s while it lasts: the session's status, the ticks released and
# stored ("ROWS DISTINCT LAST"), the runner's presence. A read fails while the database is down, and samples "-".
sample() {
  local st stored pres
  st="$(session_status 2> /dev/null || echo -)"
  stored="$(stored_ticks 2> /dev/null || echo -)"
  pres="$(presence 2> /dev/null || echo -)"
  printf '%s\t%s\t%s\t%s\t%s\n' "$(now)" "${st:--}" "$(released)" "$stored" "${pres:--}" >> "$out/$phase-samples.tsv"
  if [ -n "$st" ] && [ "$st" != - ] && [ "${statuses##* }" != "$st" ]; then statuses="${statuses:+$statuses }$st"; fi
  runner_running || fail "$phase: the drill runner exited (see $drill/runner.log)"
}
hold() {
  local ends=$((SECONDS + $1))
  while [ $SECONDS -lt $ends ]; do
    sample
    sleep 2
  done
}
# judge FAULT [FALLBACK]: the fault that ended at up_at, with k_down and k_up the ticks released as it began and ended,
# judged once the session has stored tick k_up (within ORBIT_DURABLE_EVENTS_CATCHUP): every seq up to the session's
# last held by a row, every tick stored once, those written during the fault among them, the runner reading each off its
# engine as it came, no ping or live event stored, no event dropped or lost in the runner's log, the work kept on the
# link (unless FALLBACK is 1), the session RUNNING throughout, and the same runner process before and after. A line in
# phases.tsv; failed is set when any of it does not hold.
judge() {
  local fault=$1 fallback_ok=${2:-0} caught_at="" caught_s=- verdicts=() s hole_list t missing n_during read_max stored_first
  local stored_final live drops losses fallbacks retries reconnect_line pid1 process1 apiserver1 verdict reaper
  if wait_until "$catchup" caught_up "$k_up"; then
    caught_at="$(now)"
    caught_s="$(seconds "$up_at" "$caught_at")"
  fi
  sample
  s="$(seqs)"
  hole_list="$(holes)"
  t="$(stored_ticks)"
  missing="$(missing_ticks "${t##* }")"
  read -r n_during read_max stored_first stored_final <<< "$(tick_lags $((k_down + 1)) "$k_up")"
  live="$(live_rows)"
  drops="$(log_since_re "$from" "$drop_re" | wc -l)"
  losses="$(log_since_re "$from" "$loss_re" | wc -l)"
  fallbacks="$(log_since "$from" 'runner link mode: off' | wc -l)"
  retries="$(log_since "$from" 'were not stored (' | wc -l)"
  reconnect_line="$(log_since "$from" 'carries the work of process' | tail -n 1 | sed -E 's/^.*(runner link: )/\1/')"
  # A failover empties runner_presence (UNLOGGED): the runner's next beat writes it again.
  wait_until 90 presence_heard || true
  pid1="$(runner_pid)"
  process1="$(presence | cut -d' ' -f2)"
  apiserver1="$(docker inspect -f '{{.RestartCount}} {{.State.StartedAt}}' "$apiserver")"
  [ -n "$caught_at" ] || verdicts+=("tick $k_up is not stored within $catchup s of the fault's end")
  [ -z "$hole_list" ] || verdicts+=("seqs without a row: $hole_list")
  [ "$(cut -d' ' -f1 <<< "$t")" = "$(cut -d' ' -f2 <<< "$t")" ] || verdicts+=("ticks stored more than once (rows, distinct, last: $t)")
  [ -z "$missing" ] || verdicts+=("ticks not stored: $missing")
  [ "$n_during" = $((k_up - k_down)) ] || verdicts+=("$n_during of the $((k_up - k_down)) ticks written during the fault are stored")
  awk -v r="$read_max" 'BEGIN { exit !(r != "-" && r + 0 <= 5) }' ||
    verdicts+=("the runner took up to $read_max s to read a tick off its engine")
  [ "$live" = 0 ] || verdicts+=("$live progress pings or live events stored")
  [ "$drops" = 0 ] || verdicts+=("$drops 'dropping N events' line(s) in the runner log")
  [ "$losses" = 0 ] || verdicts+=("$losses event loss line(s) in the runner log")
  [ "$fallback_ok" = 1 ] || [ "$fallbacks" = 0 ] || verdicts+=("the runner took its work back to HTTPS ($fallbacks line(s))")
  [ "$statuses" = RUNNING ] || verdicts+=("the session was $statuses during the fault")
  { [ "$pid1" = "$pid0" ] && [ "$process1" = "$process0" ]; } ||
    verdicts+=("the runner is pid $pid1 process $process1 after the fault, pid $pid0 process $process0 before it")
  if [ ${#verdicts[@]} -eq 0 ]; then verdict=PASS; else verdict="$(printf '%s; ' "${verdicts[@]}")"; verdict="${verdict%; }"; fi
  printf '%s\t' "$phase" "$fault" "$down_at" "$up_at" "$(seconds "$down_at" "$up_at")" "$((k_up - k_down))" "$caught_s" \
    "$read_max" "$stored_first..$stored_final" "$s" "${hole_list:-none}" "$t" "${missing:-none}" "$live" "$drops" "$losses" \
    "$fallbacks" "$retries" "$statuses" >> "$table"
  printf '%s\n' "$verdict" >> "$table"
  [ -n "$reconnect_line" ] || reconnect_line="the link connection held"
  say "$phase: $reconnect_line; $retries resend(s) of the session's events logged; the apiserver (restarts, started) was \"$apiserver0\", is \"$apiserver1\""
  say "$phase: $((k_up - k_down)) ticks written during the fault, each read off the engine within $read_max s and stored $stored_first..$stored_final s after its release; tick $k_up stored ${caught_s} s after the fault ended; seqs (rows first last tombstones) $s, holes ${hole_list:-none}; ticks (rows distinct last) $t"
  docker logs --since "$since_at" "$gateway" > "$out/$phase-link-gateway.log" 2>&1 || true
  docker logs --since "$since_at" "$apiserver" > "$out/$phase-apiserver.log" 2>&1 || true
  awk -v from="$from" 'NR > from' "$drill/runner.log" > "$out/$phase-runner.log"
  # Why the reaper held its sweeps over the phase, each reason with how many sweeps gave it.
  reaper="$(sed 's/\x1b\[[0-9;]*m//g' "$out/$phase-apiserver.log" | grep -E 'not reaping' |
    sed -E 's/^.*not reaping [^:]*: //; s/[0-9]+/N/g' | sort | uniq -c | sort -rn |
    awk '{ n = $1; $1 = ""; printf "%s%sx \"%s\"", (NR > 1 ? ", " : ""), n, substr($0, 2) }' || true)"
  say "$phase: the reaper held ${reaper:-no sweep}; it reaped the session $(grep -c -e "reaped session $suuid" -e "reaped session $sid" "$out/$phase-apiserver.log" || true) time(s)"
  if [ "$verdict" = PASS ]; then
    say "$phase holds: $fault; every seq of session $sid held, every tick stored once, nothing dropped"
  else
    say "FAIL: $phase: $verdict"
    failed=1
  fi
}

# --- Phases. ----------------------------------------------------------------------------------------------------------
prepare() {
  local name answer
  # A run's records are its own: nothing an earlier run left is read as this one's.
  rm -rf "$out"
  mkdir -p "$out"
  say "prepare: the stack $project in the cut-over state, built from $(git -C "$repo" rev-parse --short HEAD) ($(git -C "$repo" status --short | wc -l) paths changed)"
  stop_ticker
  stop_runner
  restore_faults
  ORBIT_LINK_STAGING_MODE=http ORBIT_LINK_STAGING_BACKENDS=1 "$here/staging-up.sh" > "$out/prepare-staging-up.log" 2>&1 ||
    fail "staging-up.sh (see $out/prepare-staging-up.log)"
  stack_settings
  answer="$(api switch on)" || fail "switching RUNNER_LINK_REQUIRED on"
  [ "$(json "$answer" required)" = true ] || fail "RUNNER_LINK_REQUIRED is not on: $answer"
  say "stack $project up at $origin, its link gateway following the switch: RUNNER_LINK_REQUIRED $answer"
  rm -rf "$drill"
  mkdir -p "$drill"/{bin,home,orbit,fakebin,fake,empty,tmp,work}
  (cd "$repo/src/runner-go" && go build -o "$drill/bin/orbit" . && go test -c -o "$drill/fake/orbit.test" .) \
    > "$out/prepare-build.log" 2>&1 || fail "building the runner and the scripted claude (see $out/prepare-build.log)"
  cat > "$drill/fakebin/claude" <<EOF
#!/bin/sh
# The suite's scripted Claude CLI (src/runner-go/fake_claude_test.go), the drill runner's only engine. It waits for its
# next message, and for its next tick, as long as the drill lasts.
case "\$1 \$2" in
"auth status") echo '{"loggedIn":true}'; exit 0 ;;
esac
ORBIT_FAKE_CLAUDE_DIR=$drill/fake ORBIT_FAKE_CLAUDE_WAIT=3h exec $drill/fake/orbit.test "\$@"
EOF
  chmod 755 "$drill/fakebin/claude"
  name="durable-events-drill-$(date -u +%m%d-%H%M%S)"
  runner_cmd
  "${RUNNER[@]}" register --server "$origin" --token "$(cat "$state/secrets/enrollment_token")" --name "$name" \
    --no-service --no-auto-install-engines < /dev/null > "$out/prepare-register.log" 2>&1 ||
    fail "registering the drill runner (see $out/prepare-register.log)"
  start_runner
  say "drill runner $name ($(runner_id)) started as $unit, pid $(runner_pid)"
  wait_log 0 'runner link mode: on' 180
  wait_presence LINK 180 || fail "the runner's presence does not say LINK within 180 s"
  say "runner log: $(log_since 0 'runner link mode: on' | head -n 1 | sed -E 's/^.*(runner link mode: on)/\1/'); presence $(presence)"
  api workspace "$(runner_id)" "$drill/work" "$name" > "$drill/workspace.json" || fail "creating the drill workspace"
  printf '%s\t' phase fault down_at up_at down_s ticks_during caught_up_s read_max_s stored_after_release_s \
    'seqs(rows,first,last,tombstones)' holes 'ticks(rows,distinct,last)' missing_ticks live_rows drops losses fallbacks \
    resends statuses > "$table"
  printf 'verdict\n' >> "$table"
  say "prepare holds: the runner works over the link alone, HTTPS refusing its daemon calls"
}

stream_phase() {
  phase=stream
  stack_settings
  runner_running || fail "stream: the drill runner is not running: run prepare"
  switch_is true || fail "stream: RUNNER_LINK_REQUIRED is off: run prepare"
  wait_presence LINK 120 || fail "stream: the runner's presence does not say LINK"
  stop_ticker
  open_session stream "$stream_ticks" full "Durable events drill, stream: the prompt, whose answer streams until the drill ends"
  start_ticker 1
  wait_until 180 caught_up 3 || fail "stream: session $sid stored no third tick within 180 s (it is $(session_status))"
  [ "$(session_status)" = RUNNING ] || fail "stream: session $sid is $(session_status), not RUNNING"
  psql_value "SELECT runtime_session_id FROM session WHERE id = '$suuid'" > "$drill/stream.runtime"
  say "stream: session $sid ($suuid) RUNNING its prompt, which streams up to $stream_ticks ticks, one every $tick s, each a progress ping, a delta and an assistant message; stored so far: seqs (rows first last tombstones) $(seqs)"
}

gateway_phase() {
  begin gateway stream true
  k_down="$(released)"
  kill_container "$gateway"
  down_at="$(now)"
  say "gateway: $gateway killed at tick $k_down"
  hold "$gateway_seconds"
  started_again "$gateway"
  up_at="$(now)"
  k_up="$(released)"
  say "gateway: $gateway started again, healthy at tick $k_up"
  judge "the link gateway killed for $gateway_seconds s"
}

apiserver_phase() {
  begin apiserver stream true
  k_down="$(released)"
  kill_container "$apiserver"
  down_at="$(now)"
  say "apiserver: $apiserver killed at tick $k_down"
  hold "$apiserver_seconds"
  started_again "$apiserver"
  up_at="$(now)"
  k_up="$(released)"
  say "apiserver: $apiserver started again, healthy at tick $k_up"
  judge "the apiserver killed for $apiserver_seconds s"
}

database_phase() {
  local resolved address presence0 up
  begin database stream true
  # Past the reaper's startup grace (3 minutes, reaper.service.ts) by a sweep: an apiserver that started just before,
  # as the apiserver phase's does, would hold every reaping through the failover for a reason of its own.
  up="$(seconds "$(docker inspect -f '{{.State.StartedAt}}' "$apiserver")" "$(now)")"
  if awk -v up="$up" 'BEGIN { exit !(up < 210) }'; then
    say "database: the apiserver started $up s ago; waiting for its reaper's 180 s startup grace to be past by a sweep"
    hold "$(awk -v up="$up" 'BEGIN { printf "%.0f", 211 - up }')"
  fi
  start_standby
  say "database: $standby streams from $primary synchronously: $(docker exec "$primary" psql -U orbit -d orbit -tAc "SELECT application_name || ' ' || state || ' ' || sync_state || ' replay ' || replay_lsn FROM pg_stat_replication")"
  presence0="$(presence)"
  k_down="$(released)"
  docker kill "$primary" > /dev/null
  echo killed > "$drill/database"
  down_at="$(now)"
  say "database: $primary killed at tick $k_down; the runner's presence was $presence0"
  hold "$database_seconds"
  promote_standby
  up_at="$(now)"
  k_up="$(released)"
  address="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$standby_net\").IPAddress}}" "$standby")"
  resolved="$(docker exec "$apiserver" node -e 'require("dns").lookup("postgres", { all: true }, (e, a) =>
    console.log(e ? e.code : a.map((x) => x.address).join(" ")))' 2>&1 || true)"
  say "database: $standby promoted at tick $k_up (in recovery: $(psql_value 'SELECT pg_is_in_recovery()' 2>&1)) and named postgres, at $address; the apiserver resolves postgres to $resolved; runner_presence (UNLOGGED) held $promoted_presence row(s) as the standby was promoted"
  judge "the database failed over: the primary killed, a synchronous standby promoted $database_seconds s later"
  say "database: the runner's presence after the failover is $(presence)"

  # Back into the stack's own container: a planned switchover, under the same stream.
  begin database-back stream true
  k_down="$(released)"
  down_at="$(now)"
  switch_back
  up_at="$(now)"
  k_up="$(released)"
  say "database-back: $standby stopped cleanly at tick $k_down, its data now the stack's $primary, healthy at tick $k_up"
  judge "the database switched back into the stack's container: the promoted standby stopped cleanly, the container started on its data"
}

partition_phase() {
  begin partition stream true
  k_down="$(released)"
  cut_off
  down_at="$(now)"
  say "partition: the runner cut off at tick $k_down: every packet its unit's processes send is dropped (nft table inet $nft_table)"
  hold "$partition_seconds"
  dropped="$(nft list table inet "$nft_table" 2> /dev/null | grep -o 'packets [0-9]*' || echo 'packets ?')"
  reconnect
  up_at="$(now)"
  k_up="$(released)"
  say "partition: the runner's network is back at tick $k_up; the rule dropped ${dropped#packets } packets"
  judge "the runner cut off the network for $partition_seconds s, RUNNER_LINK_REQUIRED on"
}

finish_phase() {
  local k0 s hole_list t missing live drops losses fallbacks turn ran starts runtime st verdicts=() verdict marker first_on
  phase=finish
  stack_settings
  load_session stream
  runner_running || fail "finish: the drill runner is not running: run prepare"
  since_at="$(now)"
  k0="$(released)"
  release_rest
  say "finish: ticks $((k0 + 1))..$ticks_total of session $sid released at once"
  wait_until 300 answered_with "$(prompt_marker)" ||
    fail "finish: the stream's turn is not answered within 300 s (the session is $(session_status))"
  wait_until 60 caught_up "$ticks_total" || true
  s="$(seqs)"
  hole_list="$(holes)"
  t="$(stored_ticks)"
  missing="$(missing_ticks "$ticks_total")"
  live="$(live_rows)"
  # The runner's whole log since it went on the link: it has not stopped, so nothing may have left the link.
  first_on="$(awk 'index($0, "runner link mode: on") { print NR - 1; exit }' "$drill/runner.log")"
  drops="$(log_since_re 0 "$drop_re" | wc -l)"
  losses="$(log_since_re 0 "$loss_re" | wc -l)"
  fallbacks="$(log_since "${first_on:-0}" 'runner link mode: off' | wc -l)"
  turn="$(psql_value "SELECT id FROM conversation_turn WHERE session_id = '$suuid' AND kind = 'message' ORDER BY seq LIMIT 1")"
  marker="$(prompt_marker)"
  ran="$(deliveries "$marker") $(psql_value "SELECT count(*) FILTER (WHERE type = 'user') || ' ' ||
    count(*) FILTER (WHERE type = 'user_delivery' AND payload->>'delivery' = 'written') || ' ' ||
    count(*) FILTER (WHERE type = 'user_delivery' AND payload->>'delivery' = 'acknowledged') || ' ' ||
    count(*) FILTER (WHERE type = 'turn_end') FROM run_event WHERE turn_id = '$turn'")"
  runtime="$(cat "$drill/stream.runtime")"
  starts="$(engine_starts "$runtime")"
  st="$(session_status)"
  [ -z "$hole_list" ] || verdicts+=("seqs without a row: $hole_list")
  [ "$t" = "$ticks_total $ticks_total $ticks_total" ] || verdicts+=("ticks (rows, distinct, last) $t, not $ticks_total each once")
  [ -z "$missing" ] || verdicts+=("ticks not stored: $missing")
  [ "$live" = 0 ] || verdicts+=("$live progress pings or live events stored")
  [ "$drops" = 0 ] || verdicts+=("$drops 'dropping N events' line(s) in the runner log")
  [ "$losses" = 0 ] || verdicts+=("$losses event loss line(s) in the runner log")
  [ "$fallbacks" = 0 ] || verdicts+=("the runner took its work back to HTTPS ($fallbacks line(s))")
  [ "$ran" = "1 1 1 1 1" ] || verdicts+=("the prompt ran as \"$ran\" (stdin, user, written, acknowledged, turn_end), not once")
  [ "$starts" = 1 ] || verdicts+=("the session's engine started $starts times")
  [ "$st" = AWAITING_INPUT ] || verdicts+=("the session is $st, not AWAITING_INPUT")
  if [ ${#verdicts[@]} -eq 0 ]; then verdict=PASS; else verdict="$(printf '%s; ' "${verdicts[@]}")"; verdict="${verdict%; }"; fi
  printf '%s\t' whole "session $sid from its prompt to its turn's end" "$(head -n 1 "$out/stream-ticks.tsv" | cut -f2)" \
    "$(now)" - "$ticks_total" - - - "$s" "${hole_list:-none}" "$t" "${missing:-none}" "$live" "$drops" "$losses" \
    "$fallbacks" - "$st" >> "$table"
  printf '%s\n' "$verdict" >> "$table"
  awk -v from=0 'NR > from' "$drill/runner.log" > "$out/finish-runner.log"
  say "finish: session $sid is $st; seqs (rows first last tombstones) $s, holes ${hole_list:-none}; ticks (rows distinct last) $t; the prompt ran as \"$ran\"; its engine started $starts time(s); the runner log has $drops dropping line(s), $losses loss line(s), $fallbacks turn(s) to HTTPS"
  if [ "$verdict" = PASS ]; then
    say "whole session holds: every one of its $(cut -d' ' -f1 <<< "$s") seqs held by a row, all $ticks_total ticks stored once, no ping or delta stored, nothing dropped"
  else
    say "FAIL: whole session: $verdict"
    failed=1
  fi
}

# spool_events: the events the drill runner's spool holds for the loaded session, a line each: "SEQ<TAB>TYPE<TAB>TEXT".
spool_events() {
  local dir
  for dir in "$drill/orbit/link-spool/"*/; do
    [ -d "$dir" ] || continue
    case "$dir" in *"$suuid"* | *"$sid"* | *"${suuid//-/}"*) cat "$dir"*.jsonl 2> /dev/null || true ;; esac
  done | node -e '
    const rows = [];
    for (const line of require("fs").readFileSync(0, "utf8").split("\n").filter(Boolean)) {
      try {
        const e = JSON.parse(line);
        const p = e.payload || {};
        rows.push([e.seq, e.type, String(p.text ?? p.subtype ?? p.delivery ?? "").replace(/[\t\n]/g, " ")]);
      } catch {}
    }
    rows.sort((a, b) => a[0] - b[0]);
    for (const r of rows) console.log(r.join("\t"));'
}
# spool_fate FILE: of the events in FILE (spool_events), how many the session stores at their seq (the same type and
# text), how many of their seqs hold another event, and how many no row: "STORED TAKEN NONE".
spool_fate() {
  local first last
  first="$(head -n 1 "$1" | cut -f1)"
  last="$(tail -n 1 "$1" | cut -f1)"
  if [ -z "$first" ]; then echo "0 0 0"; return; fi
  join -t $'\t' -a 1 -e '' -o '1.1,1.2,1.3,2.2,2.3' <(sort -t $'\t' -k1,1 "$1") \
    <(psql_rows "SELECT seq, type, replace(COALESCE(payload->>'text', payload->>'subtype', payload->>'delivery', ''), E'\t', ' ')
        FROM run_event WHERE session_id = '$suuid' AND seq BETWEEN $first AND $last" | sort -t $'\t' -k1,1) |
    awk -F'\t' '{ if ($4 == "") n++; else if ($2 == $4 && $3 == $5) s++; else t++ } END { print s + 0, t + 0, n + 0 }'
}
# rollback_step STEP: a line of rollback.tsv for the session as it stands after STEP.
rollback_step() {
  local step=$1 s hole_list t missing spool_n spool_range fate drops losses ends
  s="$(seqs)"
  ends="$(psql_value "SELECT count(*) FROM run_event WHERE session_id = '$suuid' AND type = 'turn_end' AND turn_id =
    (SELECT id FROM conversation_turn WHERE session_id = '$suuid' AND kind = 'message' ORDER BY seq LIMIT 1)")"
  hole_list="$(holes)"
  t="$(stored_ticks)"
  missing="$(missing_ticks "$ticks_total")"
  spool_events > "$out/rollback-spool-$step.tsv"
  spool_n="$(wc -l < "$out/rollback-spool-$step.tsv")"
  spool_range="$(awk -F'\t' 'NR == 1 { a = $1 } { b = $1 } END { if (NR) print a "-" b; else print "-" }' "$out/rollback-spool-$step.tsv")"
  fate="$(spool_fate "$out/rollback-spool.tsv")"
  drops="$(log_since_re "$from0" "$drop_re" | wc -l)"
  losses="$(log_since_re "$from0" "$loss_re" | wc -l)"
  printf '%s\t' "$step" "$(now)" "$s" "${hole_list:-none}" "$t" "${missing:-none}" "$spool_n" "$spool_range" "$fate" "$ends" "$drops" >> "$rollback_table"
  printf '%s\n' "$losses" >> "$rollback_table"
  say "rollback, $step: seqs (rows first last tombstones) $s, holes ${hole_list:-none}; ticks (rows distinct last) $t, not stored: ${missing:-none}; the prompt's turn has $ends turn_end row(s); the spool holds $spool_n event(s) ($spool_range); of the $(wc -l < "$out/rollback-spool.tsv") the stopped runner kept, (stored, seq taken by another event, no row) = $fate; runner log since the session opened: $drops dropping line(s), $losses loss line(s)"
}

rollback_phase() {
  local down_at kept kept_n from1 from2 resent fate verdicts=() verdict missing
  phase=rollback
  stack_settings
  runner_running || fail "rollback: the drill runner is not running: run prepare"
  switch_is true || fail "rollback: RUNNER_LINK_REQUIRED is off: run prepare"
  wait_presence LINK 120 || fail "rollback: the runner's presence does not say LINK"
  since_at="$(now)"
  statuses=""
  : > "$out/rollback-samples.tsv"
  stop_ticker
  write_resume_script rollback
  open_session rollback "$rollback_ticks" full "Durable events drill, rollback: the prompt, whose answer streams across a stop with the link down"
  from0="$(log_lines)"
  start_ticker 1
  wait_until 180 caught_up 5 || fail "rollback: session $sid stored no fifth tick within 180 s (it is $(session_status))"
  printf '%s\t' step at 'seqs(rows,first,last,tombstones)' holes 'ticks(rows,distinct,last)' missing_ticks spool_events \
    spool_seqs 'kept_events(stored,taken,none)' prompt_turn_ends drops > "$rollback_table"
  printf 'losses\n' >> "$rollback_table"

  # The link gateway goes down; the engine writes on, and ends its turn.
  k_down="$(released)"
  kill_container "$gateway"
  down_at="$(now)"
  say "rollback: session $sid ($suuid) streaming, $(stored_last) ticks stored; $gateway killed at tick $k_down"
  hold 20
  release_rest
  sleep 5
  say "rollback: the engine has been released all $ticks_total ticks and the turn's end, the link down since $down_at; $(stored_last) ticks stored"

  # The runner stopped as a service manager stops it: what is not acknowledged goes to its spool.
  stop_runner
  kept="$(log_since "$from0" 'unacknowledged events of session' | tail -n 1 | sed -E 's/^.*(runner link: )/\1/')"
  say "rollback: runner log as it stopped: ${kept:-nothing kept for the next process}"
  spool_events > "$out/rollback-spool.tsv"
  kept_n="$(wc -l < "$out/rollback-spool.tsv")"
  rollback_step stopped

  # The rollback: RUNNER_LINK_REQUIRED off, the gateway back, the runner started again with ORBIT_LINK_MODE=off.
  api switch off > /dev/null || fail "rollback: switching RUNNER_LINK_REQUIRED off"
  started_again "$gateway"
  from1="$(log_lines)"
  start_runner ORBIT_LINK_MODE=off
  wait_log "$from1" 'runner link mode: off (ORBIT_LINK_MODE=off)' 60
  wait_presence HTTP 180 || fail "rollback: the runner started with ORBIT_LINK_MODE=off does not beat over HTTPS within 180 s"
  say "rollback: RUNNER_LINK_REQUIRED off; the runner started again with ORBIT_LINK_MODE=off (pid $(runner_pid)): $(log_since "$from1" 'runner link mode: off' | head -n 1 | sed -E 's/^.*(runner link mode)/\1/'); presence $(presence)"
  api turn "$sid" "Durable events drill, rollback: a message after the rollback" > /dev/null ||
    fail "rollback: sending the message after the rollback"
  wait_until 300 answered_with "a message after the rollback" ||
    fail "rollback: the message after the rollback is not answered within 300 s (the session is $(session_status))"
  rollback_step after-rollback

  # On the link again: RUNNER_LINK_REQUIRED on, the runner started again as it was, on the same machine.
  stop_runner
  api switch on > /dev/null || fail "rollback: switching RUNNER_LINK_REQUIRED on"
  from2="$(log_lines)"
  start_runner
  wait_log "$from2" 'runner link mode: on' 180
  wait_presence LINK 180 || fail "rollback: the runner on the link again does not beat over it within 180 s"
  say "rollback: RUNNER_LINK_REQUIRED on; the runner on the link again (pid $(runner_pid)), presence $(presence)"
  # The session's next supervisor opens its event stream, which reads the spool: at its next message.
  api turn "$sid" "Durable events drill, rollback: a message on the link again" > /dev/null ||
    fail "rollback: sending the message on the link again"
  wait_until 300 answered_with "a message on the link again" ||
    fail "rollback: the message on the link again is not answered within 300 s (the session is $(session_status))"
  wait_until 120 spool_sent || true
  resent="$(log_since "$from2" "an earlier process could not send" | grep -F -e "$suuid" -e "$sid" | tail -n 1 | sed -E 's/^.*(runner link: )/\1/' || true)"
  say "rollback: runner log on the link again: ${resent:-no events of session $sid an earlier process could not send}"
  rollback_step on-link-again

  missing="$(missing_ticks "$ticks_total")"
  fate="$(spool_fate "$out/rollback-spool.tsv")"
  [ -z "$missing" ] || verdicts+=("ticks the engine wrote and the session never stored: $missing")
  [ "${fate%% *}" = "$kept_n" ] || verdicts+=("of the $kept_n events the stopped runner kept, (stored, seq taken by another event, no row) = $fate")
  [ -z "$(holes)" ] || verdicts+=("seqs without a row: $(holes)")
  if [ ${#verdicts[@]} -eq 0 ]; then verdict=PASS; else verdict="$(printf '%s; ' "${verdicts[@]}")"; verdict="${verdict%; }"; fi
  printf 'verdict\t%s\n' "$verdict" >> "$rollback_table"
  awk -v from="$from0" 'NR > from' "$drill/runner.log" > "$out/rollback-runner.log"
  docker logs --since "$since_at" "$gateway" > "$out/rollback-link-gateway.log" 2>&1 || true
  docker logs --since "$since_at" "$apiserver" > "$out/rollback-apiserver.log" 2>&1 || true
  if [ "$verdict" = PASS ]; then
    say "rollback holds: every event the stopped runner kept is stored, every tick once"
  else
    say "FAIL: rollback: $verdict"
    failed=1
  fi
}
spool_sent() { [ -z "$(spool_events | head -n 1)" ]; }

partition_off_phase() {
  stack_settings
  runner_running || fail "partition-off: the drill runner is not running: run prepare"
  # HTTPS still served, and the gateway telling the runner MODE_LINK whatever the switch says.
  if [ "$(setting STAGING_MODE http)" != link ]; then
    ORBIT_LINK_STAGING_MODE=link ORBIT_LINK_STAGING_BACKENDS=1 "$here/staging-up.sh" --no-build \
      > "$out/partition-off-staging-up.log" 2>&1 || fail "staging-up.sh to MODE_LINK (see $out/partition-off-staging-up.log)"
  fi
  api switch off > /dev/null || fail "partition-off: switching RUNNER_LINK_REQUIRED off"
  wait_presence LINK 180 || fail "partition-off: the runner's presence does not say LINK"
  stop_ticker
  open_session off "$off_ticks" durable "Durable events drill, off: the prompt, whose answer streams across a partition with RUNNER_LINK_REQUIRED off"
  start_ticker 1
  wait_until 180 caught_up 3 || fail "partition-off: session $sid stored no third tick within 180 s"
  begin partition-off off false
  k_down="$(released)"
  cut_off
  down_at="$(now)"
  say "partition-off: the runner cut off at tick $k_down, RUNNER_LINK_REQUIRED off and the gateway in MODE_LINK"
  hold "$partition_seconds"
  reconnect
  up_at="$(now)"
  k_up="$(released)"
  say "partition-off: the runner's network is back at tick $k_up; runner log meanwhile: $(log_since "$from" 'runner link mode: off' | head -n 1 | sed -E 's/^.*(runner link mode)/\1/')"
  judge "the runner cut off the network for $partition_seconds s, RUNNER_LINK_REQUIRED off" 1
  release_rest
  wait_until 300 answered_with "$(prompt_marker)" || say "partition-off: the turn is not answered within 300 s"
  say "partition-off: once its turn ended: seqs (rows first last tombstones) $(seqs), holes $(holes); ticks (rows distinct last) $(stored_ticks), not stored: $(missing_ticks "$ticks_total")"
}

summary() {
  {
    echo "durable-events drill on $project, $(git -C "$repo" rev-parse --short HEAD), written $(now)"
    awk -F'\t' 'NR > 1 { printf "%s: %s; %s ticks during, caught up %s s after; seqs %s, holes %s; ticks %s; drops %s, losses %s, fallbacks %s; statuses %s: %s\n",
      $1, $2, $6, $7, $10, $11, $12, $15, $16, $17, $19, $20 }' "$table"
    if [ -f "$rollback_table" ]; then
      awk -F'\t' 'NR > 1 && $1 != "verdict" { printf "rollback %s: seqs %s, holes %s; ticks %s, not stored %s; spool %s (%s); kept (stored, taken, none) %s; prompt turn_end rows %s; drops %s, losses %s\n",
        $1, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12 } $1 == "verdict" { print "rollback: " $2 }' "$rollback_table"
    fi
  } > "$summary_file"
  say "summary: $(tr '\n' '|' < "$summary_file")"
}

case "${1:-}" in
  prepare | stream | gateway | apiserver | database | partition | finish | rollback | partition-off | all | stop)
    mkdir -p "$out" ;;
esac
failed=0
case "${1:-}" in
  prepare | stream | gateway | apiserver | database | partition | finish | rollback | partition-off | all)
    trap restore_faults EXIT
    trap 'exit 143' TERM INT ;;
esac
case "${1:-}" in
  prepare) prepare ;;
  stream) stream_phase ;;
  gateway) gateway_phase; summary; exit "$failed" ;;
  apiserver) apiserver_phase; summary; exit "$failed" ;;
  database) database_phase; summary; exit "$failed" ;;
  partition) partition_phase; summary; exit "$failed" ;;
  finish) finish_phase; summary; exit "$failed" ;;
  rollback) rollback_phase; summary; exit "$failed" ;;
  partition-off) partition_off_phase; summary; exit "$failed" ;;
  all)
    prepare
    stream_phase
    gateway_phase
    apiserver_phase
    database_phase
    partition_phase
    finish_phase
    rollback_phase
    summary
    exit "$failed" ;;
  report) cat "$summary_file"; column -t -s $'\t' "$table" 2> /dev/null || cat "$table" ;;
  stop) stop_ticker; stop_runner; restore_faults ;;
  -h | --help | "") sed -n '2,57p' "$0" ;;
  *) die "unknown phase $1 (see --help)" ;;
esac
