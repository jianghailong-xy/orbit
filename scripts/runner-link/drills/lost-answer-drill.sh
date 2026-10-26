#!/usr/bin/env bash
# An answer lost on its way to the runner (docs/runner-link-design.md §5.6, §10; task C1c), drilled on a staging stack
# with a real runner. The link gateway is set to lose answers (LINK_DRILL_LOSE_ANSWERS, src/link-gateway/drill.go): it
# has the apiserver's answer to a claim or an inbox fetch, the session or the turn it hands out committed, and cuts the
# runner's connection instead of relaying it. What must hold: the runner reconnects and gets the same session, or the
# same message, within ORBIT_LOST_ANSWER_BOUND seconds of the cut, not once a 300 s lease runs out, and runs it once.
#
#   lost-answer-drill.sh prepare  The stack in MODE_LINK, built from this checkout, its link gateway as a deployment runs
#                                 it; the runner and the suite's scripted claude built from this checkout too; the runner
#                                 registered, working over the link, and a baseline session answered.
#   lost-answer-drill.sh claim    The gateway set to lose ORBIT_LOST_ANSWER_ROUNDS claim answers. Each round opens a
#                                 session; the answer that claims it is lost; the runner sends the claim again and is
#                                 answered with the same session, whose prompt runs once.
#   lost-answer-drill.sh inbox    The gateway set to lose as many inbox answers. Each round sends the baseline session a
#                                 message; the answer that leases it is lost; the runner fetches again and is handed the
#                                 same turn, which runs once.
#   lost-answer-drill.sh restore  The gateway as the stack runs it, the setting gone: a session and a message answered,
#                                 and no answer lost.
#   lost-answer-drill.sh all      prepare, claim, inbox, restore.
#   lost-answer-drill.sh stop     Stop the drill runner.
#
# Settings, besides the staging stack's own (staging-lib.sh, staging-up.sh):
#   ORBIT_LOST_ANSWER_ROUNDS  answers lost per call                                  5
#   ORBIT_LOST_ANSWER_BOUND   seconds within which the same work must come back      5
#
# Run it as root (the runner runs in a mount namespace of its own, as rollback-drill.sh's does) on a stack no other
# runner works on. It needs docker, node, go and curl. The records go to <state>/client/lost-answer/: timeline.txt is
# the drill's account and rounds.tsv has a line per answer lost, beside the link gateway's log and metrics of each phase.
# The runner, its log and the scripted claude's records (spawns.jsonl, stdin.jsonl) are in <state>/lost-answer-runner/;
# the runner keeps running after the drill until `lost-answer-drill.sh stop`. It exits non-zero at the first step that
# does not hold.
set -euo pipefail
# shellcheck source=../staging-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../staging-lib.sh"

helper="$here/drills/rollback-drill.mjs"
overlay="$here/drills/lost-answer.compose.yml"
out="$state/client/lost-answer"
drill="$state/lost-answer-runner"
timeline="$out/timeline.txt"
table="$out/rounds.tsv"
gateway="$project-link-gateway"
rounds="${ORBIT_LOST_ANSWER_ROUNDS:-5}"
bound="${ORBIT_LOST_ANSWER_BOUND:-5}"
[[ "$rounds" =~ ^[1-9][0-9]*$ ]] || die "ORBIT_LOST_ANSWER_ROUNDS must be a positive whole number, not $rounds"
[[ "$bound" =~ ^[1-9][0-9]*$ ]] || die "ORBIT_LOST_ANSWER_BOUND must be a positive whole number of seconds, not $bound"

now() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
say() { echo "$(now) $*" | tee -a "$timeline" >&2; }
fail() { say "FAIL: $*"; die "$* (records in $out)"; }
json() { node -pe "const v = JSON.parse(process.argv[1]).$2; typeof v === 'object' ? JSON.stringify(v) : String(v)" "$1"; }
psql_value() { docker exec "$project-postgres" psql -U orbit -d orbit -tAc "$1"; }

# --- The stack and the runner, as prepare left them. ------------------------------------------------------------------
stack_settings() {
  [ -f "$env_file" ] || fail "no staging stack in $state: run prepare"
  origin="http://$(setting STAGING_BIND 127.0.0.1):$(setting STAGING_HTTP_PORT 18086)"
  metrics="http://127.0.0.1:$(setting STAGING_METRICS_PORT 19464)/metrics"
}
api() { node "$helper" "$origin" "$state" "$@"; }
runner_id() { node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).runnerId' "$drill/orbit/config.json"; }
workspace_id() { json "$(cat "$drill/workspace.json")" id; }
baseline() { json "$(cat "$drill/baseline.json")" "$1"; }

# The drill runner's binary, as the command `"${runner[@]}" ARGS...`: in an environment of its own, kept on this
# checkout's build (ORBIT_NO_SELFUPDATE), and in a mount namespace in which the engine installers' directories under this
# account's home show the scripted claude alone. The runner builds its engines' PATH from the account's home, not $HOME,
# so without it the runner would find this host's own CLIs, signed in to nothing here. Every step execs the next, so the
# command's pid is the runner's.
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
# connection_lines FROM: the runner's account of its link connection after line FROM of its log: each one that ended,
# and each that took the work over.
connection_lines() {
  awk -v from="$1" 'NR > from && /runner link: connection .*(ended \(|carries the work)/' "$drill/runner.log"
}
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
# The link gateway's count of calls it forwarded to the apiserver and had answered.
forwarded() { curl -fsS "$metrics" | awk '$1 == "link_backend_calls_total{kind=\"rpc\",result=\"answered\"}" { n = $2 } END { print n + 0 }'; }
# https_calls SINCE UNTIL: the runner daemon calls the web gateway served over HTTPS between SINCE and UNTIL, by when they
# ended (nginx logs a call when it ends). The drill runner is the only runner working on the stack.
https_calls() {
  docker logs --since "$1" --until "$2" "$project-gateway" 2>&1 | grep -cE '"(GET|POST) /api/runner/(heartbeat|sessions/)' || true
}
# spawns: how many times the scripted claude has been started, for any session.
spawns() { if [ -f "$drill/fake/spawns.jsonl" ]; then wc -l < "$drill/fake/spawns.jsonl"; else echo 0; fi; }
# executions TURN MARKER: how many times the turn ran, as five counts: the times its message, which holds MARKER, was
# written to the scripted claude's stdin, and its events: the runner taking the turn (user), writing it to the engine
# (user_delivery written), the engine taking it (user_delivery acknowledged), and the turn ending (turn_end). A turn
# that ran once is "1 1 1 1 1".
executions() {
  local deliveries
  deliveries="$(grep -c -- "$2" "$drill/fake/stdin.jsonl" || true)"
  echo "${deliveries:-0} $(psql_value "SELECT count(*) FILTER (WHERE type = 'user') || ' ' ||
    count(*) FILTER (WHERE type = 'user_delivery' AND payload->>'delivery' = 'written') || ' ' ||
    count(*) FILTER (WHERE type = 'user_delivery' AND payload->>'delivery' = 'acknowledged') || ' ' ||
    count(*) FILTER (WHERE type = 'turn_end') FROM run_event WHERE turn_id = '$1'")"
}

# --- Sessions. --------------------------------------------------------------------------------------------------------
# open_session LABEL PROMPT: a session on the drill runner; prints its {id, uuid}. The first one after the runner starts
# waits for its engines' first report.
open_session() {
  local created="" _
  for _ in $(seq 1 12); do
    created="$(api session "$(workspace_id)" "$2" 2>>"$out/api-errors.log")" && break
    sleep 5
  done
  [ -n "$created" ] || fail "$1: the session could not be created (see $out/api-errors.log)"
  printf '%s\n' "$created"
}
# wait_answered LABEL SESSION_UUID COUNT: COUNT of the session's turns answered, within 120 s.
wait_answered() {
  local deadline=$((SECONDS + 120))
  until [ "$(psql_value "SELECT count(*) FROM conversation_turn WHERE session_id = '$2' AND status = 'ANSWERED'")" -ge "$3" ]; do
    [ $SECONDS -lt $deadline ] || fail "$1: turn $3 of session $2 is not answered within 120 s"
    runner_running || fail "the drill runner exited (see $drill/runner.log)"
    sleep 0.5
  done
}
# turn_of SESSION_UUID MARKER: the session's turn whose content holds MARKER.
turn_of() { psql_value "SELECT id FROM conversation_turn WHERE session_id = '$1' AND content LIKE '%$2%'"; }

# --- The link gateway. ------------------------------------------------------------------------------------------------
# gateway_line SECONDS PATTERN...: the first line of the link gateway's log since it started that holds every PATTERN,
# as a fixed string, waited for up to SECONDS; nothing when none came.
gateway_line() {
  local deadline=$((SECONDS + $1)) line
  shift
  while :; do
    docker logs "$gateway" > "$out/.gateway.log" 2>&1 || true
    line="$(awk -v patterns="$(printf '%s\n' "$@")" '
      BEGIN { n = split(patterns, p, "\n") }
      { for (i = 1; i <= n; i++) if (p[i] != "" && index($0, p[i]) == 0) next; print; exit }' "$out/.gateway.log")"
    if [ -n "$line" ]; then
      printf '%s\n' "$line"
      return 0
    fi
    [ $SECONDS -lt $deadline ] || return 0
    sleep 0.5
  done
}
# field NAME LINE: NAME's value in a line of the link gateway's log, which Go's slog writes as key=value.
field() { sed -nE "s/^(.* )?$1=([^ ]*).*\$/\2/p" <<< "$2"; }
gateway_env() { docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$gateway" | grep '^LINK_DRILL_LOSE_ANSWERS=' || true; }
# set_gateway PHASE LOSE: the link gateway recreated with LINK_DRILL_LOSE_ANSWERS=LOSE over lost-answer.compose.yml, or,
# with LOSE empty, as the stack itself runs it, without the setting; done once the drill runner's work goes over the new
# one. A recreate drains the old gateway first, and on one node the runner has no gateway until the new one is up.
set_gateway() {
  local phase=$1 lose=$2 before files=() armed
  before="$(log_count 'carries the work of process')"
  if [ -n "$lose" ]; then
    say "$phase: the link gateway recreated with LINK_DRILL_LOSE_ANSWERS=$lose"
  else
    say "$phase: the link gateway recreated as the stack runs it, without LINK_DRILL_LOSE_ANSWERS"
  fi
  lock_state
  if [ -n "$lose" ]; then
    mapfile -t files < <(compose_files)
    env -i PATH="$PATH" HOME="${HOME:-/root}" ${DOCKER_HOST:+DOCKER_HOST="$DOCKER_HOST"} \
      ${DOCKER_CONFIG:+DOCKER_CONFIG="$DOCKER_CONFIG"} DRILL_LOSE_ANSWERS="$lose" \
      docker compose -p "$project" --project-directory "$repo" --env-file "$env_file" "${files[@]}" -f "$overlay" \
      --profile runner-link up -d --no-deps --no-build --force-recreate --wait link-gateway
  else
    compose --profile runner-link up -d --no-deps --no-build --force-recreate --wait link-gateway
  fi > "$out/$phase-compose.log" 2>&1 || fail "$phase: recreating the link gateway (see $out/$phase-compose.log)"
  [ "$(gateway_env)" = "${lose:+LINK_DRILL_LOSE_ANSWERS=$lose}" ] ||
    fail "$phase: the link gateway's environment says \"$(gateway_env)\""
  armed="$(gateway_line 10 'LINK_DRILL_LOSE_ANSWERS is set')"
  if [ -n "$lose" ]; then
    [ "$(field lose "$armed")" = "$lose" ] || fail "$phase: the link gateway did not say it loses $lose (its log: $armed)"
    say "link gateway: $armed"
  else
    [ -z "$armed" ] || fail "$phase: the link gateway says $armed"
    say "link gateway: started without LINK_DRILL_LOSE_ANSWERS, and its log says nothing of it"
  fi
  wait_log 'carries the work of process' "$before" 180
  # Its first heartbeat over the new connection, so that hints and presence follow it.
  sleep 3
}
# save_records PHASE: the link gateway's log and metrics, as the phase leaves them.
save_records() {
  docker logs "$gateway" > "$out/$1-link-gateway.log" 2>&1 || true
  curl -fsS "$metrics" > "$out/$1-metrics.txt" || true
}

# --- Phases. ----------------------------------------------------------------------------------------------------------
prepare() {
  local name created f0 f1 calls since until
  rm -f "$timeline" "$table"
  say "prepare: the stack $project in MODE_LINK, built from $(git -C "$repo" rev-parse --short HEAD)"
  stop_runner
  ORBIT_LINK_STAGING_MODE=link ORBIT_LINK_STAGING_BACKENDS=1 "$here/staging-up.sh" > "$out/prepare-staging-up.log" 2>&1 ||
    fail "staging-up.sh (see $out/prepare-staging-up.log)"
  stack_settings
  [ -z "$(gateway_env)" ] || fail "the stack's own link gateway says $(gateway_env)"
  say "stack $project up at $origin: the link gateway in MODE_LINK, without LINK_DRILL_LOSE_ANSWERS"

  # The runner and its engine: this checkout's runner, and the test suite's scripted claude.
  rm -rf "$drill"
  mkdir -p "$drill/bin" "$drill/home" "$drill/orbit" "$drill/fakebin" "$drill/fake" "$drill/empty" "$drill/tmp" "$drill/work"
  (cd "$repo/src/runner-go" && go build -o "$drill/bin/orbit" . && go test -c -o "$drill/fake/orbit.test" .) \
    > "$out/prepare-build.log" 2>&1 || fail "building the runner and the scripted claude (see $out/prepare-build.log)"
  # The engine waits for its next message for as long as the drill lasts: one that timed out between two turns would be
  # started again, and a second start of a session's engine would read as the session claimed twice.
  cat > "$drill/fakebin/claude" <<EOF
#!/bin/sh
# The suite's scripted Claude CLI (src/runner-go/fake_claude_test.go), the drill runner's only engine.
case "\$1 \$2" in
"auth status") echo '{"loggedIn":true}'; exit 0 ;;
esac
ORBIT_FAKE_CLAUDE_DIR=$drill/fake ORBIT_FAKE_CLAUDE_WAIT=2h exec $drill/fake/orbit.test "\$@"
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
  # A name of its own each time: a workspace's name is unique to its owner, and the last drill's stays on the stack.
  name="lost-answer-drill-$(date -u +%m%d-%H%M%S)"
  "${runner[@]}" register --server "$origin" --token "$(cat "$state/secrets/enrollment_token")" --name "$name" \
    --no-service --no-auto-install-engines < /dev/null > "$out/prepare-register.log" 2>&1 ||
    fail "registering the drill runner (see $out/prepare-register.log)"
  # Detached and deaf to SIGHUP, so it outlives this script. $! is the runner itself: setsid, in a process that leads no
  # process group, execs in place, as every step after it does.
  touch "$drill/runner.log"
  ( trap '' HUP; exec setsid "${runner[@]}" run ) < /dev/null >> "$drill/runner.log" 2>&1 &
  echo $! > "$drill/runner.pid"
  say "drill runner $name ($(runner_id)) started (pid $(runner_pid)), built from $(git -C "$repo" rev-parse --short HEAD)"
  wait_log 'runner link mode: on' 0 120
  wait_presence LINK 120
  # The long polls the runner opened over HTTPS as it started (25 s at most) end there, and a claim among them could
  # take the baseline session: the session waits for them.
  sleep 30
  api workspace "$(runner_id)" "$drill/work" "$name" > "$drill/workspace.json" || fail "creating the drill workspace"
  say "workspace: $(cat "$drill/workspace.json")"

  # A baseline: a session and a message, answered with every call over the link and none lost.
  f0="$(forwarded)"
  since="$(now)"
  created="$(open_session baseline "Lost answer drill, baseline: the prompt")"
  wait_answered baseline "$(json "$created" uuid)" 1
  api turn "$(json "$created" id)" "Lost answer drill, baseline: a message" > /dev/null || fail "baseline: sending a message"
  wait_answered baseline "$(json "$created" uuid)" 2
  until="$(now)"
  f1="$(forwarded)"
  calls="$(https_calls "$since" "$until")"
  printf '%s\n' "$created" > "$drill/baseline.json"
  say "baseline: session $(json "$created" id) ($(json "$created" uuid)), 2 turns answered; calls forwarded by the link gateway +$((f1 - f0)), runner daemon calls over HTTPS $calls"
  [ "$((f1 - f0))" -gt 0 ] && [ "$calls" = 0 ] || fail "baseline: the runner's work did not go over the link"
  printf 'phase\tround\tsession\tturn\trequest\tlost_at\tafter_ms\tanswer\tsame_work\tclaim_request_id\tspawns\texecutions\tverdict\n' > "$table"
  save_records prepare
  say "prepare holds: the runner works over the link"
}

# round_verdict LABEL AFTER_MS ANSWER SAME_WORK EXECUTIONS: PASS when the same work came back within the bound and ran
# once; the reasons it did not, otherwise.
round_verdict() {
  local why=()
  [ -n "$2" ] && [ "$2" -le $((bound * 1000)) ] || why+=("answered again after ${2:-?} ms, past ${bound} s")
  [ "$3" = 200 ] || why+=("answered again with ${3:-nothing}")
  [ "$4" = true ] || why+=("answered again with other work")
  [ "$5" = "1 1 1 1 1" ] || why+=("ran as \"$5\", not once (\"1 1 1 1 1\")")
  if [ ${#why[@]} -eq 0 ]; then echo PASS; else printf '%s; ' "${why[@]}"; fi
}

claim_round() {
  local n=$1 marker spawns0 from created sid suuid loss request again after_ms answer same turn ran claimed spawned verdict
  marker="lost-answer-claim-$n-$(date +%s%N)"
  spawns0="$(spawns)"
  from="$(log_lines)"
  created="$(open_session "claim $n" "Lost answer drill, claim round $n: $marker")"
  sid="$(json "$created" id)"
  suuid="$(json "$created" uuid)"
  loss="$(gateway_line 60 'drill: an answer is lost' 'call=claim ' "work=$suuid ")"
  [ -n "$loss" ] || fail "claim $n: no claim answer naming session $sid was lost within 60 s"
  request="$(field request "$loss")"
  say "claim $n: session $sid ($suuid); link gateway: $loss"
  again="$(gateway_line 60 'is answered again' 'call=claim ' "request=$request ")"
  [ -n "$again" ] || fail "claim $n: the claim $request was not answered again within 60 s"
  say "claim $n: link gateway: $again"
  after_ms="$(field after_ms "$again")"
  answer="$(field answer "$again")"
  same="$(field same_work "$again")"
  wait_answered "claim $n" "$suuid" 1
  turn="$(turn_of "$suuid" "$marker")"
  [ -n "$turn" ] || fail "claim $n: no turn of session $sid holds the prompt"
  ran="$(executions "$turn" "$marker")"
  claimed="$(psql_value "SELECT COALESCE(claim_request_id, 'none') FROM session WHERE id = '$suuid'")"
  spawned=$(($(spawns) - spawns0))
  while IFS= read -r line; do say "claim $n: runner log: $line"; done < <(connection_lines "$from")
  say "claim $n: the session's claim_request_id is $claimed; its engine started $spawned time(s); its prompt ran as \"$ran\" (stdin, user, written, acknowledged, turn_end); claimed to its engine's first event $(psql_value "SELECT round(extract(epoch FROM engine_started_at - run_claimed_at) * 1000) FROM session WHERE id = '$suuid'") ms"
  verdict="$(round_verdict "claim $n" "$after_ms" "$answer" "$same" "$ran")"
  [ "$claimed" = "$request" ] || verdict="${verdict/#PASS/}claimed under $claimed, not the request whose answer was lost; "
  [ "$spawned" = 1 ] || verdict="${verdict/#PASS/}its engine started $spawned times; "
  printf 'claim\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$n" "$suuid" "$turn" "$request" "$(field time "$loss")" \
    "$after_ms" "$answer" "$same" "$claimed" "$spawned" "$ran" "$verdict" >> "$table"
  [ "$verdict" = PASS ] || fail "claim $n: $verdict"
  say "claim $n holds: the same session came back ${after_ms} ms after the cut, and its prompt ran once"
}

inbox_round() {
  local n=$1 marker from base_id base_uuid turn loss request again after_ms answer same ran timing verdict
  marker="lost-answer-inbox-$n-$(date +%s%N)"
  base_id="$(baseline id)"
  base_uuid="$(baseline uuid)"
  from="$(log_lines)"
  api turn "$base_id" "Lost answer drill, inbox round $n: $marker" > /dev/null || fail "inbox $n: sending the message"
  turn="$(turn_of "$base_uuid" "$marker")"
  [ -n "$turn" ] || fail "inbox $n: no turn of session $base_id holds the message"
  loss="$(gateway_line 60 'drill: an answer is lost' 'call=inbox ' "work=$turn ")"
  [ -n "$loss" ] || fail "inbox $n: no inbox answer handing out turn $turn was lost within 60 s"
  request="$(field request "$loss")"
  say "inbox $n: turn $turn of session $base_id; link gateway: $loss"
  again="$(gateway_line 60 'is answered again' 'call=inbox ' "request=$request ")"
  [ -n "$again" ] || fail "inbox $n: the fetch $request was not answered again within 60 s"
  say "inbox $n: link gateway: $again"
  after_ms="$(field after_ms "$again")"
  answer="$(field answer "$again")"
  same="$(field same_work "$again")"
  local deadline=$((SECONDS + 120))
  until [ "$(psql_value "SELECT status FROM conversation_turn WHERE id = '$turn'")" = ANSWERED ]; do
    [ $SECONDS -lt $deadline ] || fail "inbox $n: turn $turn is not answered within 120 s"
    runner_running || fail "the drill runner exited (see $drill/runner.log)"
    sleep 0.5
  done
  ran="$(executions "$turn" "$marker")"
  timing="$(psql_value "SELECT round(extract(epoch FROM delivery_acknowledged_at - delivered_at) * 1000) || ' ms to its engine, ' ||
    round(extract(epoch FROM answered_at - delivered_at) * 1000) || ' ms to its answer' FROM conversation_turn WHERE id = '$turn'")"
  while IFS= read -r line; do say "inbox $n: runner log: $line"; done < <(connection_lines "$from")
  say "inbox $n: the message ran as \"$ran\" (stdin, user, written, acknowledged, turn_end); from its first lease: $timing"
  verdict="$(round_verdict "inbox $n" "$after_ms" "$answer" "$same" "$ran")"
  printf 'inbox\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$n" "$base_uuid" "$turn" "$request" "$(field time "$loss")" \
    "$after_ms" "$answer" "$same" "-" "-" "$ran" "$verdict" >> "$table"
  [ "$verdict" = PASS ] || fail "inbox $n: $verdict"
  say "inbox $n holds: the same message came back ${after_ms} ms after the cut, and ran once"
}

claim_phase() {
  stack_settings
  runner_running || fail "the drill runner is not running: run prepare"
  set_gateway claim "claim:$rounds"
  local n
  for n in $(seq 1 "$rounds"); do claim_round "$n"; done
  save_records claim
  [ "$(grep -c 'drill: an answer is lost' "$out/claim-link-gateway.log" || true)" = "$rounds" ] ||
    fail "claim: the link gateway lost $(grep -c 'drill: an answer is lost' "$out/claim-link-gateway.log" || true) answers, not $rounds"
  say "claim holds: $rounds claim answers lost; each time the same session came back within ${bound} s and its prompt ran once"
}

inbox_phase() {
  stack_settings
  runner_running || fail "the drill runner is not running: run prepare"
  set_gateway inbox "inbox:$rounds"
  local n
  for n in $(seq 1 "$rounds"); do inbox_round "$n"; done
  save_records inbox
  [ "$(grep -c 'drill: an answer is lost' "$out/inbox-link-gateway.log" || true)" = "$rounds" ] ||
    fail "inbox: the link gateway lost $(grep -c 'drill: an answer is lost' "$out/inbox-link-gateway.log" || true) answers, not $rounds"
  say "inbox holds: $rounds inbox answers lost; each time the same message came back within ${bound} s and ran once"
}

restore() {
  stack_settings
  runner_running || fail "the drill runner is not running: run prepare"
  set_gateway restore ""
  local from created
  from="$(log_lines)"
  created="$(open_session restore "Lost answer drill, restore: the prompt")"
  wait_answered restore "$(json "$created" uuid)" 1
  api turn "$(json "$created" id)" "Lost answer drill, restore: a message" > /dev/null || fail "restore: sending a message"
  wait_answered restore "$(json "$created" uuid)" 2
  save_records restore
  [ -z "$(grep 'drill:' "$out/restore-link-gateway.log" || true)" ] || fail "restore: the link gateway lost an answer"
  [ -z "$(grep 'reason="drill_lost_answer"' "$out/restore-metrics.txt" || true)" ] || fail "restore: the link gateway counts a drill's cut"
  [ -z "$(connection_lines "$from" | grep 'ended (' || true)" ] || fail "restore: the runner's connection ended"
  say "restore holds: session $(json "$created" id) answered its prompt and a message, the link gateway lost nothing and the runner's connection held"
}

summary() {
  local lost passed
  lost=$(($(wc -l < "$table") - 1))
  passed="$(awk -F'\t' 'NR > 1 && $13 == "PASS"' "$table" | wc -l)"
  say "summary: $passed of $lost lost answers came back within ${bound} s and ran once; after_ms by call: $(awk -F'\t' '
    NR > 1 { n[$1]++; s[$1] += $7; if ($7 > m[$1]) m[$1] = $7 }
    END { for (c in n) printf "%s max %d mean %d; ", c, m[c], s[c] / n[c] }' "$table")"
}

case "${1:-}" in
  prepare|claim|inbox|restore|all|stop) mkdir -p "$out" ;;
esac
case "${1:-}" in
  prepare) prepare ;;
  claim) claim_phase; summary ;;
  inbox) inbox_phase; summary ;;
  restore) restore ;;
  all) prepare; claim_phase; inbox_phase; restore; summary ;;
  stop) stop_runner ;;
  -h|--help|"") sed -n '2,32p' "$0" ;;
  *) die "unknown phase $1 (see --help)" ;;
esac
