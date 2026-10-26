#!/usr/bin/env bash
# An engine that stops while the control plane cannot be reached (docs/runner-link-design.md §6.5, §10; task B9), drilled
# on a staging stack with a real runner. A session answers a message, the control plane goes down, and the session's idle
# engine stops inside the outage: the suite's scripted claude ends itself ORBIT_RELEASE_OUTAGE_ENGINE_IDLE after its last
# message, as an engine the pool recycles or one that crashes ends. Its inbox generation cannot be released then. What
# must hold: the session is not failed for it; once the control plane is back the generation is released, before the
# session takes any turn; the session answers its next message, once; and a control turn asked for during the outage is
# handed out once, to the session's next engine, and to nothing that fetched for the one that stopped.
#
#   release-outage-drill.sh prepare  The stack in shadow mode (MODE_HTTP), built from this checkout; the runner and the
#                                    suite's scripted claude built from ORBIT_RELEASE_OUTAGE_RUNNER_SRC; the runner
#                                    registered, working over HTTPS.
#   release-outage-drill.sh https    The apiserver killed for ORBIT_RELEASE_OUTAGE_SECONDS, the runner on HTTPS.
#   release-outage-drill.sh link     The stack in MODE_LINK and the runner on the link; the link gateway killed as long, the
#                                    apiserver up; a diff refresh asked for while it is down.
#   release-outage-drill.sh all      prepare, https, link.
#   release-outage-drill.sh stop     Stop the drill runner.
#
# Settings, besides the staging stack's own (staging-lib.sh, staging-up.sh):
#   ORBIT_RELEASE_OUTAGE_SECONDS      how long the control plane is down                              60
#   ORBIT_RELEASE_OUTAGE_ENGINE_IDLE  how long an idle engine lives (the scripted claude's
#                                     ORBIT_FAKE_CLAUDE_WAIT): it stops inside the outage               20s
#   ORBIT_RELEASE_OUTAGE_RUNNER_SRC   the checkout the runner and the scripted claude are built from   this one
#
# A runner built from before task B9 fails the drill: its session goes FAILED once one release has failed for 10 s.
#
# Run it as root (the runner runs in a mount namespace of its own, as lost-answer-drill.sh's does) on a stack no other
# runner works on. It needs docker, node, go and curl. The records go to <state>/client/release-outage/: timeline.txt is
# the drill's account and phases.tsv has a line per outage. The runner, its log and the scripted claude's records
# (spawns.jsonl, stdin.jsonl) are in <state>/release-outage-runner/; the runner keeps running after the drill until
# `release-outage-drill.sh stop`. It exits non-zero at the first step that does not hold.
set -euo pipefail
# shellcheck source=../staging-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../staging-lib.sh"

helper="$here/drills/rollback-drill.mjs"
out="$state/client/release-outage"
drill="$state/release-outage-runner"
timeline="$out/timeline.txt"
table="$out/phases.tsv"
outage="${ORBIT_RELEASE_OUTAGE_SECONDS:-60}"
engine_idle="${ORBIT_RELEASE_OUTAGE_ENGINE_IDLE:-20s}"
runner_src="${ORBIT_RELEASE_OUTAGE_RUNNER_SRC:-$repo}"
[[ "$outage" =~ ^[1-9][0-9]*$ ]] || die "ORBIT_RELEASE_OUTAGE_SECONDS must be a positive whole number, not $outage"
[[ "$engine_idle" =~ ^[1-9][0-9]*s$ ]] || die "ORBIT_RELEASE_OUTAGE_ENGINE_IDLE must be a whole number of seconds such as 20s, not $engine_idle"
[ "$outage" -ge $((${engine_idle%s} + 20)) ] ||
  die "ORBIT_RELEASE_OUTAGE_SECONDS ($outage) must outlast the engine's idle life ($engine_idle) by 20 s: one release fails after 10"

now() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
say() { echo "$(now) $*" | tee -a "$timeline" >&2; }
fail() { say "FAIL: $*"; die "$* (records in $out)"; }
json() { node -pe "const v = JSON.parse(process.argv[1]).$2; typeof v === 'object' ? JSON.stringify(v) : String(v)" "$1"; }
psql_value() { docker exec "$project-postgres" psql -U orbit -d orbit -tAc "$1"; }

# --- The stack and the runner, as prepare left them. ------------------------------------------------------------------
stack_settings() {
  [ -f "$env_file" ] || fail "no staging stack in $state: run prepare"
  origin="http://$(setting STAGING_BIND 127.0.0.1):$(setting STAGING_HTTP_PORT 18086)"
}
api() { node "$helper" "$origin" "$state" "$@"; }
runner_id() { node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).runnerId' "$drill/orbit/config.json"; }
workspace_id() { json "$(cat "$drill/workspace.json")" id; }

# The drill runner's binary, as the command `"${runner[@]}" ARGS...`: in an environment of its own, kept on its build
# (ORBIT_NO_SELFUPDATE), and in a mount namespace in which the engine installers' directories under this account's home
# show the scripted claude alone (lost-answer-drill.sh says why). Every step execs the next, so the command's pid is the
# runner's.
runner=(unshare -m --propagation private -- sh -c '
  drill=$1 home=$2
  shift 2
  if [ -d "$home/.local/bin" ]; then mount --bind "$drill/fakebin" "$home/.local/bin" || exit 1; fi
  for dir in .kimi-code/bin .opencode/bin; do
    if [ -d "$home/$dir" ]; then mount --bind "$drill/empty" "$home/$dir" || exit 1; fi
  done
  exec "$@"' sh "$drill" "$(getent passwd "$(id -u)" | cut -d: -f6)"
  env -i HOME="$drill/home" ORBIT_HOME="$drill/orbit" USER="$(id -un)" LOGNAME="$(id -un)"
  PATH="$drill/fakebin:/usr/sbin:/usr/bin:/sbin:/bin" SSL_CERT_FILE="$state/tls/ca-bundle.pem"
  ORBIT_NO_SELFUPDATE=1 ORBIT_NO_ENGINE_UPDATE=1 TMPDIR="$drill/tmp" "$drill/bin/orbit")
runner_pid() { cat "$drill/runner.pid" 2>/dev/null || true; }
runner_running() { local pid; pid="$(runner_pid)"; [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; }
stop_runner() {
  runner_running || return 0
  local pid deadline
  pid="$(runner_pid)"
  kill -TERM "$pid"
  deadline=$((SECONDS + 150))
  while kill -0 "$pid" 2>/dev/null; do
    if [ $SECONDS -ge $deadline ]; then kill -KILL "$pid"; break; fi
    sleep 1
  done
  say "drill runner stopped (pid $pid)"
}

# --- What the runner did. ---------------------------------------------------------------------------------------------
log_count() { grep -c -- "$1" "$drill/runner.log" || true; }
log_lines() { wc -l < "$drill/runner.log"; }
# wait_log PATTERN COUNT SECONDS: a runner log line matching PATTERN beyond the COUNT there were.
wait_log() {
  local deadline=$((SECONDS + $3))
  until [ "$(log_count "$1")" -gt "$2" ]; do
    [ $SECONDS -lt $deadline ] || fail "no new \"$1\" in the runner log within $3 s"
    runner_running || fail "the drill runner exited (see $drill/runner.log)"
    sleep 0.5
  done
  say "runner log: $(grep -- "$1" "$drill/runner.log" | tail -n 1)"
}
# log_since FROM PATTERN: the runner log lines after line FROM that hold PATTERN, as a fixed string.
log_since() { awk -v from="$1" -v p="$2" 'NR > from && index($0, p)' "$drill/runner.log"; }
# wait_presence STATE SECONDS: the runner's presence says its last beat came over STATE (HTTP or LINK).
wait_presence() {
  local deadline=$((SECONDS + $2)) id
  id="$(runner_id)"
  until [ "$(psql_value "SELECT link_state FROM runner_presence WHERE runner_id = '$id'")" = "$1" ]; do
    [ $SECONDS -lt $deadline ] || fail "the runner's presence does not say $1 within $2 s"
    sleep 1
  done
  say "presence: $(psql_value "SELECT link_state || ', gateway ' || COALESCE(gateway_id, 'none') || ', beat at ' || last_beat_at FROM runner_presence WHERE runner_id = '$id'")"
}
# executions TURN MARKER: how many times the turn ran, as five counts: the user messages holding MARKER written to the
# scripted claude's stdin, and the turn's events: the runner taking the turn (user), writing it to the engine
# (user_delivery written), the engine taking it (user_delivery acknowledged), and the turn ending (turn_end). A turn that
# ran once is "1 1 1 1 1".
executions() {
  local deliveries
  deliveries="$(awk -v marker="$2" 'index($0, "\"type\":\"user\"") && index($0, marker) { n++ } END { print n + 0 }' \
    "$drill/fake/stdin.jsonl")"
  echo "$deliveries $(psql_value "SELECT count(*) FILTER (WHERE type = 'user') || ' ' ||
    count(*) FILTER (WHERE type = 'user_delivery' AND payload->>'delivery' = 'written') || ' ' ||
    count(*) FILTER (WHERE type = 'user_delivery' AND payload->>'delivery' = 'acknowledged') || ' ' ||
    count(*) FILTER (WHERE type = 'turn_end') FROM run_event WHERE turn_id = '$1'")"
}
spawns() { if [ -f "$drill/fake/spawns.jsonl" ]; then wc -l < "$drill/fake/spawns.jsonl"; else echo 0; fi; }

# --- Sessions. --------------------------------------------------------------------------------------------------------
open_session() {
  local created="" _
  for _ in $(seq 1 12); do
    created="$(api session "$(workspace_id)" "$2" 2>>"$out/api-errors.log")" && break
    sleep 5
  done
  [ -n "$created" ] || fail "$1: the session could not be created (see $out/api-errors.log)"
  printf '%s\n' "$created"
}
# wait_answered LABEL SESSION_UUID COUNT: COUNT of the session's turns answered, within 180 s.
wait_answered() {
  local deadline=$((SECONDS + 180))
  until [ "$(psql_value "SELECT count(*) FROM conversation_turn WHERE session_id = '$2' AND kind = 'message' AND status = 'ANSWERED'")" -ge "$3" ]; do
    [ $SECONDS -lt $deadline ] || fail "$1: message $3 of session $2 is not answered within 180 s"
    runner_running || fail "the drill runner exited (see $drill/runner.log)"
    sleep 0.5
  done
}
turn_of() { psql_value "SELECT id FROM conversation_turn WHERE session_id = '$1' AND content LIKE '%$2%'"; }
session_status() { psql_value "SELECT status FROM session WHERE id = '$1'"; }

# --- The control plane going down and coming back. --------------------------------------------------------------------
# kill_container NAME: the container killed, as a crash or a lost host ends it. A kill is a stop to Docker, so its
# restart policy leaves it down until start_container.
kill_container() { docker kill "$1" > /dev/null; }
# start_container NAME SECONDS: the container started again and healthy (or running, without a health check).
start_container() {
  local deadline=$((SECONDS + $2)) health
  docker start "$1" > /dev/null
  while :; do
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1")"
    case "$health" in healthy|running) break ;; esac
    [ $SECONDS -lt $deadline ] || fail "$1 is $health $2 s after it was started again"
    sleep 1
  done
}

# outage PHASE CONTAINER: one outage on the session the phase opens. The session answers its prompt; CONTAINER is killed
# at once; the idle engine stops inside the outage and its release fails; after ORBIT_RELEASE_OUTAGE_SECONDS CONTAINER is
# started again. Then the release must land, the session must still be open, and a message must be answered once; over
# the link a diff refresh asked for during the outage must reach the session's next engine, once.
outage() {
  local phase=$1 container=$2 created sid suuid from spawns0 down_at back_at released_at statuses=() st diff="" diff_state
  local marker turn ran verdict="" failed_lines released_line engine_started answered_at generation handed_to
  created="$(open_session "$phase" "Release outage drill, $phase: the prompt")"
  sid="$(json "$created" id)"
  suuid="$(json "$created" uuid)"
  wait_answered "$phase" "$suuid" 1
  # The inbox generation of the engine that answered: the one that stops inside the outage.
  generation="$(psql_value "SELECT inbox_lease_generation FROM session WHERE id = '$suuid'")"
  spawns0="$(spawns)"
  from="$(log_lines)"
  kill_container "$container"
  down_at="$(now)"
  say "$phase: session $sid ($suuid) answered its prompt under inbox generation $generation; $container killed; its engine ends itself $engine_idle after its last message"
  if [ "$phase" = link ]; then
    # The apiserver is up: a person opens a file's diff in the session.
    api diff-refresh "$sid" > /dev/null || fail "$phase: asking for a diff refresh"
    diff="$(psql_value "SELECT id FROM conversation_turn WHERE session_id = '$suuid' AND kind = 'diff' ORDER BY seq DESC LIMIT 1")"
    [ -n "$diff" ] || fail "$phase: no diff turn was queued"
    say "$phase: diff refresh asked for: turn $diff, $(psql_value "SELECT status FROM conversation_turn WHERE id = '$diff'")"
  fi
  local ends=$((SECONDS + outage))
  while [ $SECONDS -lt $ends ]; do
    st="$(session_status "$suuid")"
    [ "${statuses[*]: -1}" = "$st" ] 2>/dev/null || statuses+=("$st")
    runner_running || fail "the drill runner exited (see $drill/runner.log)"
    sleep 2
  done
  local stopped
  stopped="$(log_since "$from" "inbox generation of $suuid not released yet" | head -n 1)"
  failed_lines="$(log_since "$from" "inbox generation cleanup after process stop failed for $suuid" | head -n 1)"
  say "$phase: during the outage the session was ${statuses[*]}; runner log: ${stopped:-no release retried}${failed_lines:+; $failed_lines}"
  [ -n "$diff" ] && say "$phase: the diff turn is $(psql_value "SELECT status FROM conversation_turn WHERE id = '$diff'") as the outage ends"
  start_container "$container" 300
  back_at="$(now)"
  say "$phase: $container is back"
  local deadline=$((SECONDS + 180))
  released_line=""
  until [ -n "$released_line" ]; do
    released_line="$(log_since "$from" "inbox generation of $suuid released" | head -n 1)"
    [ -n "$released_line" ] && break
    [ $SECONDS -lt $deadline ] || break
    [ "$(session_status "$suuid")" = FAILED ] && break
    runner_running || fail "the drill runner exited (see $drill/runner.log)"
    sleep 0.5
  done
  released_at="$(now)"
  st="$(session_status "$suuid")"
  say "$phase: the session is $st; runner log: ${released_line:-no release landed}; generation $generation retired at $(psql_value "SELECT COALESCE(retired_at::text, 'never') FROM inbox_lease_generation WHERE generation = '$generation'")"
  if [ -n "$diff" ]; then
    diff_state="$(psql_value "SELECT status FROM conversation_turn WHERE id = '$diff'")"
    say "$phase: the diff turn is $diff_state once the generation is released"
    [ "$diff_state" = PENDING ] || verdict+="the diff turn was $diff_state before the session's next engine; "
  fi
  [ -n "$stopped" ] || verdict+="no release retried during the outage (did the engine stop inside it?); "
  [ -z "$failed_lines" ] || verdict+="the runner gave the session up: $failed_lines; "
  [ -n "$released_line" ] || verdict+="no release landed within 180 s of $container coming back; "
  [ "$st" = AWAITING_INPUT ] || verdict+="the session is $st, not AWAITING_INPUT; "
  if [ -z "$verdict" ]; then
    marker="release-outage-$phase-$(date +%s%N)"
    api turn "$sid" "Release outage drill, $phase: after the outage: $marker" > /dev/null || fail "$phase: sending a message"
    wait_answered "$phase" "$suuid" 2
    turn="$(turn_of "$suuid" "$marker")"
    ran="$(executions "$turn" "$marker")"
    engine_started="$(psql_value "SELECT engine_started_at FROM session WHERE id = '$suuid'")"
    say "$phase: the message after the outage ran as \"$ran\" (stdin, user, written, acknowledged, turn_end); the session's engine started $(($(spawns) - spawns0)) time(s) since the outage began, last at $engine_started"
    [ "$ran" = "1 1 1 1 1" ] || verdict+="the message after the outage ran as \"$ran\", not once; "
    if [ -n "$diff" ]; then
      local deadline2=$((SECONDS + 60))
      until [ "$(psql_value "SELECT status FROM conversation_turn WHERE id = '$diff'")" = ANSWERED ] || [ $SECONDS -ge $deadline2 ]; do sleep 0.5; done
      answered_at="$(psql_value "SELECT answered_at FROM conversation_turn WHERE id = '$diff'")"
      # Handed out once the stopped engine's generation was retired, under a newer one live then: a control turn is
      # answered as it is handed out, so its answered_at is the hand-out.
      handed_to=""
      if [ -n "$answered_at" ]; then
        handed_to="$(psql_value "SELECT generation || ', activated at ' || activated_at FROM inbox_lease_generation
          WHERE session_id = '$suuid' AND generation <> '$generation' AND activated_at <= '$answered_at'::timestamp
            AND activated_at >= (SELECT retired_at FROM inbox_lease_generation WHERE generation = '$generation')
            AND (retired_at IS NULL OR retired_at >= '$answered_at'::timestamp)
          ORDER BY activated_at DESC LIMIT 1")"
      fi
      say "$phase: the diff turn is $(psql_value "SELECT status FROM conversation_turn WHERE id = '$diff'"), handed out at $answered_at, under generation ${handed_to:-none activated after the release}; handed over again in the runner log: $(log_since "$from" "turn $diff again" | wc -l) time(s)"
      [ -n "$answered_at" ] || verdict+="the diff turn was never handed out; "
      [ -z "$answered_at" ] || [ -n "$handed_to" ] ||
        verdict+="the diff turn was handed out at $answered_at, under no generation activated after $generation was retired; "
      [ "$(log_since "$from" "turn $diff again" | wc -l)" = 0 ] || verdict+="the diff turn was handed over twice; "
    fi
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$phase" "$suuid" "$down_at" "$back_at" "$released_at" \
    "${statuses[*]}" "$st" "${ran:--}" "${diff:--}" "${verdict:-PASS}" >> "$table"
  [ -z "$verdict" ] || fail "$phase: $verdict"
  say "$phase holds: the engine stopped inside an outage of $outage s, the session stayed open, its generation was released once $container was back, its next message ran once${diff:+, and the diff asked for during the outage reached its next engine once}"
}

# --- Phases. ----------------------------------------------------------------------------------------------------------
prepare() {
  local name
  rm -f "$timeline"
  say "prepare: the stack $project in shadow mode, built from $(git -C "$repo" rev-parse --short HEAD); the runner from $runner_src ($(git -C "$runner_src" rev-parse --short HEAD), $(git -C "$runner_src" status --short -- src/runner-go | wc -l) files changed)"
  stop_runner
  ORBIT_LINK_STAGING_MODE=http ORBIT_LINK_STAGING_BACKENDS=1 "$here/staging-up.sh" > "$out/prepare-staging-up.log" 2>&1 ||
    fail "staging-up.sh (see $out/prepare-staging-up.log)"
  stack_settings
  say "stack $project up at $origin"
  rm -rf "$drill"
  mkdir -p "$drill/bin" "$drill/home" "$drill/orbit" "$drill/fakebin" "$drill/fake" "$drill/empty" "$drill/tmp" "$drill/work"
  (cd "$runner_src/src/runner-go" && go build -o "$drill/bin/orbit" . && go test -c -o "$drill/fake/orbit.test" .) \
    > "$out/prepare-build.log" 2>&1 || fail "building the runner and the scripted claude (see $out/prepare-build.log)"
  # The engine ends itself $engine_idle after its last message: inside an outage that begins as its turn is answered.
  cat > "$drill/fakebin/claude" <<EOF
#!/bin/sh
# The suite's scripted Claude CLI (src/runner-go/fake_claude_test.go), the drill runner's only engine.
case "\$1 \$2" in
"auth status") echo '{"loggedIn":true}'; exit 0 ;;
esac
ORBIT_FAKE_CLAUDE_DIR=$drill/fake ORBIT_FAKE_CLAUDE_WAIT=$engine_idle exec $drill/fake/orbit.test "\$@"
EOF
  chmod 755 "$drill/fakebin/claude"
  node -e '
    const steps = [];
    for (let n = 1; n <= 40; n += 1) {
      steps.push({ await: "user" }, { emit: "replay_user" });
      if (n === 1) steps.push({ emit: "system_init", version: "2.1.300" });
      steps.push({ emit: "assistant", text: `Turn ${n} answered.` }, { emit: "result", text: `Turn ${n} answered.` });
    }
    require("fs").writeFileSync(process.argv[1], JSON.stringify(steps));' "$drill/fake/script.json"
  name="release-outage-drill-$(date -u +%m%d-%H%M%S)"
  "${runner[@]}" register --server "$origin" --token "$(cat "$state/secrets/enrollment_token")" --name "$name" \
    --no-service --no-auto-install-engines < /dev/null > "$out/prepare-register.log" 2>&1 ||
    fail "registering the drill runner (see $out/prepare-register.log)"
  touch "$drill/runner.log"
  ( trap '' HUP; exec setsid "${runner[@]}" run ) < /dev/null >> "$drill/runner.log" 2>&1 &
  echo $! > "$drill/runner.pid"
  say "drill runner $name ($(runner_id)) started (pid $(runner_pid))"
  wait_presence HTTP 120
  api workspace "$(runner_id)" "$drill/work" "$name" > "$drill/workspace.json" || fail "creating the drill workspace"
  say "workspace: $(cat "$drill/workspace.json")"
  printf 'phase\tsession\tdown_at\tback_at\treleased_at\tduring\tafter\tnext_message\tdiff_turn\tverdict\n' > "$table"
  say "prepare holds: the runner works over HTTPS"
}

https_phase() {
  stack_settings
  runner_running || fail "the drill runner is not running: run prepare"
  [ "$(setting STAGING_MODE http)" = http ] || fail "the stack is in $(setting STAGING_MODE http) mode: run prepare"
  wait_presence HTTP 60
  outage https "$project-apiserver"
}

link_phase() {
  stack_settings
  runner_running || fail "the drill runner is not running: run prepare"
  local before
  before="$(log_count 'runner link mode: on')"
  if [ "$(setting STAGING_MODE http)" != link ]; then
    say "link: the stack to MODE_LINK"
    ORBIT_LINK_STAGING_MODE=link ORBIT_LINK_STAGING_BACKENDS=1 "$here/staging-up.sh" --no-build > "$out/link-staging-up.log" 2>&1 ||
      fail "staging-up.sh to MODE_LINK (see $out/link-staging-up.log)"
    wait_log 'runner link mode: on' "$before" 180
  fi
  wait_presence LINK 120
  # The long polls the runner opened over HTTPS before the switch (25 s at most) end there first.
  sleep 30
  outage link "$project-link-gateway"
}

summary() {
  say "summary: $(awk -F'\t' 'NR > 1 { printf "%s %s; ", $1, $10 }' "$table")"
}

case "${1:-}" in
  prepare|https|link|all|stop) mkdir -p "$out" ;;
esac
case "${1:-}" in
  prepare) prepare ;;
  https) https_phase; summary ;;
  link) link_phase; summary ;;
  all) prepare; https_phase; link_phase; summary ;;
  stop) stop_runner ;;
  -h|--help|"") sed -n '2,32p' "$0" ;;
  *) die "unknown phase $1 (see --help)" ;;
esac
