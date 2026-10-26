#!/usr/bin/env bash
# The runner link cut-over's two rollbacks (docs/runner-link-design.md §11.4; task C3), drilled on a staging stack with a
# real runner kept busy by sessions. README.md beside this file is the runbook; this is its staging drill.
#
#   rollback-drill.sh prepare     vN-1 and vN as images: vN-1 is the release before (ORBIT_ROLLBACK_PREVIOUS, a commit),
#                                 vN this checkout's HEAD at the next version. The stack at vN, its /dl publishing vN with
#                                 vN-1 kept at /dl/previous, the switch off; a real runner installed from /dl as vN, with
#                                 self-update on, and a session answered over HTTPS.
#   rollback-drill.sh cutover     The switch on: the runner moves its work onto the link by itself, and a session is
#                                 answered there, every call of it forwarded by the link gateway.
#   rollback-drill.sh switch-off  The preferred rollback: the switch off. The runner goes back to HTTPS when the link says
#                                 MODE_HTTP, and a session is answered over HTTPS.
#   rollback-drill.sh version     The version rollback, from the cut-over state: the apiserver and the link gateway back
#                                 to vN-1, whose release pointer names vN rolled back, while /dl (the web image) stays. The
#                                 runner leaves the link, is assigned vN-1 marked as a rollback, installs it from
#                                 /dl/previous by itself and restarts into it, and a session is answered over HTTPS. Then
#                                 its next release check keeps it on vN-1, and the switch's row, which vN-1 does not read,
#                                 is set off for the stack's next deploy of vN.
#   rollback-drill.sh all         prepare, cutover, switch-off, cutover, version.
#   rollback-drill.sh stop        Stop the drill runner.
#
# Settings, besides the staging stack's own (staging-lib.sh, staging-up.sh):
#   ORBIT_ROLLBACK_PREVIOUS     vN-1: the commit of the release before this checkout's (prepare needs it)
#   ORBIT_ROLLBACK_VERSION      vN's version: this checkout's when it is newer than vN-1's, else vN-1's plus one patch
#   ORBIT_ROLLBACK_UPDATE_WAIT  seconds the version rollback waits for the runner's own release check   1500
#   ORBIT_ROLLBACK_UPDATE_NOW   1: press Update Runner Now rather than wait for that check (every 10 minutes)
#
# Run it as root (the runner runs in a mount namespace of its own: see `runner` below) on a stack no other runner works
# on. It needs docker, node, go, git and curl. The records go to <state>/client/rollback/ (timeline.txt is the drill's
# account), the runner and its log to <state>/rollback-runner/. It exits non-zero at the first step that does not hold.
set -euo pipefail
# shellcheck source=../staging-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../staging-lib.sh"

helper="$here/drills/rollback-drill.mjs"
out="$state/client/rollback"
drill="$state/rollback-runner"
work="$state/rollback-build"
timeline="$out/timeline.txt"

now() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
say() { echo "$(now) $*" | tee -a "$timeline" >&2; }
fail() { say "FAIL: $*"; die "$* (records in $out)"; }
json() { node -pe "const v = JSON.parse(process.argv[1]).$2; typeof v === 'object' ? JSON.stringify(v) : String(v)" "$1"; }
psql_value() { docker exec "$project-postgres" psql -U orbit -d orbit -tAc "$1"; }

# --- The stack, the releases and the runner, as prepare left them. ----------------------------------------------------
stack_settings() {
  [ -f "$env_file" ] || fail "no staging stack in $state: run prepare"
  origin="http://$(setting STAGING_BIND 127.0.0.1):$(setting STAGING_HTTP_PORT 18086)"
  metrics="http://127.0.0.1:$(setting STAGING_METRICS_PORT 19464)/metrics"
}
load_versions() {
  [ -f "$work/versions.env" ] || fail "no releases recorded in $work: run prepare"
  # shellcheck disable=SC1091
  source "$work/versions.env"
}
api() { node "$helper" "$origin" "$state" "$@"; }
runner_id() { node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).runnerId' "$drill/orbit/config.json"; }
workspace_id() { json "$(cat "$drill/workspace.json")" id; }

# The drill runner's binary, as the command `"${runner[@]}" ARGS...`: in an environment of its own (no
# ORBIT_NO_SELFUPDATE: the version rollback is its self-update) and a mount namespace in which the engine installers'
# directories under this account's home show the scripted claude alone. The runner builds its engines' PATH from the
# account's home, not $HOME, so without it the runner would find this host's own CLIs, signed in to nothing here. Every
# step execs the next, so the command's pid is the runner's.
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
  ORBIT_NO_ENGINE_UPDATE=1 TMPDIR="$drill/tmp" "$drill/bin/orbit")
case "$(uname -m)" in x86_64) platform=linux-x64 ;; aarch64) platform=linux-arm64 ;; *) platform="" ;; esac
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
# The link gateway's count of calls it forwarded to the apiserver and had answered (vN's gateway).
forwarded() { curl -fsS "$metrics" | awk '$1 == "link_backend_calls_total{kind=\"rpc\",result=\"answered\"}" { n = $2 } END { print n + 0 }'; }
# https_calls SINCE UNTIL: the runner daemon calls the web gateway served over HTTPS between SINCE and UNTIL, by when they
# ended (nginx logs a call when it ends). The drill runner is the only runner working on the stack.
https_calls() {
  docker logs --since "$1" --until "$2" "$project-gateway" 2>&1 | grep -cE '"(GET|POST) /api/runner/(heartbeat|sessions/)' || true
}

# session_round LABEL TURNS: a session on the drill runner, its prompt and TURNS messages more, each sent once the one
# before it is answered; every seq of its events stored once. Sets session_id, session_since and session_until.
session_round() {
  local label=$1 turns=$2 created="" n stored rows distinct first last
  session_since="$(now)"
  # The first session after the runner starts waits for its engines' first report.
  for _ in $(seq 1 12); do
    created="$(api session "$(workspace_id)" "Rollback drill, $label: the prompt" 2>>"$out/api-errors.log")" && break
    sleep 5
  done
  [ -n "$created" ] || fail "$label: the session could not be created (see $out/api-errors.log)"
  session_id="$(json "$created" id)"
  session_uuid="$(json "$created" uuid)"
  wait_answered "$label" 1
  for n in $(seq 1 "$turns"); do
    api turn "$session_id" "Rollback drill, $label: message $n" > /dev/null || fail "$label: sending message $n"
    wait_answered "$label" $((n + 1))
  done
  session_until="$(now)"
  stored="$(psql_value "SELECT count(*) || ' ' || count(DISTINCT seq) || ' ' || COALESCE(min(seq), 0) || ' ' || COALESCE(max(seq), 0) FROM run_event WHERE session_id = '$session_uuid'")"
  read -r rows distinct first last <<< "$stored"
  [ "$rows" -gt 0 ] && [ "$rows" = "$distinct" ] && [ "$first" = 1 ] && [ "$last" = "$rows" ] ||
    fail "$label: session $session_id stored seqs $stored (rows, distinct, min, max), not 1..N each once"
  say "$label: session $session_id ($session_uuid): $((turns + 1)) turns answered, events 1..$last each stored once"
}
wait_answered() {
  local deadline=$((SECONDS + 120))
  until [ "$(psql_value "SELECT count(*) FROM conversation_turn WHERE session_id = '$session_uuid' AND status = 'ANSWERED'")" -ge "$2" ]; do
    [ $SECONDS -lt $deadline ] || fail "$1: turn $2 of session $session_id is not answered within 120 s"
    runner_running || fail "the drill runner exited (see $drill/runner.log)"
    sleep 1
  done
}

# --- Phases. ----------------------------------------------------------------------------------------------------------
# export_tree SHA DIR: the files the three images are built from, at SHA.
export_tree() {
  rm -rf "$2"
  mkdir -p "$2"
  git -C "$repo" archive "$1" -- .dockerignore package.json package-lock.json tsconfig.base.json runner-release.json \
    contracts scripts src/apiserver src/shared src/web src/runner-go src/link-gateway | tar -x -C "$2"
}
# build_release DIR SHA VERSION [PREVIOUS_WEB_IMAGE]: the apiserver, link gateway and web images of a release, tagged
# <project>-<service>:VERSION. The web image keeps PREVIOUS_WEB_IMAGE's release at /dl/previous, as a deploy does.
build_release() {
  local tree=$1 sha=$2 version=$3 previous=${4:-} public_origin
  public_origin="http://${ORBIT_LINK_STAGING_HOST:-$(setting STAGING_HOST localhost)}:${ORBIT_LINK_STAGING_HTTP_PORT:-$(setting STAGING_HTTP_PORT 18086)}"
  say "building $version from ${sha:0:12}: apiserver, link gateway, web${previous:+, keeping release $previous at /dl/previous}"
  docker build --progress=plain -f "$tree/src/apiserver/Dockerfile" -t "$project-apiserver:$version" "$tree" \
    > "$out/build-$version-apiserver.log" 2>&1 || fail "building the $version apiserver (see $out/build-$version-apiserver.log)"
  docker build --progress=plain --build-arg ORBIT_SOURCE_SHA="$sha" -t "$project-link-gateway:$version" "$tree/src/link-gateway" \
    > "$out/build-$version-link-gateway.log" 2>&1 || fail "building the $version link gateway (see $out/build-$version-link-gateway.log)"
  docker build --progress=plain -f "$tree/src/web/Dockerfile" --build-arg PUBLIC_ORIGIN="$public_origin" \
    --build-arg ORBIT_SOURCE_SHA="$sha" ${previous:+--build-arg PREVIOUS_RELEASE_IMAGE="$project-web:$previous"} \
    -t "$project-web:$version" "$tree" > "$out/build-$version-web.log" 2>&1 ||
    fail "building the $version web image (see $out/build-$version-web.log)"
}

prepare() {
  local previous next_sha prev_sha prev_version next_version tree want answer name
  previous="${ORBIT_ROLLBACK_PREVIOUS:?set ORBIT_ROLLBACK_PREVIOUS to the commit of the release before this checkout}"
  prev_sha="$(git -C "$repo" rev-parse --verify "$previous^{commit}")"
  next_sha="$(git -C "$repo" rev-parse HEAD)"
  prev_version="$(git -C "$repo" show "$prev_sha:package.json" | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).version')"
  next_version="${ORBIT_ROLLBACK_VERSION:-$(node -pe '
    const [prev, head] = process.argv.slice(1);
    const newer = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number);
      for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
      return false; };
    newer(head, prev) ? head : prev.replace(/\d+$/, (n) => String(Number(n) + 1))' \
    "$prev_version" "$(node -pe 'require(process.argv[1]).version' "$repo/package.json")")}"
  [ "$(printf '%s\n%s\n' "$prev_version" "$next_version" | sort -V | tail -n 1)" = "$next_version" ] && [ "$prev_version" != "$next_version" ] ||
    fail "vN ($next_version) must be newer than vN-1 ($prev_version)"
  rm -f "$timeline"
  say "prepare: vN-1 is $prev_version at $prev_sha ($previous); vN is $next_version at $next_sha"
  mkdir -p "$work"
  stop_runner

  # vN-1, its release pointer naming vN rolled back: what the version rollback deploys. Built now, so that the rollback
  # is a recreate rather than a build.
  tree="$work/src/$prev_version"
  export_tree "$prev_sha" "$tree"
  printf '{\n  "rolloutPercent": 100,\n  "rollback": "%s"\n}\n' "$next_version" > "$tree/runner-release.json"
  build_release "$tree" "$prev_sha" "$prev_version"
  # vN: this checkout at vN's version, its /dl keeping vN-1's release at /dl/previous.
  tree="$work/src/$next_version"
  export_tree "$next_sha" "$tree"
  node -e 'const fs = require("fs"); const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    p.version = process.argv[2]; fs.writeFileSync(process.argv[1], JSON.stringify(p, null, 2) + "\n");' "$tree/package.json" "$next_version"
  build_release "$tree" "$next_sha" "$next_version" "$prev_version"
  cat > "$work/versions.env" <<EOF
PREV_REF=$previous
PREV_SHA=$prev_sha
PREV_VERSION=$prev_version
NEXT_SHA=$next_sha
NEXT_VERSION=$next_version
EOF

  # The stack at vN, under the names Compose runs, its gateway following the switch.
  docker tag "$project-apiserver:$next_version" "$project-apiserver:local"
  docker tag "$project-link-gateway:$next_version" "$project-link-gateway:local"
  docker tag "$project-web:$next_version" "$project-web:latest"
  ORBIT_LINK_STAGING_MODE=http ORBIT_LINK_STAGING_BACKENDS=1 "$here/staging-up.sh" --no-build > "$out/prepare-staging-up.log" 2>&1 ||
    fail "staging-up.sh (see $out/prepare-staging-up.log)"
  stack_settings
  answer="$(api switch off)" || fail "switching RUNNER_LINK_REQUIRED off"
  say "stack $project at $next_version: RUNNER_LINK_REQUIRED $answer"
  curl -fsS "$origin/dl/version.json" > "$out/dl-version.json"
  curl -fsS "$origin/dl/previous/version.json" > "$out/dl-previous-version.json"
  [ "$(json "$(cat "$out/dl-version.json")" version)" = "$next_version" ] || fail "/dl/version.json does not publish $next_version"
  [ "$(json "$(cat "$out/dl-previous-version.json")" version)" = "$prev_version" ] || fail "/dl/previous/version.json does not publish $prev_version"
  [ "$(json "$(cat "$out/dl-previous-version.json")" runsAssignedRelease)" = true ] ||
    fail "$prev_version predates assigned releases: a runner would not roll back to it"
  say "/dl publishes $next_version, and $prev_version at /dl/previous (runsAssignedRelease)"

  # The runner: installed from /dl as install.sh installs it, with the suite's scripted claude as its only engine.
  [ -n "$platform" ] || fail "no runner build for $(uname -m)"
  rm -rf "$drill"
  mkdir -p "$drill/bin" "$drill/home" "$drill/orbit" "$drill/fakebin" "$drill/fake" "$drill/empty" "$drill/tmp" "$drill/work"
  curl -fsS -o "$drill/orbit.gz" "$origin/dl/orbit-$platform.gz"
  want="$(json "$(cat "$out/dl-version.json")" "assets['$platform'].sha256")"
  [ "$(sha256sum "$drill/orbit.gz" | cut -d' ' -f1)" = "$want" ] || fail "the downloaded runner does not match /dl/version.json"
  gunzip -c "$drill/orbit.gz" > "$drill/bin/orbit"
  chmod 755 "$drill/bin/orbit"
  (cd "$repo/src/runner-go" && go test -c -o "$drill/fake/orbit.test" .) > "$out/prepare-fake-claude.log" 2>&1 ||
    fail "building the scripted claude (see $out/prepare-fake-claude.log)"
  cat > "$drill/fakebin/claude" <<EOF
#!/bin/sh
# The suite's scripted Claude CLI (src/runner-go/fake_claude_test.go), the drill runner's only engine.
case "\$1 \$2" in
"auth status") echo '{"loggedIn":true}'; exit 0 ;;
esac
ORBIT_FAKE_CLAUDE_DIR=$drill/fake exec $drill/fake/orbit.test "\$@"
EOF
  chmod 755 "$drill/fakebin/claude"
  node -e '
    const steps = [];
    for (let n = 1; n <= 6; n += 1) {
      steps.push({ await: "user" }, { emit: "replay_user" });
      if (n === 1) steps.push({ emit: "system_init", version: "2.1.300" });
      steps.push({ emit: "thinking", text: `Turn ${n}: weighing <this> & that` },
        { emit: "assistant", text: `Turn ${n}: <b>bold</b> & "quotes"` },
        { emit: "tool_use", toolUseId: `toolu_0${n}`, toolName: "Bash", input: { command: "echo hi", description: "greet" } },
        { emit: "tool_result", toolUseId: `toolu_0${n}`, text: "hi" },
        { emit: "assistant", text: `Done with turn ${n}.` },
        { emit: "result", text: `Done with turn ${n}.` });
    }
    require("fs").writeFileSync(process.argv[1], JSON.stringify(steps));' "$drill/fake/script.json"
  # A name of its own each time: a workspace's name is unique to its owner, and the last drill's stays on the stack.
  name="rollback-drill-$(date -u +%m%d-%H%M%S)"
  "${runner[@]}" register --server "$origin" --token "$(cat "$state/secrets/enrollment_token")" --name "$name" \
    --no-service --no-auto-install-engines < /dev/null > "$out/prepare-register.log" 2>&1 ||
    fail "registering the drill runner (see $out/prepare-register.log)"
  # Detached and deaf to SIGHUP, so it outlives this script. $! is the runner itself: setsid, in a process that leads no
  # process group, execs in place, as every step after it does.
  touch "$drill/runner.log"
  ( trap '' HUP; exec setsid "${runner[@]}" run ) < /dev/null >> "$drill/runner.log" 2>&1 &
  echo $! > "$drill/runner.pid"
  say "drill runner $name ($(runner_id)) started (pid $(runner_pid)), $("$drill/bin/orbit" version)"
  wait_presence HTTP 120
  api workspace "$(runner_id)" "$drill/work" "$name" > "$drill/workspace.json" || fail "creating the drill workspace"
  say "workspace: $(cat "$drill/workspace.json")"
  local f0 f1 calls
  f0="$(forwarded)"
  session_round baseline 1
  f1="$(forwarded)"
  calls="$(https_calls "$session_since" "$session_until")"
  say "baseline: calls forwarded by the link gateway +$((f1 - f0)); runner daemon calls over HTTPS $calls"
  [ "$((f1 - f0))" = 0 ] && [ "$calls" -gt 0 ] || fail "baseline: the runner's work did not go over HTTPS"
  say "prepare holds: the stack and the runner at $next_version, working over HTTPS"
}

cutover() {
  load_versions
  stack_settings
  runner_running || fail "the drill runner is not running: run prepare"
  local before answer f0 f1 calls
  before="$(log_count 'runner link mode: on')"
  answer="$(api switch on)" || fail "switching RUNNER_LINK_REQUIRED on"
  say "cutover: RUNNER_LINK_REQUIRED $answer"
  wait_log 'runner link mode: on' "$before" 90
  # The long polls the runner opened over HTTPS before it moved (25 s at most) end there, and a claim among them can hand
  # it a session. The session starts once they have ended, so that all of its work goes over the link.
  sleep 30
  wait_presence LINK 90
  f0="$(forwarded)"
  session_round "cutover-$((before + 1))" 3
  f1="$(forwarded)"
  calls="$(https_calls "$session_since" "$session_until")"
  say "cutover: calls forwarded by the link gateway +$((f1 - f0)); runner daemon calls over HTTPS $calls"
  [ "$((f1 - f0))" -gt 0 ] && [ "$calls" = 0 ] || fail "cutover: the runner's work did not go over the link"
  say "cutover holds: the runner works over the link"
}

switch_off() {
  load_versions
  stack_settings
  runner_running || fail "the drill runner is not running: run prepare"
  local before since answer told f0 f1 calls
  before="$(log_count 'runner link mode: off')"
  since="$(now)"
  answer="$(api switch off)" || fail "switching RUNNER_LINK_REQUIRED off"
  say "switch-off: RUNNER_LINK_REQUIRED $answer"
  # The runner's line names what told it: a HeartbeatAck or a Welcome saying MODE_HTTP, or a call refused LINK_MODE_HTTP.
  wait_log 'runner link mode: off' "$before" 90
  docker logs --since "$since" "$project-link-gateway" > "$out/switch-off-link-gateway.log" 2>&1
  told="$(grep -m 1 -E 'dir=out frame="#[0-9]+ ((welcome|heartbeat_ack) .*mode=MODE_HTTP|rpc_result .*failure=LINK_MODE_HTTP)' \
    "$out/switch-off-link-gateway.log" || true)"
  [ -n "$told" ] || fail "the link gateway logged no frame telling the runner MODE_HTTP after the switch went off"
  say "link gateway: $told"
  wait_presence HTTP 90
  f0="$(forwarded)"
  session_round switch-off 3
  f1="$(forwarded)"
  calls="$(https_calls "$session_since" "$session_until")"
  say "switch-off: calls forwarded by the link gateway +$((f1 - f0)); runner daemon calls over HTTPS $calls"
  [ "$((f1 - f0))" = 0 ] && [ "$calls" -gt 0 ] || fail "switch-off: the runner's work did not go back to HTTPS"
  say "switch-off holds: the runner works over HTTPS again"
}

version_rollback() {
  load_versions
  stack_settings
  runner_running || fail "the drill runner is not running: run prepare"
  [ "$(psql_value "SELECT required FROM runner_link_switch WHERE id = 1")" = t ] &&
    [ "$(grep -o 'runner link mode: o[nf]*' "$drill/runner.log" | tail -n 1)" = 'runner link mode: on' ] ||
    fail "the version rollback starts from the cut-over state: run cutover first"
  local off rolled updated downloads swap_since started release answer status installed published since checks calls row
  off="$(log_count 'runner link mode: off')"
  rolled="$(log_count " -> $PREV_VERSION: the control plane rolled $NEXT_VERSION back")"
  updated="$(log_count "orbit updated to $PREV_VERSION")"
  downloads="$(log_count ' -> .*downloading')"

  # The server back to vN-1: the images prepare built, its release pointer naming vN rolled back. The web image, and /dl
  # with it, stays: /dl keeps publishing vN and vN-1, which the pointer chooses between.
  lock_state
  docker tag "$project-apiserver:$PREV_VERSION" "$project-apiserver:local"
  docker tag "$project-link-gateway:$PREV_VERSION" "$project-link-gateway:local"
  swap_since="$(now)"
  started=$SECONDS
  say "version: the apiserver and the link gateway back to $PREV_VERSION (${PREV_SHA:0:12}), the pointer rolling $NEXT_VERSION back; web and /dl stay at $NEXT_VERSION"
  compose --profile runner-link up -d --no-deps --no-build --force-recreate --wait --wait-timeout 900 apiserver link-gateway \
    > "$out/version-compose.log" 2>&1 || fail "recreating the apiserver and the link gateway (see $out/version-compose.log)"
  say "version: the server is $PREV_VERSION after $((SECONDS - started)) s: $(docker inspect -f '{{.Name}} {{.Image}}' "$project-apiserver" "$project-link-gateway" | tr '\n' ' ')"

  # The runner leaves the link: vN-1's gateway tells every connection MODE_HTTP and forwards nothing.
  wait_log 'runner link mode: off' "$off" 300
  release="$(api release "$drill/orbit/config.json" "$NEXT_VERSION" "$PREV_VERSION")" || fail "asking GET /api/runner/release"
  say "version: GET /api/runner/release?latest=$NEXT_VERSION&previous=$PREV_VERSION answers the drill runner $release"
  [ "$(json "$release" version)" = "$PREV_VERSION" ] && [ "$(json "$release" rollback)" = true ] ||
    fail "the control plane does not assign $PREV_VERSION as a rollback"

  # The runner installs vN-1 by itself at its next release check, and restarts into it.
  if [ "${ORBIT_ROLLBACK_UPDATE_NOW:-0}" = 1 ]; then
    answer="$(api update-now "$(runner_id)")" || fail "pressing Update Runner Now"
    say "version: Update Runner Now $answer"
  fi
  wait_log " -> $PREV_VERSION: the control plane rolled $NEXT_VERSION back" "$rolled" "${ORBIT_ROLLBACK_UPDATE_WAIT:-1500}"
  wait_log "orbit updated to $PREV_VERSION" "$updated" 120
  local deadline=$((SECONDS + 120))
  until [ "$(json "$(api runner "$(runner_id)")" version)" = "$PREV_VERSION" ]; do
    [ $SECONDS -lt $deadline ] || fail "the runner does not report $PREV_VERSION within 120 s of restarting"
    sleep 2
  done
  say "version: the runner reports $(api runner "$(runner_id)")"
  "${runner[@]}" status < /dev/null > "$out/version-status.txt" 2>&1 || true
  status="$(sed -n 1p "$out/version-status.txt")"
  say "version: orbit status says: $status"
  [ "$status" = "orbit $PREV_VERSION ($PREV_SHA)" ] || fail "the runner does not run $PREV_VERSION built from $PREV_SHA"
  installed="$(sha256sum "$drill/bin/orbit" | cut -d' ' -f1)"
  published="$(curl -fsS "$origin/dl/previous/orbit-$platform.gz" | gunzip -c | sha256sum | cut -d' ' -f1)"
  [ "$installed" = "$published" ] || fail "the runner's binary is not /dl/previous's"
  say "version: the runner's binary is /dl/previous's ($installed)"

  # Its work, over HTTPS.
  wait_presence HTTP 120
  session_round rolled-back 3
  calls="$(https_calls "$session_since" "$session_until")"
  say "rolled-back: runner daemon calls over HTTPS $calls"
  [ "$calls" -gt 0 ] || fail "rolled-back: the runner's work did not go over HTTPS"

  # Its next release check finds nothing to install: vN-1 runs the release it is assigned.
  since="$(now)"
  answer="$(api update-now "$(runner_id)")" || fail "pressing Update Runner Now"
  say "version: Update Runner Now $answer"
  deadline=$((SECONDS + 120))
  until checks="$(docker logs --since "$since" "$project-gateway" 2>&1 | grep -c '"GET /api/runner/release' || true)"; [ "$checks" -gt 0 ]; do
    [ $SECONDS -lt $deadline ] || fail "the runner made no release check within 120 s of Update Runner Now"
    sleep 2
  done
  sleep 15
  [ "$(log_count ' -> .*downloading')" = "$((downloads + 1))" ] && [ "$(json "$(api runner "$(runner_id)")" version)" = "$PREV_VERSION" ] ||
    fail "the runner's release check after the rollback moved it off $PREV_VERSION"
  say "version: the runner's next release check finds nothing to install; it stays on $PREV_VERSION"

  # The switch's row: vN-1 neither reads nor writes it, so it still says what the cut-over set. Off, so that the next
  # deploy of vN does not start in the cut-over state, refusing vN-1 runners' HTTPS calls.
  row="$(psql_value "SELECT required FROM runner_link_switch WHERE id = 1")"
  psql_value "UPDATE runner_link_switch SET required = false, updated_at = now() WHERE id = 1" > /dev/null
  say "version: the switch's row said required=$row; set off for the next deploy of vN: $(psql_value "SELECT required FROM runner_link_switch WHERE id = 1")"
  docker logs --since "$swap_since" "$project-apiserver" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' > "$out/version-apiserver.log"
  say "apiserver: $(grep -m 1 'is rolled back' "$out/version-apiserver.log" || echo 'no RunnerRelease line')"
  say "version holds: the server at $PREV_VERSION, the runner rolled back to $PREV_VERSION and working over HTTPS"
}

case "${1:-}" in
  prepare|cutover|switch-off|version|all|stop) mkdir -p "$out" ;;
esac
case "${1:-}" in
  prepare) prepare ;;
  cutover) cutover ;;
  switch-off) switch_off ;;
  version) version_rollback ;;
  all) prepare; cutover; switch_off; cutover; version_rollback ;;
  stop) stop_runner ;;
  -h|--help|"") sed -n '2,30p' "$0" ;;
  *) die "unknown phase $1 (see --help)" ;;
esac
