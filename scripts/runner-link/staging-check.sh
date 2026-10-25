#!/usr/bin/env bash
# Checks the running staging stack's link gateway end to end, one step after another, and keeps what each step saw in
# <state>/client/check/ (README.md beside this file):
#
#   1. Refusals before the upgrade, and the TLS certificate the link presents.
#   2. A test runner connects, heartbeats over the link and over HTTPS, and mirrors for 50 s: Welcome, heartbeat
#      answers, ping round trips, and every mirror compared equal.
#   3. A gateway release (the container recreated, as an upgrade does): the runner is sent Drain and connects to the new
#      gateway.
#   4. A certificate rotation under a live connection, which stays up.
#   5. A revocation: the probe runner's token is rotated, the gateway closes its live connection and refuses its old
#      link token, and the runner works again with its new token.
#
# It assumes no other runner is connected to the stack, and exits non-zero at the first step that does not hold.
set -euo pipefail
# shellcheck source=staging-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/staging-lib.sh"

[ -f "$env_file" ] || die "no staging stack in $state: run staging-up.sh first"
[ "$(setting STAGING_TLS files)" = files ] || die "the check runs in the files TLS mode"
out="$state/client/check"
rm -rf "$out"
mkdir -p "$out"

bind="$(setting STAGING_BIND 127.0.0.1)"
host="$(setting STAGING_HOST localhost)"
link_port="$(setting STAGING_LINK_PORT 18443)"
origin="http://$bind:$(setting STAGING_HTTP_PORT 18086)"
metrics="http://127.0.0.1:$(setting STAGING_METRICS_PORT 19464)/metrics"
gateway="$project-link-gateway"
image="$project-link-gateway:local"
ca="$state/tls/ca.pem"
token_file="$state/secrets/runner_token"
link="https://$host:$link_port/"

step() { log "$*"; }
fail() { die "$* (records in $out)"; }
# metric NAME: the value of one series, NAME with its labels exactly as exposed; empty when absent.
metric() { curl -fsS "$metrics" | awk -v n="$1" '$1 == n { print $2 }'; }
# wait_until SECONDS WHAT COMMAND...: poll COMMAND every second.
wait_until() {
  local seconds="$1" what="$2"
  shift 2
  for _ in $(seq "$seconds"); do
    if "$@"; then return 0; fi
    sleep 1
  done
  fail "$what: not within ${seconds}s"
}
connections_are() { [ "$(metric link_connections)" = "$1" ]; }
# check_json FILE EXPRESSION: EXPRESSION, over the JSON in FILE as `s`, is true.
check_json() {
  node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    if (!eval(process.argv[2])) { console.error(`${process.argv[1]}: ${process.argv[2]} does not hold`); process.exit(1); }' "$1" "$2" ||
    fail "$(basename "$1")"
}
curl_link() { curl -s --cacert "$ca" --resolve "$host:$link_port:$bind" "$@"; }
upgrade=(-H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==')
mint() {
  curl -fsS -X POST "$origin/api/runner/link-token" -H "Authorization: Bearer $(cat "$token_file")" \
    -H 'content-type: application/json' -d "{\"leaseOwner\":\"$(cat /proc/sys/kernel/random/uuid)\"}" |
    node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).token'
}
cert_serial() {
  openssl s_client -connect "$bind:$link_port" -servername "$host" -CAfile "$ca" </dev/null 2>/dev/null |
    openssl x509 -noout -serial 2>/dev/null | cut -d= -f2
}
# The test runner, beating every 2 s. In the background it is started directly, so that $! is the client itself and a
# signal reaches it (staging-client.sh execs docker run, which hands signals to the container).
client() { "$here/staging-client.sh" -heartbeat 2s "$@"; }

step "1. refusals before the upgrade, and TLS"
code="$(curl_link -o "$out/1-plain-get.json" -w '%{http_code}' "$link")"
[ "$code" = 426 ] || fail "a plain GET answered $code, not 426"
code="$(curl_link -o "$out/1-no-token.json" -w '%{http_code}' "${upgrade[@]}" "$link")"
[ "$code" = 401 ] && grep -q '"reason":"MISSING"' "$out/1-no-token.json" || fail "an upgrade without a token answered $code"
token="$(mint)"
signature="${token##*.}"
middle="${signature:20:1}"
[ "$middle" = A ] && other=B || other=A
forged="${token%.*}.${signature:0:20}$other${signature:21}"
code="$(curl_link -o "$out/1-bad-signature.json" -w '%{http_code}' "${upgrade[@]}" -H "Authorization: Bearer $forged" "$link")"
[ "$code" = 401 ] && grep -q '"reason":"SIGNATURE"' "$out/1-bad-signature.json" || fail "a forged token answered $code"
openssl s_client -connect "$bind:$link_port" -servername "$host" -CAfile "$ca" -verify_return_error </dev/null \
  > "$out/1-tls.txt" 2>&1 || fail "the link's TLS does not verify against the staging CA"
grep -q 'Verify return code: 0 (ok)' "$out/1-tls.txt" || fail "the link's certificate does not verify"
openssl x509 -noout -subject -issuer -serial -enddate -ext subjectAltName < "$out/1-tls.txt" > "$out/1-certificate.txt"
cat "$out/1-certificate.txt" >&2

step "2. a runner connects, heartbeats and mirrors for 50s"
curl -fsS "$metrics" > "$out/2-metrics-before.txt"
client -duration 50s -summary "$out/2-client.json" -capture "$out/2-client.capture" > "$out/2-client.log" 2>&1 ||
  fail "the test runner failed"
curl -fsS "$metrics" > "$out/2-metrics-after.txt"
check_json "$out/2-client.json" 's.connects === 1 && s.lostConnections === 0 && s.heartbeatAcks >= 20 &&
  s.httpHeartbeats.ok >= 20 && s.mirrorsSent.heartbeat === s.httpHeartbeats.ok && s.mirrorsSent.events === s.mirrorsSent.heartbeat &&
  s.rpcResults.LINK_MODE_HTTP >= 2 * s.mirrorsSent.heartbeat - 2 && s.modes.MODE_HTTP === s.heartbeatAcks'
node - "$out/2-metrics-before.txt" "$out/2-metrics-after.txt" "$out/2-client.json" <<'EOF' || fail "the gateway's counts for step 2"
const fs = require('fs');
const read = (f) => Object.fromEntries(fs.readFileSync(f, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'))
  .map((l) => { const i = l.lastIndexOf(' '); return [l.slice(0, i), Number(l.slice(i + 1))]; }));
const [before, after] = [read(process.argv[2]), read(process.argv[3])];
const client = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
const delta = (name) => (after[name] ?? 0) - (before[name] ?? 0);
const checks = {
  'handshakes ok': [delta('link_handshakes_total{result="ok"}'), (d) => d === 1],
  'handshake durations': [delta('link_handshake_duration_seconds_count'), (d) => d === 1],
  heartbeats: [delta('link_heartbeats_total'), (d) => d === client.heartbeatsSent],
  'ping round trips': [delta('link_rtt_seconds_count'), (d) => d >= 2],
  'heartbeat mirrors equal': [delta('link_shadow_pairs_total{kind="heartbeat",result="match"}'), (d) => d === client.mirrorsSent.heartbeat],
  'event mirrors equal': [delta('link_shadow_pairs_total{kind="events",result="match"}'), (d) => d === client.mirrorsSent.events],
  'mirrors different': [delta('link_shadow_pairs_total{kind="heartbeat",result="mismatch"}') + delta('link_shadow_pairs_total{kind="events",result="mismatch"}'), (d) => d === 0],
  'mirror halves unpaired': [Object.keys(after).filter((k) => k.startsWith('link_shadow_unpaired_total')).reduce((n, k) => n + delta(k), 0), (d) => d === 0],
  'closed by the runner': [delta('link_disconnects_total{reason="client_closed"}'), (d) => d === 1],
};
let ok = true;
for (const [what, [value, holds]] of Object.entries(checks)) {
  console.error(`    ${holds(value) ? 'ok  ' : 'FAIL'} ${what}: ${value}`);
  ok &&= holds(value);
}
process.exit(ok ? 0 : 1);
EOF
docker run --rm -v "$out:$out" "$image" dump "$out/2-client.capture" > "$out/2-client.dump.txt" ||
  fail "link-gateway dump could not decode the capture"
for body in hello welcome heartbeat heartbeat_ack event_batch rpc rpc_result; do
  grep -q " $body " "$out/2-client.dump.txt" || fail "the capture has no $body frame"
done

step "3. a gateway release: the runner is drained and connects to the new gateway"
"$here/staging-client.sh" -heartbeat 2s -until-drains 1 -duration 240s -summary "$out/3-client.json" > "$out/3-client.log" 2>&1 &
runner=$!
wait_until 30 "the runner connected" connections_are 1
old_start="$(metric link_gateway_start_time_seconds)"
docker logs -f "$gateway" > "$out/3-old-gateway.log" 2>&1 &
follower=$!
compose --profile runner-link up -d --no-deps --force-recreate --wait link-gateway > "$out/3-recreate.log" 2>&1 ||
  fail "recreating the link gateway failed"
wait "$runner" || fail "the runner did not reconnect after Drain"
kill "$follower" 2>/dev/null || true
wait "$follower" 2>/dev/null || true
check_json "$out/3-client.json" 's.drains === 1 && s.reconnectsAfterDrain === 1 && s.connects === 2 &&
  s.drainReconnectAfterMs[0] >= 1000 && s.drainReconnectAfterMs[0] <= 30000 && new Set(s.connectionIds).size === 2'
grep -q 'msg=draining connections=1' "$out/3-old-gateway.log" || fail "the old gateway did not drain"
grep -q 'drain reconnect_after_ms=' "$out/3-old-gateway.log" || fail "the old gateway sent no Drain"
grep -q 'msg=stopped' "$out/3-old-gateway.log" || fail "the old gateway did not stop cleanly"
[ "$(metric link_gateway_start_time_seconds)" != "$old_start" ] || fail "the gateway was not replaced"
heartbeat_seen() { [ "$(metric link_heartbeats_total)" -ge 1 ]; }
wait_until 10 "the runner's heartbeat on the new gateway" heartbeat_seen
docker logs "$gateway" > "$out/3-new-gateway.log" 2>&1

step "4. a certificate rotation under a live connection"
"$here/staging-client.sh" -heartbeat 2s -duration 80s -summary "$out/4-client.json" > "$out/4-client.log" 2>&1 &
runner=$!
wait_until 30 "the runner connected" connections_are 1
serial_before="$(cert_serial)"
"$here/staging-up.sh" --rotate-cert --no-build > "$out/4-rotate.log" 2>&1 || fail "staging-up.sh --rotate-cert failed"
serial_changed() { local s; s="$(cert_serial)"; [ -n "$s" ] && [ "$s" != "$serial_before" ]; }
wait_until 45 "the new certificate on the wire" serial_changed
serial_after="$(cert_serial)"
wait "$runner" || fail "the runner failed during the rotation"
check_json "$out/4-client.json" 's.connects === 1 && s.lostConnections === 0 && Object.keys(s.closes).length === 0'
docker logs "$gateway" 2>&1 | grep 'msg="certificate reloaded"' > "$out/4-reloaded.txt" || fail "the gateway logged no reload"
[ "$(metric 'link_tls_reloads_total{result="ok"}')" -ge 1 ] || fail "no reload counted"
printf 'serial before %s\nserial after  %s\n' "$serial_before" "$serial_after" | tee "$out/4-serials.txt" >&2

step "5. a revocation closes the live connection and refuses the old token"
old_link_token="$(mint)"
revoked_before="$(metric 'link_disconnects_total{reason="revoked"}')"
"$here/staging-client.sh" -heartbeat 2s -duration 90s -summary "$out/5-client.json" > "$out/5-client.log" 2>&1 &
runner=$!
wait_until 30 "the runner connected" connections_are 1
access="$(curl -fsS -X POST "$origin/api/auth/login" -H 'content-type: application/json' \
  -d "{\"email\":\"owner@orbit-staging.test\",\"password\":\"$(cat "$state/secrets/owner_password")\"}" |
  node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).accessToken')"
runner_id="$(node -pe 'require(process.argv[1]).probeRunner.id' "$state/staging.json")"
curl -fsS -X POST "$origin/api/runners/$runner_id/rotate-token" -H "Authorization: Bearer $access" > "$out/5-rotated.json" ||
  fail "rotating the probe runner's token failed"
revoked() { [ "$(metric 'link_disconnects_total{reason="revoked"}')" -gt "$revoked_before" ]; }
wait_until 45 "the revoked runner's connection closed" revoked
code="$(curl_link -o "$out/5-old-token.json" -w '%{http_code}' "${upgrade[@]}" -H "Authorization: Bearer $old_link_token" "$link")"
[ "$code" = 401 ] && grep -q '"reason":"REVOKED"' "$out/5-old-token.json" || fail "the revoked credential's token answered $code"
kill "$runner" 2>/dev/null || true
wait "$runner" 2>/dev/null || true
(umask 077; node -pe 'require(process.argv[1]).token' "$out/5-rotated.json" > "$token_file")
rm -f "$out/5-rotated.json"
client -duration 8s -summary "$out/5-client-new-token.json" > "$out/5-client-new-token.log" 2>&1 ||
  fail "the runner does not connect with its new token"
check_json "$out/5-client-new-token.json" 's.connects === 1 && s.heartbeatAcks >= 1'
grep -q 'CLOSE_CODE_UNAUTHENTICATED' "$out/5-client.json" || fail "the revoked runner was not told why"

curl -fsS "$metrics" > "$out/metrics-final.txt"
log "all five steps hold; records in $out"
