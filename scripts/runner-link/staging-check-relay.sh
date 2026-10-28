#!/usr/bin/env bash
# Checks the running staging stack with two apiservers: what a person's request leaves in one apiserver process's
# memory — an Antigravity sign-in's pasted code, a Cursor key to check — reaches the runner over the link whichever
# process its calls are forwarded to (src/apiserver/src/runners/relay-peers.ts), and is never written to the database, a
# log or an event. The web's requests reach the first apiserver; the test runner's relay drills (link-gateway client
# -drill relay…, src/link-gateway/client_relay.go) play the runner. Each step's records go to
# <state>/client/check-relay/<placement>/:
#
#   1. NATS: the apiserver's processes ask and answer each other on api.>, and the gateway can read neither that nor an
#      apiserver's inbox, where a code or a key crosses (TestNATSAuthorizationOnARealServer, on this stack's NATS with its
#      seeds); nats-server runs from nats.conf alone, which turns on no trace or debug logging.
#   2. The relay drill: the owner starts an Antigravity sign-in and pastes its code through the web API; the runner's
#      heartbeat hands it over, once, for its attempt. The owner checks a Cursor key through the web API; a heartbeat
#      hands it over, once, and the runner's answer settles the check the owner waits on.
#
# With the gateway forwarding to the second apiserver alone (ORBIT_LINK_STAGING_LINK_BACKENDS=apiserver-b), every call of
# the runner lands on a process that holds neither, and two more steps run:
#
#   3. A late joiner: the sign-in waits for its code, the second apiserver is stopped, the owner pastes the code and the
#      second apiserver starts again, never having heard of it: it hears the holder say so again, and hands it over.
#   4. A slow holder: the code pasted, the first apiserver is paused as the runner's heartbeat asks it for the code. The
#      heartbeat is answered within its bound, without the code; once unpaused, the first apiserver's late answer is held
#      by the second, which nudges the runner, and its next heartbeat collects it.
#
# With the gateway forwarding to both (all, the default), step 2 runs three times, the runner's calls going round robin.
#
#   5. Nothing kept: no code or key handed over in this run is in any of the stack's container logs, any row of its
#      database (pg_dump), or a drill's report or log.
#
#   ORBIT_LINK_STAGING_MODE=link ORBIT_LINK_STAGING_BACKENDS=2 ORBIT_LINK_STAGING_LINK_BACKENDS=apiserver-b \
#     scripts/runner-link/staging-up.sh --no-build
#   scripts/runner-link/staging-check-relay.sh
#   ORBIT_LINK_STAGING_LINK_BACKENDS=all scripts/runner-link/staging-up.sh --no-build
#   scripts/runner-link/staging-check-relay.sh
#
# Run it in the files TLS mode with no other runner connected; it needs Go for step 1. It exits non-zero at the first
# step that does not hold.
set -euo pipefail
# shellcheck source=staging-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/staging-lib.sh"

[ -f "$env_file" ] || die "no staging stack in $state: run staging-up.sh first"
[ "$(setting STAGING_TLS files)" = files ] || die "the check runs in the files TLS mode"
[ "$(setting STAGING_MODE http)" = link ] || die "the stack is not in MODE_LINK: ORBIT_LINK_STAGING_MODE=link ORBIT_LINK_STAGING_BACKENDS=2 $here/staging-up.sh --no-build"
[ "$(setting STAGING_BACKENDS 1)" = 2 ] || die "the check needs two apiservers: ORBIT_LINK_STAGING_BACKENDS=2 $here/staging-up.sh --no-build"
command -v go >/dev/null || die "go is required (step 1 runs the gateway's NATS test)"
case "$(setting STAGING_LINK_BACKENDS all)" in
  apiserver-b) placement=b-only ;;
  all) placement=round-robin ;;
  *) die "the gateway forwards to $(setting STAGING_LINK_BACKENDS all): run staging-up.sh with ORBIT_LINK_STAGING_LINK_BACKENDS=apiserver-b, or all" ;;
esac
out="$state/client/check-relay/$placement"
rm -rf "$out"
mkdir -p "$out"
chmod 700 "$out"

bind="$(setting STAGING_BIND 127.0.0.1)"
api="http://$bind:$(setting STAGING_HTTP_PORT 18086)"
nats_url="nats://$bind:$(setting STAGING_NATS_PORT 14222)"
secrets="$state/secrets"
owner=(-owner-email owner@orbit-staging.test -owner-password-file "$secrets/owner_password")
first="$project-apiserver"
second="$project-apiserver-b"
pg="$project-postgres"
nats="$project-nats"

step() { log "$*"; }
fail() { die "$* (records in $out)"; }
check_json() {
  node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    if (!eval(process.argv[2])) { console.error(`${process.argv[1]}: ${process.argv[2]} does not hold`); process.exit(1); }' "$1" "$2" ||
    fail "$(basename "$1")"
}
json_field() { node -pe "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).$2" "$1"; }
steps() {
  node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const x of s.steps) console.error(`    ${x.ok ? "ok  " : "FAIL"} ${x.name} (${x.ms} ms): ${x.detail}`);' "$1"
}
client() { "$here/staging-client.sh" -http=false -events 0 -mirror=false "$@"; }
# A drill: its report and log under $out, its steps shown, and every one of them holding.
drill() {
  local name="$1"
  shift
  local rc=0
  client "$@" -report "$out/$name.json" > "$out/$name.log" 2>&1 || rc=$?
  [ -s "$out/$name.json" ] || fail "the $name drill wrote no report (exit $rc)"
  steps "$out/$name.json"
  [ "$rc" = 0 ] || fail "the $name drill"
  check_json "$out/$name.json" 's.ok && s.steps.every((x) => x.ok)'
}
# secrets NAME: a fresh code and key for one drill, in a file only root reads, which step 5 looks for everywhere.
secrets_for() {
  (umask 077; printf '{"code":"4/0Arelay-%s","key":"key_relay%s"}\n' "$(openssl rand -hex 16)" "$(openssl rand -hex 24)" > "$out/$1.secrets.json")
  printf '%s' "$out/$1.secrets.json"
}
healthy() {
  for _ in $(seq 1 90); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null)" = healthy ] && return 0
    sleep 2
  done
  fail "$1 did not come back healthy"
}
# paste FILE: the owner pastes FILE's code through the web API, which reaches the first apiserver, as the web page does.
paste_code() {
  local token runner
  token="$(curl -fsS -X POST "$api/api/auth/login" -H 'content-type: application/json' \
    --data-binary @- <<<"{\"email\":\"owner@orbit-staging.test\",\"password\":\"$(cat "$secrets/owner_password")\"}" |
    node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).accessToken')"
  runner="$(json_field "$out/$2.json" 'facts.runnerId')"
  node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(JSON.stringify({ code: s.code }));' "$1" |
    curl -fsS -o "$out/$2-paste.json" -w '%{http_code}\n' -X POST "$api/api/runners/$runner/login/code" \
      -H "Authorization: Bearer $token" -H 'content-type: application/json' --data-binary @- > "$out/$2-paste.status" ||
    fail "pasting the code"
  ! grep -qF "$(json_field "$1" code)" "$out/$2-paste.json" || fail "the paste's answer carries the code"
  echo "    pasted through $api: $(cat "$out/$2-paste.status")" >&2
}
paused=0
cleanup() { [ "$paused" = 1 ] && docker unpause "$first" >/dev/null 2>&1 || true; }
trap cleanup EXIT

step "1. NATS: the apiservers ask each other on api.>, the gateway reads none of it, and nats-server logs no payloads"
for who in apiserver gateway; do
  [ -s "$secrets/nats_${who}_seed" ] || fail "no NATS seed for $who in $secrets"
done
(cd "$repo/src/link-gateway" && LINK_TEST_NATS_AUTH_URL="$nats_url" LINK_TEST_NATS_APISERVER_SEED="$(cat "$secrets/nats_apiserver_seed")" \
  LINK_TEST_NATS_GATEWAY_SEED="$(cat "$secrets/nats_gateway_seed")" go test -count=1 -run 'TestNATSAuthorizationOnARealServer' -v .) \
  > "$out/1-nats-auth.txt" 2>&1 || fail "NATS authorization on the stack's NATS"
grep -q -- '--- PASS: TestNATSAuthorizationOnARealServer' "$out/1-nats-auth.txt" || fail "the NATS test did not run"
args="$(docker inspect -f '{{json .Args}}' "$nats")"
docker exec "$nats" cat /etc/orbit-nats/nats.conf > "$out/1-nats.conf"
cmp -s "$out/1-nats.conf" "$repo/src/link-gateway/nats.conf" || fail "the stack's NATS does not run this checkout's nats.conf"
{
  echo "nats-server arguments: $args"
  echo "trace or debug in its configuration: $(sed 's/#.*//' "$out/1-nats.conf" | grep -ciE 'trace|debug' || true)"
} | tee "$out/1-nats-logging.txt" >&2
[ "$args" = '["--config","/etc/orbit-nats/nats.conf"]' ] || fail "nats-server runs with arguments besides its configuration"
grep -q 'trace or debug in its configuration: 0' "$out/1-nats-logging.txt" || fail "nats.conf turns on trace or debug logging"
for apiserver in "$first" "$second"; do
  grep -q 'connected to NATS at ' <(docker logs "$apiserver" 2>&1) || fail "$apiserver is not connected to NATS"
done
tail -n 3 "$out/1-nats-auth.txt" >&2

runs=(relay)
[ "$placement" = round-robin ] && runs=(relay-1 relay-2 relay-3)
for run in "${runs[@]}"; do
  step "2. the relay drill ($run, the gateway forwarding to $(setting STAGING_BACKEND_URLS '')): a code and a key held by the first apiserver, handed to the runner"
  drill "$run" -drill relay "${owner[@]}" -relay-secrets "$(secrets_for "$run")"
done

if [ "$placement" = b-only ]; then
  step "3. a late joiner: the second apiserver starts after the code is pasted, and still hands it over"
  late="$(secrets_for late)"
  drill late-begin -drill relay-begin "${owner[@]}" -relay-secrets "$late"
  docker stop "$second" > "$out/late-stop.txt" 2>&1 || fail "stopping the second apiserver"
  paste_code "$late" late-begin
  docker start "$second" > "$out/late-start.txt" 2>&1 || fail "starting the second apiserver again"
  healthy "$second"
  echo "    $second started again at $(date -u +%H:%M:%S), its first line: $(docker logs "$second" 2>&1 | head -n 1 | cut -c1-120)" >&2
  drill late-finish -drill relay-finish "${owner[@]}" -relay-secrets "$late" -relay-attempt "$(json_field "$out/late-begin.json" 'facts.attempt')"

  step "4. a slow holder: the first apiserver paused when the heartbeat asks it; its late answer is not lost"
  slow="$(secrets_for slow)"
  drill slow-begin -drill relay-begin "${owner[@]}" -relay-secrets "$slow"
  paste_code "$slow" slow-begin
  # The runner connects first (its link token comes from the web's apiserver), then the holder is paused, then it beats.
  drill slow-finish -drill relay-finish -relay-slow-holder "${owner[@]}" -relay-secrets "$slow" \
    -relay-attempt "$(json_field "$out/slow-begin.json" 'facts.attempt')" -relay-handshake "$out/slow-finish" &
  finisher=$!
  for _ in $(seq 1 600); do [ -e "$out/slow-finish.ready" ] && break; sleep 0.1; done
  [ -e "$out/slow-finish.ready" ] || fail "the slow-finish drill never connected"
  docker pause "$first" > "$out/slow-pause.txt" 2>&1 || fail "pausing the first apiserver"
  paused=1
  echo "    $first paused at $(date -u +%H:%M:%S.%N | cut -c1-12)" >&2
  touch "$out/slow-finish.go"
  sleep 6
  docker unpause "$first" > "$out/slow-unpause.txt" 2>&1 || fail "unpausing the first apiserver"
  paused=0
  echo "    $first unpaused at $(date -u +%H:%M:%S.%N | cut -c1-12)" >&2
  wait "$finisher" || fail "the slow-finish drill"
fi

step "5. nothing kept: no code or key of this run in a container's log, the database or a drill's report"
docker exec "$pg" pg_dump -U orbit -d orbit --data-only > "$out/5-db.sql" || fail "dumping the database"
for container in $(docker ps -a --filter "label=com.docker.compose.project=$project" --format '{{.Names}}'); do
  docker logs "$container" > "$out/5-log-$container.txt" 2>&1 || true
done
found=0
for file in "$out"/*.secrets.json; do
  for which in code key; do
    value="$(json_field "$file" "$which")"
    for where in "$out"/5-db.sql "$out"/5-log-*.txt "$out"/*.log "$out"/*.json; do
      [ "$where" = "$file" ] && continue
      if grep -qF -- "$value" "$where"; then
        echo "    FOUND the $which of $(basename "$file" .secrets.json) in $(basename "$where")" >&2
        found=1
      fi
    done
  done
done
{
  echo "searched for $(ls "$out"/*.secrets.json | wc -l) codes and keys:"
  echo "  the database: $(wc -l < "$out/5-db.sql") lines of pg_dump --data-only"
  for log in "$out"/5-log-*.txt; do echo "  $(basename "$log" .txt | sed 's/^5-log-//'): $(wc -l < "$log") log lines"; done
  echo "  the drills' reports and logs: $(ls "$out"/*.log "$out"/*.json | grep -v secrets | wc -l) files"
  [ "$found" = 0 ] && echo "none of them anywhere"
} | tee "$out/5-nothing-kept.txt" >&2
[ "$found" = 0 ] || fail "a code or a key was kept"
rm -f "$out/5-db.sql"
log "the relay check holds ($placement): records in $out"
