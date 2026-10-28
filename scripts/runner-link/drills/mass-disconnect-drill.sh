#!/usr/bin/env bash
# A mass disconnection (docs/runner-link-design.md §6.5, §10; task C1b), drilled on a staging stack with real runners.
# When a fifth of the cell's runners go quiet at once, because a link gateway node stopped or a network cut them off,
# their silence says nothing about whether they are alive. What must hold: the reaper reaps no session as
# `runner offline` while they are out of reach, and once they are back every session goes on by itself: the turn it was
# running ends, with what its engine wrote during the outage stored, and its next message is answered.
#
#   mass-disconnect-drill.sh prepare    The stack in the cut-over state, built from this checkout:
#                                       RUNNER_LINK_REQUIRED on, so a runner's daemon calls go over the link alone and
#                                       HTTPS refuses them. ORBIT_MASS_DISCONNECT_RUNNERS runners and the suite's
#                                       scripted claude, built from this checkout, each runner with a configuration
#                                       directory and a systemd unit of its own, started across one heartbeat interval
#                                       so that their beats are spread as a fleet's are; each one working over the link.
#   mass-disconnect-drill.sh gateway    Every runner's session runs a turn held open. The link gateway node is killed
#                                       for ORBIT_MASS_DISCONNECT_SECONDS, then started again: every runner loses the
#                                       link.
#   mass-disconnect-drill.sh partition  Every runner's session runs a turn held open. ORBIT_MASS_DISCONNECT_CUT runners,
#                                       a fifth of them or more, lose the network for as long; the others keep working.
#   mass-disconnect-drill.sh node       On a stack prepared with two link gateway nodes behind a balancer
#                                       (ORBIT_MASS_DISCONNECT_GATEWAYS=2): every runner's session runs a turn held open,
#                                       and the first node is killed for ORBIT_MASS_DISCONNECT_SECONDS. The runners it held
#                                       connect again through the second, whose handshake limiter lets a burst through
#                                       and the rest one at a time (ORBIT_MASS_DISCONNECT_HANDSHAKE_RATE and _BURST, the
#                                       second node's alone), so that most are back within seconds and the last only
#                                       past the reaper's offline line. Then the first node is started again.
#   mass-disconnect-drill.sh all        prepare, gateway, partition.
#   mass-disconnect-drill.sh stop       Stop the drill runners.
#
# Settings, besides the staging stack's own (staging-lib.sh, staging-up.sh):
#   ORBIT_MASS_DISCONNECT_RUNNERS      runners                                                      10
#   ORBIT_MASS_DISCONNECT_CUT          runners the partition cuts off, a fifth of them or more       2
#   ORBIT_MASS_DISCONNECT_SECONDS      how long each outage lasts                                   180
#   ORBIT_MASS_DISCONNECT_SWEEP_AFTER  the partition: how many seconds after the first runner cut off crosses the
#                                      reaper's offline line its next sweep is to fall, under 30; the runners cut off
#                                      and the moment are chosen for it (README.md). Unset, the partition cuts off
#                                      runners spread across the fleet, whenever it gets to the cut.
#   ORBIT_MASS_DISCONNECT_GATEWAYS     prepare: link gateway nodes, 1, or 2 behind a TCP balancer for node          1
#   ORBIT_MASS_DISCONNECT_HANDSHAKE_RATE   prepare: the second node's handshakes a second (LINK_HANDSHAKE_RATE)    200
#   ORBIT_MASS_DISCONNECT_HANDSHAKE_BURST  prepare: the second node's handshake burst (LINK_HANDSHAKE_BURST)       400
#
# Run it as root on a stack no other runner works on: each runner runs in a mount namespace of its own (as
# lost-answer-drill.sh's does) and in a systemd unit of its own, and the partition cuts a runner off with an nftables
# rule that drops the packets of its unit's cgroup. It needs docker, systemd, nft, node, go and curl. The records go to
# <state>/client/mass-disconnect/: timeline.txt is the drill's account, outages.tsv has a line per outage and
# sessions.tsv a line per session in it, beside each outage's samples of the sessions, the runners' silence and the cell
# as the reaper reads it, the crossings of its offline line, and the apiserver's and the link gateway's logs. Each
# runner, its log and its scripted claude's records are in <state>/mass-disconnect/r<n>/; the runners keep running
# after the drill until `mass-disconnect-drill.sh stop`. Setting up exits non-zero at the first step that does not
# hold; an outage is judged whole, and `all` runs both before it exits non-zero for either.
set -euo pipefail
# shellcheck source=../staging-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../staging-lib.sh"

helper="$here/drills/rollback-drill.mjs"
out="$state/client/mass-disconnect"
drill="$state/mass-disconnect"
timeline="$out/timeline.txt"
outages="$out/outages.tsv"
sessions_table="$out/sessions.tsv"
gateway="$project-link-gateway"
count="${ORBIT_MASS_DISCONNECT_RUNNERS:-10}"
cut="${ORBIT_MASS_DISCONNECT_CUT:-2}"
outage="${ORBIT_MASS_DISCONNECT_SECONDS:-180}"
sweep_after="${ORBIT_MASS_DISCONNECT_SWEEP_AFTER:-}"
gateways="${ORBIT_MASS_DISCONNECT_GATEWAYS:-1}"
handshake_rate="${ORBIT_MASS_DISCONNECT_HANDSHAKE_RATE:-200}"
handshake_burst="${ORBIT_MASS_DISCONNECT_HANDSHAKE_BURST:-400}"
# The second link gateway node, with ORBIT_MASS_DISCONNECT_GATEWAYS=2 (staging.gateways.compose.yml).
gateway_b="$project-link-gateway-b"
# The reaper's own numbers (src/apiserver/src/realtime/reaper.service.ts, src/apiserver/src/runners/runner-presence.ts):
# silent for longer than offline_after, a runner reads as offline; a sweep every sweep_every; nothing reaped as offline
# for startup_grace after the apiserver starts; the mass silence counts the runners that missed a beat (silent for
# longer than silent_after) among those heard from within window of that line. And the runner's heartbeat interval
# (src/runner-go/runloop.go).
offline_after=90 silent_after=45 sweep_every=30 startup_grace=180 window=600 heartbeat=30
[[ "$count" =~ ^[1-9][0-9]*$ ]] || die "ORBIT_MASS_DISCONNECT_RUNNERS must be a positive whole number, not $count"
[[ "$cut" =~ ^[1-9][0-9]*$ ]] || die "ORBIT_MASS_DISCONNECT_CUT must be a positive whole number, not $cut"
[[ "$outage" =~ ^[1-9][0-9]*$ ]] || die "ORBIT_MASS_DISCONNECT_SECONDS must be a positive whole number, not $outage"
[ -z "$sweep_after" ] || { [[ "$sweep_after" =~ ^[0-9]+(\.[0-9]+)?$ ]] &&
  awk -v s="$sweep_after" -v e="$sweep_every" 'BEGIN { exit !(s > 0 && s < e) }'; } ||
  die "ORBIT_MASS_DISCONNECT_SWEEP_AFTER must be a number of seconds above 0 and under $sweep_every, not $sweep_after"
[ "$cut" -lt "$count" ] || die "ORBIT_MASS_DISCONNECT_CUT ($cut) must leave some of the $count runners connected"
[ $((cut * 5)) -ge "$count" ] || die "ORBIT_MASS_DISCONNECT_CUT ($cut) must be a fifth of the $count runners or more"
# A runner that beat just before the cut is past the offline line 90 s into it, and the sweep after that comes within
# 30 s: two sweeps more than that, and every runner cut off is past the line for at least one whole sweep interval.
[ "$outage" -ge $((offline_after + 2 * sweep_every)) ] ||
  die "ORBIT_MASS_DISCONNECT_SECONDS ($outage) must be $((offline_after + 2 * sweep_every)) or more: every runner cut off has to be past the reaper's offline line for a sweep"
# The partition's nftables table: one rule a runner cut off, matching its unit's cgroup.
nft_table="${project//-/_}_mass_disconnect"

now() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
say() { echo "$(now) $*" | tee -a "$timeline" >&2; }
fail() { say "FAIL: $*"; die "$* (records in $out)"; }
json() { node -pe "const v = JSON.parse(process.argv[1]).$2; typeof v === 'object' ? JSON.stringify(v) : String(v)" "$1"; }
psql_value() { docker exec "$project-postgres" psql -U orbit -d orbit -tAc "$1"; }
psql_rows() { docker exec "$project-postgres" psql -U orbit -d orbit -tA -F $'\t' -c "$1"; }
epoch() { date -u -d "$1" +%s.%N; }
# since T: seconds from T to now, to the tenth.
since() { awk -v a="$(epoch "$1")" -v b="$(date -u +%s.%N)" 'BEGIN { printf "%.1f", b - a }'; }

# --- The stack, as prepare left it. -----------------------------------------------------------------------------------
stack_settings() {
  [ -f "$env_file" ] || fail "no staging stack in $state: run prepare"
  origin="http://$(setting STAGING_BIND 127.0.0.1):$(setting STAGING_HTTP_PORT 18086)"
}
api() { node "$helper" "$origin" "$state" "$@"; }
# The reaper's reading of the cell (RunnerPresenceService.fleetSilence), as "heard silent": the runners heard from
# within window of the silence line that can lose contact, and how many of them are past that line now: a beat missed.
fleet_sql="SELECT count(*)::text, (count(*) FILTER (WHERE b.at < now() - interval '$silent_after seconds'))::text
  FROM (SELECT GREATEST((SELECT p.last_beat_at FROM runner_presence p WHERE p.runner_id = r.id), r.last_heartbeat_at) AS at
          FROM runner r
         WHERE r.status <> 'OFFLINE'
           AND NOT EXISTS (SELECT 1 FROM managed_runner mr
                            WHERE mr.runner_id = r.id AND mr.management_state IN ('DRAINING', 'SLEEPING'))) b
 WHERE b.at >= now() - interval '$((silent_after + window)) seconds'"
fleet() { psql_rows "$fleet_sql" | tr '\t' ' '; }
# reaper_log SINCE: the apiserver's log since SINCE, each line with Docker's timestamp and without its colours.
reaper_log() { docker logs --timestamps --since "$1" "$project-apiserver" 2>&1 | sed 's/\x1b\[[0-9;]*m//g'; }
held_pattern='not reaping [0-9]+ session\(s\) whose runner looks offline'
# quiet_cell PHASE: the cell as an outage starts from, so that whatever holds the reaping in it is the outage's doing:
# the apiserver past its startup grace by a sweep; a while past the last sweep that held (a mass disconnection the
# reaper kept holds the runners last heard in it, which are heard again by now, and no runner silent later); no runner
# the reaper counts silent; and the drill's runners all the cell it hears, so that the runners an outage cuts off are
# the share of it the drill says. A runner stopped without signing off stays in the count until it is past the window,
# up to 10¾ minutes.
quiet_cell() {
  local phase=$1 deadline=$((SECONDS + silent_after + window + 120)) started up reading last wait
  started="$(docker inspect -f '{{.State.StartedAt}}' "$project-apiserver")"
  up="$(since "$started")"
  if awk -v up="$up" -v need=$((startup_grace + sweep_every)) 'BEGIN { exit !(up < need) }'; then
    say "$phase: the apiserver started ${up} s ago; waiting for its reaper's ${startup_grace} s startup grace to be past by a sweep"
    sleep "$(awk -v up="$up" -v need=$((startup_grace + sweep_every)) 'BEGIN { printf "%.0f", need - up + 1 }')"
  fi
  last="$(reaper_log "$started" | grep -E "$held_pattern" | tail -n 1 | cut -d' ' -f1 || true)"
  if [ -n "$last" ]; then
    wait="$(awk -v ago="$(since "$last")" -v need=$((offline_after + sweep_every)) 'BEGIN { printf "%.0f", need - ago + 1 }')"
    if [ "$wait" -gt 0 ]; then
      say "$phase: the reaper last held a sweep at $last; waiting ${wait} s for that hold to lapse"
      sleep "$wait"
    fi
  fi
  reading="$(fleet)"
  until [ "${reading#* }" = 0 ]; do
    [ $SECONDS -lt $deadline ] || fail "$phase: the reaper still counts ${reading#* } of ${reading% *} runners silent"
    say "$phase: the reaper counts ${reading#* } of ${reading% *} runners silent: waiting for them to leave its window"
    sleep 30
    reading="$(fleet)"
  done
  [ "${reading% *}" = "$count" ] || fail "$phase: the reaper hears ${reading% *} runners, not the drill's $count"
  say "$phase: the cell as the reaper reads it: ${reading% *} runners heard from, none silent; the apiserver up since $started"
}

# last_sweep: when the reaper last held a sweep, as the apiserver's log stamped it; nothing when it has held none since
# it started. The reaper sweeps on a timer, every sweep_every from when it started, so this says when its sweeps fall.
last_sweep() {
  reaper_log "$(docker inspect -f '{{.State.StartedAt}}' "$project-apiserver")" | grep -E "$held_pattern" | tail -n 1 |
    cut -d' ' -f1 || true
}

# --- The runners. -----------------------------------------------------------------------------------------------------
runners() { seq 1 "$count"; }
rdir() { echo "$drill/r$1"; }
unit() { echo "$project-mass-disconnect-r$1.service"; }
runner_running() { systemctl is-active --quiet "$(unit "$1")"; }
runner_log() { echo "$(rdir "$1")/runner.log"; }
account_home="$(getent passwd "$(id -u)" | cut -d: -f6)"
declare -A rid=()
# load_runners: every drill runner's id (rid), from the configuration its registration wrote.
load_runners() {
  local i
  for i in $(runners); do
    [ -f "$(rdir "$i")/orbit/config.json" ] || fail "runner r$i is not registered: run prepare"
    rid[$i]="$(node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).runnerId' "$(rdir "$i")/orbit/config.json")"
  done
}
# runner_ids_sql: the drill runners' ids, as a SQL list.
runner_ids_sql() { local i s=""; for i in $(runners); do s+="${s:+, }'${rid[$i]}'"; done; echo "$s"; }

# runner_cmd I: drill runner I's binary as the array RUNNER: in an environment of its own, kept on this checkout's build
# (ORBIT_NO_SELFUPDATE), and in a mount namespace in which the engine installers' directories under this account's home
# show its scripted claude alone (lost-answer-drill.sh says why). Every step execs the next, so the command's pid is the
# runner's: its unit's main process.
runner_cmd() {
  local dir
  dir="$(rdir "$1")"
  RUNNER=(/usr/bin/unshare -m --propagation private -- /bin/sh -c '
    dir=$1 home=$2
    shift 2
    if [ -d "$home/.local/bin" ]; then mount --bind "$dir/fakebin" "$home/.local/bin" || exit 1; fi
    for sub in .kimi-code/bin .opencode/bin; do
      if [ -d "$home/$sub" ]; then mount --bind "$dir/empty" "$home/$sub" || exit 1; fi
    done
    exec "$@"' sh "$dir" "$account_home"
    /usr/bin/env -i HOME="$dir/home" ORBIT_HOME="$dir/orbit" USER="$(id -un)" LOGNAME="$(id -un)"
    PATH="$dir/fakebin:/usr/sbin:/usr/bin:/sbin:/bin" SSL_CERT_FILE="$state/tls/ca-bundle.pem"
    ORBIT_NO_SELFUPDATE=1 ORBIT_NO_ENGINE_UPDATE=1 TMPDIR="$dir/tmp" "$drill/bin/orbit")
}
# start_runner I: drill runner I as a systemd unit of its own, whose cgroup is what the partition cuts off. Stopping it
# sends the runner SIGTERM, as a service manager does, and kills what is left of it after 150 s.
start_runner() {
  local dir
  dir="$(rdir "$1")"
  runner_cmd "$1"
  touch "$dir/runner.log"
  systemd-run --unit "$(unit "$1")" --collect --quiet -p KillMode=mixed -p TimeoutStopSec=150 \
    -p StandardOutput="append:$dir/runner.log" -p StandardError="append:$dir/runner.log" -- "${RUNNER[@]}" run
}
# stop_runners: every drill runner of this stack, whatever ORBIT_MASS_DISCONNECT_RUNNERS said when it was started.
stop_runners() {
  local units=()
  mapfile -t units < <(systemctl list-units --plain --no-legend --all "$project-mass-disconnect-r*.service" |
    awk '$3 != "inactive" { print $1 }')
  [ ${#units[@]} -gt 0 ] || return 0
  systemctl stop "${units[@]}" || true
  say "drill runners stopped: ${units[*]}"
}

log_count() { grep -c -- "$2" "$(runner_log "$1")" || true; }
log_lines() { wc -l < "$(runner_log "$1")"; }
# log_since I FROM PATTERN: runner I's log lines after line FROM that hold PATTERN, as a fixed string.
log_since() { awk -v from="$2" -v p="$3" 'NR > from && index($0, p)' "$(runner_log "$1")"; }
# wait_log I PATTERN COUNT SECONDS: a line of runner I's log matching PATTERN beyond the COUNT there were.
wait_log() {
  local deadline=$((SECONDS + $4))
  until [ "$(log_count "$1" "$2")" -gt "$3" ]; do
    [ $SECONDS -lt $deadline ] || fail "no new \"$2\" in runner r$1's log within $4 s"
    runner_running "$1" || fail "runner r$1 exited (see $(runner_log "$1"))"
    sleep 0.5
  done
}
# presence I: runner I's presence row, as "link_state process_id last_beat_at".
presence() {
  psql_value "SELECT link_state || ' ' || COALESCE(process_id::text, 'none') || ' ' || to_char(last_beat_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')
    FROM runner_presence WHERE runner_id = '${rid[$1]}'"
}
# presence_node I: the gateway node runner I was last heard through and when, as "gateway_id last_beat_at"; "none" for
# no node.
presence_node() {
  psql_value "SELECT COALESCE(gateway_id, 'none') || ' ' || to_char(last_beat_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')
    FROM runner_presence WHERE runner_id = '${rid[$1]}'"
}
# node_of CONTAINER: the gateway node's id, which the beats it forwards name (X-Orbit-Link-Gateway-Id): its hostname.
node_of() { docker inspect -f '{{.Config.Hostname}}' "$1"; }
# wait_presence I SECONDS: runner I's last beat came over the link; non-zero when it did not within SECONDS.
wait_presence() {
  local deadline=$((SECONDS + $2))
  while :; do
    [ "$(presence "$1" | cut -d' ' -f1)" = LINK ] && return 0
    [ $SECONDS -lt $deadline ] || return 1
    runner_running "$1" || return 1
    sleep 1
  done
}

# --- The scripted claude. ---------------------------------------------------------------------------------------------
# write_scripts PHASE: every runner's scripted claude, for the sessions PHASE opens: the prompt answered at once; the next
# message held open, its engine writing one event as it begins, one more once the drill releases PHASE-during, and its
# answer once it releases PHASE-end (fake_claude_test.go, `await: release`); every message after it answered at once.
# An engine reads its script when it starts, so the sessions an earlier phase opened keep theirs.
write_scripts() {
  local i
  for i in $(runners); do
    node -e '
      const [file, phase] = process.argv.slice(1);
      const answered = (text) => [{ emit: "assistant", text }, { emit: "result", text }];
      const steps = [{ await: "user" }, { emit: "replay_user" }, { emit: "system_init", version: "2.1.300" },
        ...answered(`${phase}: the prompt is answered.`)];
      steps.push({ await: "user" }, { emit: "replay_user" },
        { emit: "assistant", text: `${phase}: the long turn has begun.` },
        { await: "release", text: `${phase}-during` },
        { emit: "assistant", text: `${phase}: written during the outage.` },
        { await: "release", text: `${phase}-end` },
        ...answered(`${phase}: the long turn is answered.`));
      for (let n = 3; n <= 20; n += 1) steps.push({ await: "user" }, { emit: "replay_user" }, ...answered(`${phase}: message ${n} is answered.`));
      require("fs").writeFileSync(file, JSON.stringify(steps));' "$(rdir "$i")/fake/script.json" "$1"
  done
}
release() { touch "$(rdir "$1")/fake/release-$2"; }
# engine_starts I RUNTIME_SESSION_ID: how many times runner I started a session's engine (spawns.jsonl): its conversation
# opened or resumed under that id.
engine_starts() {
  if [ -f "$(rdir "$1")/fake/spawns.jsonl" ]; then grep -c -- "$2" "$(rdir "$1")/fake/spawns.jsonl" || true; else echo 0; fi
}

# --- Sessions. --------------------------------------------------------------------------------------------------------
declare -A sid=() suuid=()
workspace_id() { json "$(cat "$(rdir "$1")/workspace.json")" id; }
session_ids_sql() { local i s=""; for i in $(runners); do s+="${s:+, }'${suuid[$i]}'"; done; echo "$s"; }
session_status() { psql_value "SELECT status FROM session WHERE id = '$1'"; }
# assistant_at SESSION_UUID TEXT: when the session's assistant event saying TEXT was stored; nothing before it is.
assistant_at() {
  psql_value "SELECT to_char(min(ingested_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') FROM run_event
    WHERE session_id = '$1' AND type = 'assistant' AND payload->>'text' = '$2'"
}
# answered SESSION_UUID: how many of the session's messages are answered.
answered() { psql_value "SELECT count(*) FROM conversation_turn WHERE session_id = '$1' AND kind = 'message' AND status = 'ANSWERED'"; }
# long_turn_answered_at SESSION_UUID: when the session's held turn was answered; nothing before it is.
long_turn_answered_at() {
  psql_value "SELECT to_char(answered_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') FROM conversation_turn
    WHERE session_id = '$1' AND kind = 'message' AND status = 'ANSWERED' AND content LIKE '%a turn held open across the outage%'"
}
# wait_until SECONDS COMMAND...: COMMAND holds within SECONDS (polled every half second); non-zero otherwise.
wait_until() {
  local deadline=$((SECONDS + $1))
  shift
  until "$@"; do
    [ $SECONDS -lt $deadline ] || return 1
    sleep 0.5
  done
}
has_answered() { [ "$(answered "$1")" -ge "$2" ]; }
has_begun() { [ "$(session_status "$1")" = RUNNING ] && [ -n "$(assistant_at "$1" "$2: the long turn has begun.")" ]; }
is_parked() { [ "$(session_status "$1")" = AWAITING_INPUT ] && has_answered "$1" "$2"; }
has_during() { [ -n "$(assistant_at "$1" "$2: written during the outage.")" ]; }

# open_sessions PHASE: on every runner, a session whose prompt is answered, then the message its engine holds open,
# begun. Sets sid and suuid.
open_sessions() {
  local phase=$1 i created _
  write_scripts "$phase"
  for i in $(runners); do
    created=""
    for _ in $(seq 1 12); do
      created="$(api session "$(workspace_id "$i")" "Mass disconnect drill, $phase: runner r$i's session" 2>>"$out/api-errors.log")" && break
      sleep 5
    done
    [ -n "$created" ] || fail "$phase: runner r$i's session could not be created (see $out/api-errors.log)"
    printf '%s\n' "$created" > "$(rdir "$i")/$phase.session.json"
    sid[$i]="$(json "$created" id)"
    suuid[$i]="$(json "$created" uuid)"
  done
  for i in $(runners); do
    wait_until 180 has_answered "${suuid[$i]}" 1 || fail "$phase: runner r$i's session ${sid[$i]} did not answer its prompt within 180 s"
  done
  for i in $(runners); do
    api turn "${sid[$i]}" "Mass disconnect drill, $phase: a turn held open across the outage" > /dev/null ||
      fail "$phase: sending runner r$i's session its message"
  done
  for i in $(runners); do
    wait_until 120 has_begun "${suuid[$i]}" "$phase" ||
      fail "$phase: runner r$i's session ${sid[$i]} is $(session_status "${suuid[$i]}"), its held turn not begun within 120 s"
  done
  say "$phase: $count sessions, one on each runner, each RUNNING a turn its engine holds open"
}

# --- The outage. ------------------------------------------------------------------------------------------------------
# kill_gateway / start_gateway: the link gateway node killed, as a crash or a lost host ends it, and started again. A
# kill is a stop to Docker, so its restart policy leaves it down until it is started.
gateway_down=0
kill_gateway() { gateway_down=1; docker kill "$gateway" > /dev/null; }
start_gateway() {
  local deadline=$((SECONDS + 300)) health
  docker start "$gateway" > /dev/null
  gateway_down=0
  while :; do
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$gateway")"
    case "$health" in healthy|running) break ;; esac
    [ $SECONDS -lt $deadline ] || fail "$gateway is $health 300 s after it was started again"
    sleep 1
  done
}
# cut_off I...: every packet the processes of runners I... send dropped, whatever it is for: the link, HTTPS, anything.
# What reaches them still arrives, and their answers do not leave.
cut_off() {
  local i cg level
  nft add table inet "$nft_table"
  nft add chain inet "$nft_table" out '{ type filter hook output priority 0; policy accept; }'
  for i in "$@"; do
    cg="$(systemctl show -p ControlGroup --value "$(unit "$i")")"
    cg="${cg#/}"
    level="$(awk -F/ '{ print NF }' <<< "$cg")"
    nft add rule inet "$nft_table" out socket cgroupv2 level "$level" "\"$cg\"" counter drop
  done
}
reconnect() { nft delete table inet "$nft_table" 2>/dev/null || true; }
restore_stack() {
  reconnect
  if [ "$gateway_down" = 1 ]; then docker start "$gateway" > /dev/null || true; fi
}

# The samples an outage takes every 2 s: the sessions' statuses, each runner's silence, the cell as the reaper reads it.
declare -A statuses=() silence_max=()
sample() {
  local phase=$1 at kind a b i seen
  at="$(now)"
  while IFS=$'\t' read -r kind a b; do
    printf '%s\t%s\t%s\t%s\n' "$at" "$kind" "$a" "$b" >> "$out/$phase-samples.tsv"
    case "$kind" in
      S)
        for i in $(runners); do
          [ "${suuid[$i]}" = "$a" ] || continue
          seen="${statuses[$i]:-}"
          [ "${seen##* }" = "$b" ] || statuses[$i]="${seen:+$seen }$b"
        done ;;
      P)
        for i in $(runners); do
          [ "${rid[$i]}" = "$a" ] || continue
          if awk -v s="$b" -v m="${silence_max[$i]:-0}" 'BEGIN { exit !(s > m) }'; then silence_max[$i]="$b"; fi
        done ;;
    esac
  done < <(psql_rows "SELECT 'S', s.id::text, s.status::text FROM session s WHERE s.id IN ($(session_ids_sql))
    UNION ALL
    SELECT 'P', r.id::text, round(extract(epoch FROM now() - GREATEST(p.last_beat_at, r.last_heartbeat_at))::numeric, 1)::text
      FROM runner r LEFT JOIN runner_presence p ON p.runner_id = r.id WHERE r.id IN ($(runner_ids_sql))
    UNION ALL
    SELECT 'F', f.* FROM ($fleet_sql) f")
}

# --- The reaper's sweeps against the crossings. -----------------------------------------------------------------------
# A runner beats every 30 s from when it started and is past the offline line 90 s after its last beat; the reaper
# sweeps every 30 s on a timer. As both keep time with the same period, where a sweep falls against a runner's crossing
# is where it falls in the interval against the runner's beats: the same in every outage, whenever the cut comes.
#
# aim_cut RUN: for ORBIT_MASS_DISCONNECT_SWEEP_AFTER, the runners the partition cuts off, and the moment, chosen so that
# the reaper's first sweep after the first of them crosses the line falls that many seconds after the crossing. The
# sweeps are timed from the last one the reaper held. The first runner is the one whose crossings come closest to that
# long before a sweep; the others the ones whose beats come after its across the interval, as partition_runners spreads
# them; and the cut comes halfway between the last of their beats and its next one, so that its last beat is the oldest
# and no beat of theirs is on its way. Sets CUT, and sleeps until the cut is due.
aim_cut() {
  local run=$1 swept i plan due ahead spread
  swept="$(last_sweep)"
  [ -n "$swept" ] ||
    fail "$run: ORBIT_MASS_DISCONNECT_SWEEP_AFTER times the reaper's sweeps from the last one it held, and it has held none since it started: run the gateway phase first"
  plan="$(for i in $(runners); do printf '%s %s\n' "$i" "$(presence "$i" | cut -d' ' -f3)"; done | node -e '
    const [swept, after, cut, line, beat, sweep] = process.argv.slice(1).map((v, k) => (k ? Number(v) : Date.parse(v) / 1000));
    const mod = (a, m) => ((a % m) + m) % m;
    const beats = require("fs").readFileSync(0, "utf8").trim().split("\n")
      .map((l) => l.split(" ")).map(([i, at]) => ({ i, at: Date.parse(at) / 1000 }));
    const closest = (list, f) => list.reduce((x, y) => (f(y) < f(x) ? y : x));
    // How long after a runner is past the line the next sweep comes; how long after one runner another beats.
    const sweepAfter = (b) => mod(swept - (b.at + line), sweep);
    const beatsAfter = (b, a) => mod(b.at - a.at, beat);
    const first = closest(beats, (b) => Math.abs(sweepAfter(b) - after));
    const chosen = [first];
    for (let j = 1; j < cut; j += 1) {
      chosen.push(closest(beats.filter((b) => !chosen.includes(b)), (b) => Math.abs(beatsAfter(b, first) - (j * beat) / cut)));
    }
    const spread = Math.max(...chosen.map((b) => beatsAfter(b, first)));
    const soon = Date.now() / 1000 + 2;
    const due = soon + mod(first.at + (spread + beat) / 2 - soon, beat);
    console.log([chosen.map((b) => b.i).join(" "), due.toFixed(3), sweepAfter(first).toFixed(1), spread.toFixed(1)].join("\t"));
  ' "$swept" "$sweep_after" "$cut" "$offline_after" "$heartbeat" "$sweep_every")" || fail "$run: aiming the cut"
  IFS=$'\t' read -r CUT due ahead spread <<< "$plan"
  say "$run: aimed: the reaper's sweeps fall as the one it held at $swept did, every $sweep_every s. Runners $(for i in $CUT; do printf 'r%s ' "$i"; done)to be cut off at $(date -u -d "@$due" +%H:%M:%S.%3NZ): r${CUT%% *} crosses the offline line first, the reaper's next sweep $ahead s after it (asked: $sweep_after s), and the others' beats come up to $spread s after its"
  sleep "$(awk -v due="$due" -v now="$(date -u +%s.%N)" 'BEGIN { d = due - now; printf "%.3f", (d > 0 ? d : 0) }')"
}

# sweeps RUN RESTORE_AT: the sweeps the reaper held in RUN ($out/RUN-apiserver.log), each against the crossings of the
# offline line of the runners cut off ($out/RUN-crossings.tsv): one line "S AT AFTER PAST NEXT IN READING" a sweep since
# the first crossing: AFTER s after it, PAST runners cut off past the line then, the next one, NEXT, crossing IN s later,
# and what the reaper read. Then whether it held from the first crossing on: the first sweep after it held and named that
# runner's session, and so did every sweep after it until the control plane was back, none more than a sweep interval
# (and 5 s for a sweep's own work) after the crossing or the sweep before it. One line "V RUNNER CROSSED AFTER PAST
# SWEEPS WRONG": the first runner past the line and when, the first held sweep AFTER s later with PAST past the line
# then, how many sweeps held since, and what does not hold ("none" when all of it does).
sweeps() {
  node -e '
    const fs = require("fs");
    const [crossFile, logFile, restoreAt, every, slack] = process.argv.slice(1);
    const t = (at) => Date.parse(at) / 1000;
    const iso = (s) => new Date(s * 1000).toISOString();
    const crossings = fs.readFileSync(crossFile, "utf8").trim().split("\n").map((l) => l.split("\t"))
      .map(([name, at, session]) => ({ name, at: t(at), session })).sort((a, b) => a.at - b.at);
    const held = fs.readFileSync(logFile, "utf8").split("\n")
      .map((l) => /^(\S+) .*not reaping \d+ session\(s\) whose runner looks offline \(([^)]*)\): (.*)$/.exec(l))
      .filter(Boolean).map(([, at, ids, reading]) => ({ at: t(at), ids, reading }));
    const first = crossings[0];
    const since = held.filter((h) => h.at >= first.at);
    const past = (at) => crossings.filter((c) => c.at <= at).length;
    for (const h of since) {
      const next = crossings.find((c) => c.at > h.at);
      console.log(["S", iso(h.at), (h.at - first.at).toFixed(1), past(h.at), next ? next.name : "none",
        next ? (next.at - h.at).toFixed(1) : "none", h.reading].join("\t"));
    }
    const gap = Number(every) + Number(slack);
    const restore = t(restoreAt);
    const wrong = [];
    if (since.length === 0) wrong.push(`no sweep held after ${first.name} crossed the offline line`);
    else {
      const lag = since[0].at - first.at;
      if (lag > gap) wrong.push(`the first sweep held came ${lag.toFixed(1)} s after ${first.name} crossed the offline line`);
      if (!since[0].ids.includes(first.session)) wrong.push(`the first sweep held after ${first.name} crossed does not name its session`);
      since.forEach((h, k) => {
        if (k > 0 && h.at - since[k - 1].at > gap) wrong.push(`no sweep held from ${iso(since[k - 1].at)} to ${iso(h.at)}`);
      });
      const last = since.filter((h) => h.at <= restore).pop();
      if (!last || restore - last.at > gap) wrong.push(`no sweep held in the last ${gap} s before the restore`);
    }
    console.log(["V", first.name, iso(first.at), since.length ? (since[0].at - first.at).toFixed(1) : "none",
      since.length ? past(since[0].at) : "none", since.length, wrong.length ? wrong.join("; ") : "none"].join("\t"));
  ' "$out/$1-crossings.tsv" "$out/$1-apiserver.log" "$2" "$sweep_every" 5
}

# outage PHASE: one outage, as the phase lays it out. The sessions open and run a turn each, held open; the runners in
# CUT lose the control plane at once for ORBIT_MASS_DISCONNECT_SECONDS. Halfway through, every engine writes one event
# more, and the runners still connected end their turns. Then the control plane is back, and every runner cut off must
# be heard again, as the same process; every session must have stored what its engine wrote during the outage, end its
# turn and answer one message more; and the reaper, having held the silence of those cut off for an outage, must have
# reaped none of them, holding every sweep from the first crossing of its offline line on. Sets failed when any of it
# does not hold. Each run of the phase is numbered (gateway-1, partition-2, …), and names its sessions' release gates
# and its records.
outage() {
  local phase=$1 run i line since_at cut_at restore_at reading held_lines reaped_lines reason first_reading="" last_reading=""
  local held_count=0 most_held=0 reaped=0 passed=0 n verdict lead released=0 mid ends deadline
  local status_during final_status during_at turn_at ran_seqs rows distinct first last runtime starts told
  local kind a b c d e f first_past="" first_after="" past_then="" wrong=""
  local node_a="" node_b="" g at last_back="" late="" seen_late=""
  local -a why=() verdicts=() log_from=()
  local -A is_cut=() process0=() beat_cut=() crossing=() back=() reconnected=() before_cut=() is_late=()
  # Each run of a phase has a number: its sessions' release gates and texts, and its records, are its own.
  run="$phase-$(($(awk -F'\t' -v p="$phase" 'index($1, p "-") == 1' "$outages" | wc -l) + 1))"
  statuses=() silence_max=()
  : > "$out/$run-samples.tsv"
  since_at="$(now)"
  [ "$(json "$(api switch get)" required)" = true ] || fail "$run: RUNNER_LINK_REQUIRED is off: run prepare"
  for i in $(runners); do
    wait_presence "$i" 60 || fail "$run: runner r$i's presence does not say LINK"
  done
  quiet_cell "$run"
  open_sessions "$run"
  # A hint makes a runner beat at once, besides its beat every 30 s: the sessions just opened did, on every runner. One
  # interval more, and each runner's last beat before the cut is its own, wherever it falls in the interval.
  sleep $((heartbeat + 2))
  for i in $(runners); do
    process0[$i]="$(presence "$i" | cut -d' ' -f2)"
    log_from[$i]="$(log_lines "$i")"
  done
  sample "$run"
  if [ "$phase" = partition ] && [ -n "$sweep_after" ]; then aim_cut "$run"; fi
  if [ "$phase" = node ]; then
    # The runners the first node holds: those whose last beat came through it.
    node_a="$(node_of "$gateway")" node_b="$(node_of "$gateway_b")"
    CUT=""
    for i in $(runners); do
      read -r g at <<< "$(presence_node "$i")"
      if [ "$g" = "$node_a" ]; then CUT+="$i "; before_cut[$i]="$at"; fi
    done
    [ -n "$CUT" ] || fail "$run: no runner is connected through $gateway ($node_a)"
  fi
  for i in $CUT; do is_cut[$i]=1; done

  # The cut.
  if [ "$phase" = gateway ] || [ "$phase" = node ]; then kill_gateway; else cut_off $CUT; fi
  cut_at="$(now)"
  if [ "$phase" = gateway ]; then
    say "$run: $gateway killed: every runner has lost the link"
  elif [ "$phase" = node ]; then
    # Each runner cut off was last heard through the node just killed: by the beat its row holds a moment after the kill,
    # one that was on its way included, unless it is back through the other node already.
    sleep 1
    for i in $CUT; do
      read -r g at <<< "$(presence_node "$i")"
      if [ "$g" = "$node_a" ]; then beat_cut[$i]="$at"; else beat_cut[$i]="${before_cut[$i]}"; fi
    done
    say "$run: $gateway ($node_a) killed: runners $(for i in $CUT; do printf 'r%s ' "$i"; done)($(wc -w <<< "$CUT") of $count) lost the link and connect again through $gateway_b ($node_b), whose limiter lets $(setting STAGING_HANDSHAKE_BURST_B 400) handshakes through at once and $(setting STAGING_HANDSHAKE_RATE_B 200) a second after"
  else
    say "$run: runners $(for i in $CUT; do printf 'r%s ' "$i"; done)cut off, $(wc -w <<< "$CUT") of $count: every packet their processes send is dropped (nft table inet $nft_table)"
  fi

  # The outage, sampled every 2 s. Halfway, every engine writes its event during the outage, and the runners still
  # connected end their turns; and by then each runner cut off has been heard last for good, with a beat that was on its
  # way at the cut, so where it stood is read then: its last beat, and so when it crossed the reaper's offline line.
  mid=$((SECONDS + outage / 2))
  ends=$((SECONDS + outage))
  while [ $SECONDS -lt $ends ]; do
    sample "$run"
    # A runner the node held is back once its beat comes through the other.
    if [ "$phase" = node ]; then
      for i in $CUT; do
        [ -z "${back[$i]:-}" ] || continue
        read -r g at <<< "$(presence_node "$i")"
        if [ "$g" = "$node_b" ] && [[ "$at" > "$cut_at" ]]; then
          back[$i]="$at"
          say "$run: runner r$i back through $gateway_b at $at, $(awk -v a="$(epoch "${beat_cut[$i]}")" -v b="$(epoch "$at")" 'BEGIN { printf "%.1f", b - a }') s after its last beat through $gateway"
        fi
      done
    fi
    if [ "$released" = 0 ] && [ $SECONDS -ge $mid ]; then
      for i in $(runners); do
        release "$i" "$run-during"
        [ -n "${is_cut[$i]:-}" ] || release "$i" "$run-end"
      done
      released=1
      say "$run: halfway: every engine writes an event; the runners still connected end their turns"
      # A runner the node held may be back by now: its last beat before the cut was read at the cut.
      if [ "$phase" != node ]; then
        for i in $CUT; do
          beat_cut[$i]="$(presence "$i" | cut -d' ' -f3)"
          lead="$(awk -v a="$(epoch "$cut_at")" -v b="$(epoch "${beat_cut[$i]}")" 'BEGIN { printf "%.1f", a - b }')"
          crossing[$i]="$(date -u -d "@$(awk -v b="$(epoch "${beat_cut[$i]}")" -v o="$offline_after" 'BEGIN { printf "%.3f", b + o }')" +%Y-%m-%dT%H:%M:%S.%3NZ)"
          say "$run: runner r$i last beat at ${beat_cut[$i]}, $lead s before the cut: past the reaper's $offline_after s line at ${crossing[$i]}, +$(awk -v l="$lead" -v o="$offline_after" 'BEGIN { printf "%.1f", o - l }') s"
        done
      fi
    fi
    sleep 2
  done
  reading="$(fleet)"
  # The control plane is back from the moment the gateway starts, before it reports healthy.
  restore_at="$(now)"
  if [ "$phase" = gateway ] || [ "$phase" = node ]; then start_gateway; else reconnect; fi
  if [ "$phase" = gateway ] || [ "$phase" = node ]; then
    say "$run: $gateway started again at $restore_at, $(since "$cut_at") s after the kill, and healthy now; as the outage ended the reaper read ${reading#* } of ${reading% *} runners silent"
  else
    say "$run: the cut lifted at $restore_at, $(since "$cut_at") s after it began; as the outage ended the reaper read ${reading#* } of ${reading% *} runners silent"
  fi

  # Every runner cut off heard again, as the same process; the samples go on as long as that takes.
  deadline=$((SECONDS + 300))
  for i in $CUT; do
    # One the node held may be back through the other node already: that was its return.
    if [ "$phase" != node ] || [ -z "${back[$i]:-}" ]; then
      while :; do
        sample "$run"
        line="$(presence "$i")"
        if [ "${line%% *}" = LINK ] && [[ "${line##* }" > "$restore_at" ]]; then back[$i]="${line##* }"; break; fi
        [ $SECONDS -lt $deadline ] || break
        sleep 2
      done
    fi
    line="$(presence "$i")"
    reconnected[$i]="$(log_since "$i" "${log_from[$i]}" 'carries the work of process' | tail -n 1 | sed -nE 's/.*(after [^ ]+ without one).*/\1/p')"
    if [ -n "${back[$i]:-}" ]; then
      say "$run: runner r$i heard again at ${back[$i]}, $(awk -v a="$(epoch "$restore_at")" -v b="$(epoch "${back[$i]}")" 'BEGIN { printf "%.1f", b - a }') s after the restore, as process $(cut -d' ' -f2 <<< "$line"); its log: ${reconnected[$i]:-no reconnection}"
    else
      say "$run: runner r$i not heard again within 300 s of the restore (presence: $line)"
    fi
  done
  for i in $CUT; do
    while IFS= read -r line; do say "$run: runner r$i log: $line"; done < <(log_since "$i" "${log_from[$i]}" 'runner link: connection' | grep -E 'ended \(|carries the work' || true)
  done
  sample "$run"
  # The runners the node held that were out past the reaper's offline line: theirs are the crossings, and the last of
  # them back is when the control plane had them all again.
  if [ "$phase" = node ]; then
    for i in $CUT; do
      if [ -z "${back[$i]:-}" ] || awk -v a="$(epoch "${beat_cut[$i]}")" -v b="$(epoch "${back[$i]}")" -v o="$offline_after" 'BEGIN { exit !(b - a > o) }'; then
        is_late[$i]=1
        late+="r$i "
        crossing[$i]="$(date -u -d "@$(awk -v b="$(epoch "${beat_cut[$i]}")" -v o="$offline_after" 'BEGIN { printf "%.3f", b + o }')" +%Y-%m-%dT%H:%M:%S.%3NZ)"
        if [ -n "${back[$i]:-}" ] && [[ "${back[$i]}" > "$last_back" ]]; then last_back="${back[$i]}"; fi
      fi
    done
    [ -n "$last_back" ] || last_back="$restore_at"
    say "$run: back only past the reaper's $offline_after s line: ${late:-no runner}$([ -z "$late" ] || echo "; the last at $last_back")"
  fi

  # Every session: what its engine wrote during the outage stored, its turn ended, one message more answered.
  for i in $(runners); do wait_until 120 has_during "${suuid[$i]}" "$run" || true; done
  for i in $CUT; do release "$i" "$run-end"; done
  for i in $(runners); do wait_until 120 is_parked "${suuid[$i]}" 2 || true; done
  for i in $(runners); do
    if [ "$(session_status "${suuid[$i]}")" = AWAITING_INPUT ]; then
      api turn "${sid[$i]}" "Mass disconnect drill, $run: a message after the outage" > /dev/null ||
        say "$run: runner r$i's session refused a message after the outage"
    fi
  done
  for i in $(runners); do wait_until 120 is_parked "${suuid[$i]}" 3 || true; done

  # What the reaper did: the apiserver's log since the phase began.
  reaper_log "$since_at" > "$out/$run-apiserver.log"
  docker logs --timestamps --since "$since_at" "$gateway" > "$out/$run-link-gateway.log" 2>&1 || true
  held_lines="$(grep -E "$held_pattern" "$out/$run-apiserver.log" || true)"
  reaped_lines="$(grep -E 'reaped session [0-9a-f-]+ -> ' "$out/$run-apiserver.log" || true)"
  if [ -n "$held_lines" ]; then
    held_count="$(wc -l <<< "$held_lines")"
    most_held="$(sed -nE 's/.*not reaping ([0-9]+) session.*/\1/p' <<< "$held_lines" | sort -n | tail -n 1)"
    first_reading="$(head -n 1 <<< "$held_lines" | sed -E 's/.*whose runner looks offline \([^)]*\): //')"
    last_reading="$(tail -n 1 <<< "$held_lines" | sed -E 's/.*whose runner looks offline \([^)]*\): //')"
    say "$run: the reaper held $held_count sweep(s), from $(head -n 1 <<< "$held_lines" | cut -d' ' -f1) to $(tail -n 1 <<< "$held_lines" | cut -d' ' -f1); the first: \"$(head -n 1 <<< "$held_lines" | sed -E 's/^.*\[Reaper\] //')\"; the last: \"$last_reading\""
  else
    say "$run: the reaper held no sweep"
  fi
  if [ -n "$reaped_lines" ]; then
    while IFS= read -r line; do say "$run: apiserver: $(sed -E 's/^([^ ]+) .*\[Reaper\] /\1 /' <<< "$line")"; done <<< "$reaped_lines"
  fi
  # A hold the outage did not make (the startup grace, a heartbeat write that failed) says nothing of the mass silence.
  reason="$(sed -nE 's/.*whose runner looks offline \([^)]*\): //p' <<< "$held_lines" | grep -vE 'lost contact in a mass disconnection' | head -n 1 || true)"
  # The reaper's sweeps against the crossings: each held sweep since the first crossing, and whether it held from then on.
  for i in $CUT; do
    [ "$phase" != node ] || [ -n "${is_late[$i]:-}" ] || continue
    printf 'r%s\t%s\t%s\n' "$i" "${crossing[$i]}" "${suuid[$i]}"
  done > "$out/$run-crossings.tsv"
  if [ ! -s "$out/$run-crossings.tsv" ]; then
    wrong="no runner cut off was out past the offline line: slow the second node's handshakes (ORBIT_MASS_DISCONNECT_HANDSHAKE_RATE, _BURST)"
  else while IFS=$'\t' read -r kind a b c d e f; do
    case "$kind" in
      S) say "$run: sweep held at $a, +$b s after the first crossing: $c of the $(wc -w <<< "$CUT") runners cut off past the offline line$([ "$d" = none ] || echo ", $d crossing $e s later"); the reaper read: \"$f\"" ;;
      V) first_past="$a at $b" first_after="$c" past_then="$d" wrong="$f"
         if [ "$wrong" = none ]; then
           say "$run: the reaper held from the first crossing on: $a crossed the offline line first, at $b; the first sweep after it held $c s later, naming its session, with $d of the $(wc -w <<< "$CUT") runners cut off past the line; and so did every sweep after it until the control plane was back, $e in all"
         else
           say "$run: the reaper did not hold from the first crossing on ($a, at $b): $wrong"
         fi ;;
    esac
  done < <(sweeps "$run" "$([ "$phase" = node ] && echo "$last_back" || echo "$restore_at")")
  fi

  # Each session's account.
  for i in $(runners); do
    why=()
    n="$(grep -c -- "${suuid[$i]}" <<< "$held_lines" || true)"
    if grep -q -- "reaped session ${suuid[$i]} " <<< "$reaped_lines"; then
      why+=("reaped: $(grep -- "reaped session ${suuid[$i]} " <<< "$reaped_lines" | head -n 1 | sed -E 's/.*reaped session [0-9a-f-]+ //')")
      reaped=$((reaped + 1))
    fi
    status_during="${statuses[$i]:-}"
    turn_at="$(long_turn_answered_at "${suuid[$i]}")"
    if [ -n "${is_cut[$i]:-}" ]; then
      [ "$status_during" = RUNNING ] || why+=("was ${status_during:-never read} while out of reach, not RUNNING throughout")
      # A runner the node held that was back within seconds was never past the line, and is not asked to be: the
      # outage's own verdict asks that some runner was.
      [ "$phase" = node ] || awk -v s="${silence_max[$i]:-0}" -v l="$offline_after" 'BEGIN { exit !(s > l) }' ||
        why+=("silent for ${silence_max[$i]:-0} s at most: never past the reaper's $offline_after s line")
      if [ "$n" = 0 ] && [ "$most_held" -le 10 ] && { [ "$phase" != node ] ||
        awk -v s="${silence_max[$i]:-0}" -v l="$((offline_after + sweep_every + 5))" 'BEGIN { exit !(s > l) }'; }; then
        why+=("named in no sweep the reaper held")
      fi
      [ -n "${back[$i]:-}" ] || why+=("not heard again within 300 s of the restore")
      line="$(presence "$i")"
      [ "$(cut -d' ' -f2 <<< "$line")" = "${process0[$i]}" ] ||
        why+=("heard again as process $(cut -d' ' -f2 <<< "$line"), not ${process0[$i]}")
    else
      # Still connected: it went on working, and the cut never reached it.
      [[ "$status_during" =~ ^RUNNING( AWAITING_INPUT)?$ ]] || why+=("was ${status_during:-never read} during the outage")
      [ -n "$turn_at" ] && [[ "$turn_at" < "$restore_at" ]] || why+=("its turn was not answered during the outage")
      if awk -v s="${silence_max[$i]:-0}" -v l="$heartbeat" 'BEGIN { exit !(s > 2 * l) }'; then
        why+=("silent for ${silence_max[$i]} s though not cut off")
      fi
    fi
    during_at="$(assistant_at "${suuid[$i]}" "$run: written during the outage.")"
    if [ -z "$during_at" ]; then
      why+=("what its engine wrote during the outage was not stored")
    elif [ -n "${is_cut[$i]:-}" ] && [ "$phase" != node ] && [[ "$during_at" < "$restore_at" ]]; then
      why+=("what its engine wrote during the outage was stored at $during_at, before the restore")
    fi
    final_status="$(session_status "${suuid[$i]}")"
    [ "$final_status" = AWAITING_INPUT ] || why+=("is $final_status after the outage, not AWAITING_INPUT")
    [ "$(answered "${suuid[$i]}")" -ge 3 ] || why+=("answered $(answered "${suuid[$i]}") of its 3 messages")
    ran_seqs="$(psql_value "SELECT count(*) || ' ' || count(DISTINCT seq) || ' ' || COALESCE(min(seq), 0) || ' ' || COALESCE(max(seq), 0) FROM run_event WHERE session_id = '${suuid[$i]}'")"
    read -r rows distinct first last <<< "$ran_seqs"
    [ "$rows" -gt 0 ] && [ "$rows" = "$distinct" ] && [ "$first" = 1 ] && [ "$last" = "$rows" ] ||
      why+=("stored seqs $ran_seqs (rows, distinct, min, max), not 1..N each once")
    runtime="$(psql_value "SELECT COALESCE(runtime_session_id, '') FROM session WHERE id = '${suuid[$i]}'")"
    starts="$(engine_starts "$i" "${runtime:-none}")"
    [ "$starts" = 1 ] || why+=("its engine started $starts times, not once")
    told="$(log_since "$i" "${log_from[$i]}" "no longer holds session" | grep -E -- "${suuid[$i]}|${sid[$i]}" | head -n 1 || true)"
    [ -z "$told" ] || why+=("its runner was told it no longer holds it: $told")
    if [ ${#why[@]} -eq 0 ]; then verdict=PASS; passed=$((passed + 1)); else verdict="$(printf '%s; ' "${why[@]}")"; verdict="${verdict%; }"; fi
    printf '%s\tr%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$run" "$i" "${suuid[$i]}" "${is_cut[$i]:+cut}" \
      "${silence_max[$i]:-}" "${crossing[$i]:-}" "$n" "$status_during" "${back[$i]:-}" "${reconnected[$i]:-}" \
      "$during_at" "$final_status" "$ran_seqs" "$verdict" >> "$sessions_table"
    if [ "$verdict" != PASS ]; then
      say "$run: r$i session ${sid[$i]}: $verdict"
    elif [ -n "${is_cut[$i]:-}" ]; then
      say "$run: r$i session ${sid[$i]} holds: RUNNING while out of reach, silent ${silence_max[$i]} s at most and held by the reaper in $n sweep(s); what its engine wrote then stored at $during_at; 3 messages answered; seqs $first..$last each once; its engine started once"
    else
      say "$run: r$i session ${sid[$i]} holds: connected throughout, its turn answered at $turn_at during the outage; 3 messages answered; seqs $first..$last each once; its engine started once"
    fi
  done

  [ "$reaped" = 0 ] || verdicts+=("$reaped session(s) reaped")
  [ "$held_count" -gt 0 ] || verdicts+=("the reaper held no sweep: the outage did not reach its offline line")
  [ -z "$reason" ] || verdicts+=("the reaper held for another reason than the mass disconnection: $reason")
  if [ "$phase" = node ]; then
    # The runners the node held come back one by one, so a late one may be back between two sweeps, unseen: what must
    # hold is that some runner was out past the line for longer than a sweep interval, which a sweep then read as
    # offline, and that each such runner's session was held (its own account, below).
    seen_late=""
    for i in $CUT; do
      if awk -v s="${silence_max[$i]:-0}" -v l="$((offline_after + sweep_every + 5))" 'BEGIN { exit !(s > l) }'; then seen_late+="r$i "; fi
    done
    say "$run: out past the offline line for longer than a sweep interval: ${seen_late:-no runner}"
    [ -n "$seen_late" ] ||
      verdicts+=("no runner the node held was out past the reaper's offline line for a whole sweep interval: slow the second node's handshakes (ORBIT_MASS_DISCONNECT_HANDSHAKE_RATE, _BURST)")
  else
    [ "$wrong" = none ] || verdicts+=("the reaper did not hold from the first crossing on: ${wrong:-the sweeps could not be read}")
  fi
  [ "$passed" = "$count" ] || verdicts+=("$((count - passed)) of $count sessions did not hold")
  if [ ${#verdicts[@]} -eq 0 ]; then verdict=PASS; else verdict="$(printf '%s; ' "${verdicts[@]}")"; verdict="${verdict%; }"; fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$run" "$count" "$(wc -w <<< "$CUT")" "$outage" "$cut_at" \
    "$restore_at" "$held_count" "$first_reading" "$first_past" "$first_after" "$past_then" "$reaped" "$passed/$count" \
    "$verdict" >> "$outages"
  if [ "$verdict" = PASS ]; then
    say "$run holds: $(wc -w <<< "$CUT") of $count runners out of reach for $outage s; the reaper held their silence in $held_count sweep(s) (\"$first_reading\"), from the first sweep after $first_past, $first_after s later, and reaped no session; every session ended its turn, stored what its engine wrote during the outage and answered its next message"
  else
    say "FAIL: $run: $verdict"
    failed=1
  fi
}

# --- Phases. ----------------------------------------------------------------------------------------------------------
prepare() {
  local i name token answer spacing
  rm -f "$timeline" "$outages" "$sessions_table"
  say "prepare: the stack $project in the cut-over state, built from $(git -C "$repo" rev-parse --short HEAD); $count runners; $gateways link gateway node(s)$([ "$gateways" = 1 ] || echo ", the second letting $handshake_burst handshakes through at once and $handshake_rate a second after")"
  stop_runners
  reconnect
  ORBIT_LINK_STAGING_MODE=http ORBIT_LINK_STAGING_BACKENDS=1 ORBIT_LINK_STAGING_GATEWAYS="$gateways" \
    ORBIT_LINK_STAGING_HANDSHAKE_RATE_B="$handshake_rate" ORBIT_LINK_STAGING_HANDSHAKE_BURST_B="$handshake_burst" \
    "$here/staging-up.sh" > "$out/prepare-staging-up.log" 2>&1 ||
    fail "staging-up.sh (see $out/prepare-staging-up.log)"
  stack_settings
  answer="$(api switch on)" || fail "switching RUNNER_LINK_REQUIRED on"
  [ "$(json "$answer" required)" = true ] || fail "RUNNER_LINK_REQUIRED is not on: $answer"
  say "stack $project up at $origin, its link gateway following the switch: RUNNER_LINK_REQUIRED $answer"

  # The runners and their engine: this checkout's runner, and the test suite's scripted claude, one binary each for all.
  rm -rf "$drill"
  mkdir -p "$drill/bin"
  (cd "$repo/src/runner-go" && go build -o "$drill/bin/orbit" . && go test -c -o "$drill/bin/orbit.test" .) \
    > "$out/prepare-build.log" 2>&1 || fail "building the runner and the scripted claude (see $out/prepare-build.log)"
  # A name of its own each time: a workspace's name is unique to its owner, and the last drill's stay on the stack.
  name="mass-disconnect-$(date -u +%m%d-%H%M%S)"
  for i in $(runners); do
    mkdir -p "$(rdir "$i")"/{home,orbit,fakebin,fake,empty,tmp,work}
    # The engine waits for its next message, and for its releases, as long as the drill lasts.
    cat > "$(rdir "$i")/fakebin/claude" <<EOF
#!/bin/sh
# The suite's scripted Claude CLI (src/runner-go/fake_claude_test.go), drill runner r$i's only engine.
case "\$1 \$2" in
"auth status") echo '{"loggedIn":true}'; exit 0 ;;
esac
ORBIT_FAKE_CLAUDE_DIR=$(rdir "$i")/fake ORBIT_FAKE_CLAUDE_WAIT=2h exec $drill/bin/orbit.test "\$@"
EOF
    chmod 755 "$(rdir "$i")/fakebin/claude"
    token="$(api enrollment-token "$name-r$i")" || fail "creating an enrollment token for runner r$i"
    runner_cmd "$i"
    "${RUNNER[@]}" register --server "$origin" --token "$(json "$token" token)" --name "$name-r$i" \
      --no-service --no-auto-install-engines < /dev/null > "$out/prepare-register-r$i.log" 2>&1 ||
      fail "registering runner r$i (see $out/prepare-register-r$i.log)"
  done
  load_runners
  # Started across one heartbeat interval: a runner beats every 30 s from when it starts, so the fleet's beats, and so
  # the moments its runners cross the reaper's offline line in an outage, are spread over the interval as a real
  # fleet's are, rather than bunched into the second all of them were started in.
  spacing="$(awk -v n="$count" -v hb="$heartbeat" 'BEGIN { printf "%.3f", hb / n }')"
  for i in $(runners); do
    start_runner "$i"
    say "runner r$i $name-r$i (${rid[$i]}) started as $(unit "$i"), pid $(systemctl show -p MainPID --value "$(unit "$i")")"
    [ "$i" = "$count" ] || sleep "$spacing"
  done
  for i in $(runners); do
    wait_log "$i" 'runner link mode: on' 0 180
    wait_presence "$i" 180 || fail "runner r$i's presence does not say LINK within 180 s"
    say "runner r$i: $(grep -m 1 -- 'runner link mode: on' "$(runner_log "$i")" | sed -E 's/.*(runner link mode: on — [^;]*);.*/\1/'); presence $(presence "$i")"
  done
  for i in $(runners); do
    api workspace "${rid[$i]}" "$(rdir "$i")/work" "$name-r$i" > "$(rdir "$i")/workspace.json" ||
      fail "creating runner r$i's workspace"
  done
  printf 'phase\trunners\tcut\toutage_s\tcut_at\trestore_at\tsweeps_held\treaper_reading\tfirst_past_offline_line\tfirst_held_sweep_after_s\tcut_past_line_then\treaped\tsessions_held\tverdict\n' > "$outages"
  printf 'phase\trunner\tsession\tcut\tsilence_max_s\tpast_offline_line_at\tsweeps_held\tstatus_during\theard_again_at\treconnect\tduring_event_stored_at\tstatus_after\tseqs\tverdict\n' > "$sessions_table"
  say "prepare holds: $count runners, each with a configuration directory and a unit of its own, working over the link"
}

# The runners the partition cuts off: spread across the fleet, and so across the heartbeat interval, as the runners a
# network cuts off are.
partition_runners() {
  local j
  for j in $(seq 0 $((cut - 1))); do echo $((1 + j * count / cut)); done | tr '\n' ' '
}

gateway_phase() {
  stack_settings
  load_runners
  local i
  for i in $(runners); do runner_running "$i" || fail "runner r$i is not running: run prepare"; done
  CUT="$(runners | tr '\n' ' ')"
  outage gateway
}

partition_phase() {
  stack_settings
  load_runners
  local i
  for i in $(runners); do runner_running "$i" || fail "runner r$i is not running: run prepare"; done
  CUT="$(partition_runners)"
  outage partition
}

node_phase() {
  stack_settings
  load_runners
  [ "$(setting STAGING_GATEWAYS 1)" = 2 ] ||
    fail "node: the stack has one link gateway node; prepare it with ORBIT_MASS_DISCONNECT_GATEWAYS=2"
  local i
  for i in $(runners); do runner_running "$i" || fail "runner r$i is not running: run prepare"; done
  outage node
}

summary() {
  say "summary: $(awk -F'\t' 'NR > 1 { printf "%s%s: %s of %s runners cut, %s sweeps held (the first %s s after %s, %s cut off past the line then), %s reaped, %s sessions held: %s", (NR > 2 ? "; " : ""), $1, $3, $2, $7, $10, $9, $11, $12, $13, $14 }' "$outages")"
}

case "${1:-}" in
  prepare|gateway|partition|node|all|stop) mkdir -p "$out" ;;
esac
trap restore_stack EXIT
failed=0
case "${1:-}" in
  prepare) prepare ;;
  gateway) gateway_phase; summary; exit "$failed" ;;
  partition) partition_phase; summary; exit "$failed" ;;
  node) node_phase; summary; exit "$failed" ;;
  all) prepare; gateway_phase; partition_phase; summary; exit "$failed" ;;
  stop) reconnect; stop_runners ;;
  -h|--help|"") sed -n '2,49p' "$0" ;;
  *) die "unknown phase $1 (see --help)" ;;
esac
