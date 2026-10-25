#!/usr/bin/env bash
# Checks the running staging stack's link gateway in MODE_LINK, every path it forwards, one step after another, with the
# test runner (link-gateway client -drill, src/link-gateway/client_link.go) and the stack's own state, and keeps what each
# step saw in <state>/client/check-link/ (README.md beside this file):
#
#   1. NATS authenticates: a client without a seed cannot connect, and each user can do only what it does
#      (TestNATSAuthorizationOnARealServer, on this stack's NATS with its seeds); the apiserver and the gateway are in.
#   2. The link drill: heartbeats reconciled by the heartbeat route, facts by digest; a session's claim hint and claim,
#      sent again under its request_id; the inbox hint and HeartbeatAck's hints; route answers relayed whatever their
#      status, malformed paths refused; durable events stored, acknowledged, deduplicated, a gap refused, credit
#      exceeded and made good; the live stream published only while the owner watches, and the turn prefix asked of the
#      runner; an answer that travels in pieces. Then the stack's own record of it: presence says LINK through this
#      gateway, and the database holds every event the gateway acknowledged.
#   3. Cancel: a claim waits for the claim lock, held here, and the runner goes away under it: the gateway cancels the
#      call, and the session stays unclaimed.
#   4. Retry: heartbeats and reads keep being answered while the second apiserver is killed and started again.
#   5. Slow consumer: a runner that stops reading loses frames of the live tier and keeps its connection, then is
#      closed as a slow consumer when what it does not read passes its bound.
#   6. Resume: a session's event stream cut with batches in flight; the runner back on a new connection, whose Welcome
#      states how far the session is stored and that the process still holds it, resumes from there with no
#      EVENT_SEQ_GAP, and the database holds every seq once. Then a Welcome naming the session states its last seq, and
#      the release GET /api/runner/release assigns is the one Welcome and HeartbeatAck name.
#
# Run it with the stack in MODE_LINK with two apiservers (ORBIT_LINK_STAGING_MODE=link ORBIT_LINK_STAGING_BACKENDS=2
# staging-up.sh), in the files TLS mode, with no other runner connected; it needs Go for step 1. It exits non-zero at
# the first step that does not hold. staging-check.sh is the shadow period's check, in MODE_HTTP.
set -euo pipefail
# shellcheck source=staging-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/staging-lib.sh"

[ -f "$env_file" ] || die "no staging stack in $state: run staging-up.sh first"
[ "$(setting STAGING_TLS files)" = files ] || die "the check runs in the files TLS mode"
[ "$(setting STAGING_MODE http)" = link ] || die "the stack is not in MODE_LINK: ORBIT_LINK_STAGING_MODE=link ORBIT_LINK_STAGING_BACKENDS=2 $here/staging-up.sh --no-build"
[ "$(setting STAGING_BACKENDS 1)" = 2 ] || die "step 4 stops a second apiserver: ORBIT_LINK_STAGING_BACKENDS=2 $here/staging-up.sh --no-build"
command -v go >/dev/null || die "go is required (step 1 runs the gateway's NATS test)"
out="$state/client/check-link"
rm -rf "$out"
mkdir -p "$out"

bind="$(setting STAGING_BIND 127.0.0.1)"
metrics="http://127.0.0.1:$(setting STAGING_METRICS_PORT 19464)/metrics"
nats_url="nats://$bind:$(setting STAGING_NATS_PORT 14222)"
gateway="$project-link-gateway"
pg="$project-postgres"
secrets="$state/secrets"
owner=(-owner-email owner@orbit-staging.test -owner-password-file "$secrets/owner_password")

step() { log "$*"; }
fail() { die "$* (records in $out)"; }
metric() { curl -fsS "$metrics" | awk -v n="$1" '$1 == n { print $2 }'; }
# metrics FILE: a snapshot, for deltas.
snapshot() { curl -fsS "$metrics" > "$1"; }
check_json() {
  node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    if (!eval(process.argv[2])) { console.error(`${process.argv[1]}: ${process.argv[2]} does not hold`); process.exit(1); }' "$1" "$2" ||
    fail "$(basename "$1")"
}
json_field() { node -pe "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).$2" "$1"; }
# deltas BEFORE AFTER CHECKS...: each check is "series op value", the series' increase between the two snapshots.
deltas() {
  node - "$@" <<'EOF' || fail "the gateway's counts"
const fs = require('fs');
const read = (f) => Object.fromEntries(fs.readFileSync(f, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'))
  .map((l) => { const i = l.lastIndexOf(' '); return [l.slice(0, i), Number(l.slice(i + 1))]; }));
const [before, after] = [read(process.argv[2]), read(process.argv[3])];
let ok = true;
for (const check of process.argv.slice(4)) {
  const [, series, op, want] = check.match(/^(.*) (>=|==|>) (\d+)$/);
  const d = series.split(' + ').reduce((sum, x) => sum + (after[x] ?? 0) - (before[x] ?? 0), 0);
  const holds = op === '>=' ? d >= +want : op === '>' ? d > +want : d === +want;
  console.error(`    ${holds ? 'ok  ' : 'FAIL'} ${series} rose by ${d} (want ${op} ${want})`);
  ok &&= holds;
}
process.exit(ok ? 0 : 1);
EOF
}
psql_value() { docker exec "$pg" psql -U orbit -d orbit -tAc "$1"; }
client() { "$here/staging-client.sh" -http=false -events 0 -mirror=false "$@"; }

step "1. NATS authenticates: no seed, no connection; each user only what it does"
for who in apiserver gateway; do
  [ -s "$secrets/nats_${who}_seed" ] || fail "no NATS seed for $who in $secrets"
done
(cd "$repo/src/link-gateway" && LINK_TEST_NATS_AUTH_URL="$nats_url" LINK_TEST_NATS_APISERVER_SEED="$(cat "$secrets/nats_apiserver_seed")" \
  LINK_TEST_NATS_GATEWAY_SEED="$(cat "$secrets/nats_gateway_seed")" go test -count=1 -run 'TestNATSAuthorizationOnARealServer' -v .) \
  > "$out/1-nats-auth.txt" 2>&1 || fail "NATS authorization on the stack's NATS"
grep -q -- '--- PASS: TestNATSAuthorizationOnARealServer' "$out/1-nats-auth.txt" || fail "the NATS test did not run"
[ "$(metric link_nats_connected)" = 1 ] || fail "the link gateway is not connected to NATS"
grep -q 'connected to NATS at ' <(docker logs "$project-apiserver" 2>&1) || fail "the apiserver is not connected to NATS"
docker logs "$project-apiserver" 2>&1 | grep 'Authorization Violation' > "$out/1-apiserver-auth-errors.txt" && fail "the apiserver met an authorization violation"
tail -n 3 "$out/1-nats-auth.txt" >&2

step "2. the link drill: requests, heartbeats, hints, durable events and credit, the live stream and the turn prefix"
snapshot "$out/2-metrics-before.txt"
client -drill link "${owner[@]}" -nats-url "$nats_url" -nats-seed-file "$secrets/nats_apiserver_seed" \
  -report "$out/2-link.json" -capture "$out/2-link.capture" > "$out/2-link.log" 2>&1 || fail "the link drill"
snapshot "$out/2-metrics-after.txt"
check_json "$out/2-link.json" 's.ok && s.steps.length >= 25 && s.steps.every((x) => x.ok)'
node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (const x of s.steps) console.error(`    ok   ${x.name} (${x.ms} ms): ${x.detail}`);' "$out/2-link.json"
deltas "$out/2-metrics-before.txt" "$out/2-metrics-after.txt" \
  'link_rpc_results_total{result="2xx"} >= 4' 'link_rpc_results_total{result="4xx"} >= 1' 'link_rpc_results_total{result="5xx"} >= 1' \
  'link_rpc_results_total{result="RPC_BAD_REQUEST"} == 3' 'link_heartbeat_forwards_total{result="forwarded"} >= 5' \
  'link_heartbeat_forwards_total{result="want_facts"} == 1' 'link_event_batches_total{result="stored"} >= 5' \
  'link_event_batches_total{result="credit_exceeded"} >= 1' 'link_event_batches_total{result="gap"} >= 1' \
  'link_events_stored_total >= 13000' 'link_live_events_total{result="no_watchers"} >= 2' \
  'link_live_events_total{result="published"} >= 2' 'link_turn_prefix_requests_total{result="answered"} >= 1' \
  'link_hints_total{kind="claim",result="sent"} >= 1' 'link_hints_total{kind="inbox",result="sent"} >= 1' \
  'link_hints_total{kind="watchers",result="sent"} >= 2' 'link_backend_calls_total{kind="rpc",result="cut_off"} == 0'
session_uuid="$(json_field "$out/2-link.json" 'facts.sessionUuid')"
runner_id="$(json_field "$out/2-link.json" 'facts.runnerId')"
durable="$(json_field "$out/2-link.json" 'facts.durableSeq')"
stored="$(psql_value "SELECT count(*) FROM run_event WHERE session_id = '$session_uuid' AND seq <= $durable")"
max_seq="$(psql_value "SELECT COALESCE(max(seq), 0) FROM run_event WHERE session_id = '$session_uuid'")"
printf 'session %s: durable_seq %s acknowledged; %s events stored, max seq %s\n' "$session_uuid" "$durable" "$stored" "$max_seq" | tee "$out/2-db.txt" >&2
[ "$max_seq" = "$durable" ] || fail "the database's last seq is not the durable_seq the gateway acknowledged"
[ "$stored" = "$durable" ] || fail "seqs 1..$durable are not all stored"
presence="$(psql_value "SELECT link_state || ' ' || COALESCE(gateway_id, '') FROM runner_presence WHERE runner_id = '$runner_id'")"
gateway_host="$(docker inspect -f '{{.Config.Hostname}}' "$gateway")"
echo "presence: $presence (gateway $gateway_host)" | tee -a "$out/2-db.txt" >&2
[ "$presence" = "LINK $gateway_host" ] || fail "presence does not say LINK through this gateway"
docker run --rm -v "$out:$out" "$project-link-gateway:local" dump "$out/2-link.capture" > "$out/2-link.dump.txt" ||
  fail "link-gateway dump could not decode the capture"
for body in hello welcome heartbeat heartbeat_ack rpc rpc_result event_batch event_ack live_batch hint turn_prefix_request turn_prefix_response chunk; do
  grep -q " $body " "$out/2-link.dump.txt" || fail "the capture has no $body frame"
done

step "3. cancel: a claim waiting for the claim lock is cancelled when the runner goes away, and claims nothing"
snapshot "$out/3-metrics-before.txt"
# The claim lock (QueueService.trySessionClaim: pg_advisory_xact_lock(1330792788, 1)), held for a while from here.
docker exec "$pg" psql -U orbit -d orbit -c "BEGIN; SELECT pg_advisory_xact_lock(1330792788, 1); SELECT pg_sleep(20); COMMIT;" \
  > "$out/3-lock.txt" 2>&1 &
locker=$!
sleep 2
client -drill cancel "${owner[@]}" -cancel-after 4s -report "$out/3-cancel.json" > "$out/3-cancel.log" 2>&1 || fail "the cancel drill"
check_json "$out/3-cancel.json" 's.ok'
wait "$locker" || fail "holding the claim lock"
sleep 3
cancel_session="$(json_field "$out/3-cancel.json" 'facts.session')"
snapshot "$out/3-metrics-after.txt"
deltas "$out/3-metrics-before.txt" "$out/3-metrics-after.txt" 'link_rpc_results_total{result="CANCELLED"} == 1'
access="$(curl -fsS -X POST "http://$bind:$(setting STAGING_HTTP_PORT 18086)/api/auth/login" -H 'content-type: application/json' \
  -d "{\"email\":\"owner@orbit-staging.test\",\"password\":\"$(cat "$secrets/owner_password")\"}" |
  node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).accessToken')"
curl -fsS "http://$bind:$(setting STAGING_HTTP_PORT 18086)/api/sessions/$cancel_session" -H "Authorization: Bearer $access" > "$out/3-session.json" ||
  fail "reading the cancelled claim's session"
check_json "$out/3-session.json" 's.status === "PENDING"'
echo "the session stays $(json_field "$out/3-session.json" status) after its claim was cancelled" >&2
curl -fsS -X POST "http://$bind:$(setting STAGING_HTTP_PORT 18086)/api/sessions/$cancel_session/end" -H "Authorization: Bearer $access" \
  -H 'content-type: application/json' -d '{}' > /dev/null || log "    (ending the drill's session failed; it is left PENDING)"

step "4. retry: heartbeats and reads are answered while the second apiserver is killed and started again"
snapshot "$out/4-metrics-before.txt"
# As a runner holds it: the UUID the claim answered with.
session_id="$session_uuid"
client -drill retry -for 45s -session "$session_id" "${owner[@]}" -report "$out/4-retry.json" > "$out/4-retry.log" 2>&1 &
runner=$!
sleep 8
docker kill "$project-apiserver-b" > "$out/4-kill.txt" 2>&1 || fail "killing the second apiserver"
sleep 15
docker start "$project-apiserver-b" > "$out/4-start.txt" 2>&1 || fail "starting the second apiserver again"
wait "$runner" || fail "the retry drill: a call was not answered"
check_json "$out/4-retry.json" 's.ok && s.facts.calls >= 100'
node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.error("    " + s.steps.map((x) => x.detail).join("\n    "));' "$out/4-retry.json"
snapshot "$out/4-metrics-after.txt"
# Which kind of call is the first to find the killed apiserver after each of the gateway's down marks is up to timing:
# together they must have been sent again on the other one, and each kind's own count is shown.
deltas "$out/4-metrics-before.txt" "$out/4-metrics-after.txt" \
  'link_backend_retries_total{kind="heartbeat",reason="not_delivered"} + link_backend_retries_total{kind="rpc",reason="not_delivered"} >= 1' \
  'link_backend_retries_total{kind="heartbeat",reason="not_delivered"} >= 0' 'link_backend_retries_total{kind="rpc",reason="not_delivered"} >= 0'
for _ in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$project-apiserver-b")" = healthy ] && break
  sleep 2
done

step "5. slow consumer: live frames dropped while the connection stays, then closed when what it does not read passes its bound"
snapshot "$out/5-metrics-before.txt"
client -drill slow -session "$session_id" "${owner[@]}" -report "$out/5-slow.json" > "$out/5-slow.log" 2>&1 || fail "the slow drill"
check_json "$out/5-slow.json" 's.ok'
snapshot "$out/5-metrics-after.txt"
deltas "$out/5-metrics-before.txt" "$out/5-metrics-after.txt" \
  'link_queue_full_total{queue="live",result="dropped"} >= 1' 'link_turn_prefix_requests_total{result="dropped"} >= 1' \
  'link_disconnects_total{reason="slow_consumer"} == 1' 'link_queue_full_total{queue="normal",result="closed"} >= 1'
node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.error("    " + s.steps.map((x) => x.detail).join("\n    "));' "$out/5-slow.json"

step "6. resume: the event stream cut with batches in flight, resumed on a new connection from Welcome's durable_seq"
snapshot "$out/6-metrics-before.txt"
client -drill resume "${owner[@]}" -report "$out/6-resume.json" > "$out/6-resume.log" 2>&1 || fail "the resume drill"
snapshot "$out/6-metrics-after.txt"
check_json "$out/6-resume.json" 's.ok && s.steps.length >= 11 && s.steps.every((x) => x.ok)'
node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (const x of s.steps) console.error(`    ok   ${x.name} (${x.ms} ms): ${x.detail}`);' "$out/6-resume.json"
deltas "$out/6-metrics-before.txt" "$out/6-metrics-after.txt" \
  'link_event_batches_total{result="gap"} == 0' 'link_welcome_lookups_total{result="answered"} >= 3' \
  'link_welcome_lookups_total{result="failed"} + link_welcome_lookups_total{result="refused"} + link_welcome_lookups_total{result="malformed"} == 0' \
  'link_disconnects_total{reason="connection_lost"} >= 1'
resume_session="$(json_field "$out/6-resume.json" 'facts.sessionUuid')"
final="$(json_field "$out/6-resume.json" 'facts.finalSeq')"
rows="$(psql_value "SELECT count(*) || ' ' || count(DISTINCT seq) || ' ' || COALESCE(min(seq), 0) || ' ' || COALESCE(max(seq), 0) FROM run_event WHERE session_id = '$resume_session'")"
printf 'session %s: acknowledged through %s, sent through %s when cut; Welcome said durable_seq %s; rows, distinct seqs, min, max: %s\n' \
  "$resume_session" "$(json_field "$out/6-resume.json" 'facts.ackedAtCut')" "$(json_field "$out/6-resume.json" 'facts.sentThrough')" \
  "$(json_field "$out/6-resume.json" 'facts.welcomeDurableSeq')" "$rows" | tee "$out/6-db.txt" >&2
[ "$rows" = "$final $final 1 $final" ] || fail "the session's stored seqs are not 1..$final, each once"

snapshot "$out/metrics-final.txt"
log "all six steps hold; records in $out"
