#!/usr/bin/env bash
# Checks the server's cut-over switch, RUNNER_LINK_REQUIRED (docs/runner-link-design.md §11.3, §11.4; task D0), on the
# running staging stack, with the test runner (link-gateway client -drill switch, src/link-gateway/client_switch.go)
# and the stack's own state, and keeps what each step saw in <state>/client/check-switch/:
#
#   1. The switch drill, the owner (the stack's administrator) flipping it. Off: the probe runner's shadow connection is
#      welcomed in MODE_HTTP and HTTPS serves the daemon. On: an HTTPS daemon call is answered 426 UPGRADE_REQUIRED,
#      saying to run `orbit upgrade`; the same call naming its caller (X-Orbit-Runner-Caller) is served; the shadow's
#      connection is told MODE_LINK and forwards nothing; the work connection is welcomed in MODE_LINK, and a session
#      is claimed there and its events stored. Off in the middle of that stream: the work connection is told MODE_HTTP
#      with nothing to apply, its requests are refused LINK_MODE_HTTP, the event batches it still sends are stored; the
#      runner leaves and sends the rest over HTTPS, the last batch again first; a new connection is welcomed in MODE_HTTP.
#   2. The stack's own record of it: the gateway tells runners MODE_HTTP again and read the switch with no failure, both
#      services logged each switch, and the database holds the session's seqs 1..N, each once.
#
# Run it with the gateway following the switch: ORBIT_LINK_STAGING_MODE=http, the default (LINK_MODE=link pins
# MODE_LINK), in the files TLS mode, with no other runner connected. The switch is left off. It exits non-zero at the
# first step that does not hold.
set -euo pipefail
# shellcheck source=staging-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/staging-lib.sh"

[ -f "$env_file" ] || die "no staging stack in $state: run staging-up.sh first"
[ "$(setting STAGING_TLS files)" = files ] || die "the check runs in the files TLS mode"
[ "$(setting STAGING_MODE http)" = http ] || die "the gateway is pinned to MODE_LINK: ORBIT_LINK_STAGING_MODE=http $here/staging-up.sh --no-build"
out="$state/client/check-switch"
rm -rf "$out"
mkdir -p "$out"

metrics="http://127.0.0.1:$(setting STAGING_METRICS_PORT 19464)/metrics"
pg="$project-postgres"
secrets="$state/secrets"
owner=(-owner-email owner@orbit-staging.test -owner-password-file "$secrets/owner_password")

step() { log "$*"; }
fail() { die "$* (records in $out)"; }
metric() { curl -fsS "$metrics" | awk -v n="$1" '$1 == n { print $2 }'; }
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

step "1. the switch drill: on, then off in the middle of a session's event stream"
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
snapshot "$out/1-metrics-before.txt"
client -drill switch "${owner[@]}" -report "$out/1-switch.json" > "$out/1-switch.log" 2>&1 || fail "the switch drill"
snapshot "$out/1-metrics-after.txt"
check_json "$out/1-switch.json" 's.ok && s.steps.length >= 20 && s.steps.every((x) => x.ok)'
node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (const x of s.steps) console.error(`    ok   ${x.name} (${x.ms} ms): ${x.detail}`);' "$out/1-switch.json"

step "2. the stack's record: MODE_HTTP again, every read of the switch answered, each switch logged, every seq stored once"
[ "$(metric link_mode_link)" = 0 ] || fail "the gateway still tells runners MODE_LINK"
deltas "$out/1-metrics-before.txt" "$out/1-metrics-after.txt" \
  'link_mode_fetches_total{result="ok"} >= 2' \
  'link_mode_fetches_total{result="error"} + link_mode_fetches_total{result="unauthorized"} + link_mode_fetches_total{result="not_configured"} == 0' \
  'link_rpcs_total{result="not_forwarded"} >= 2' 'link_event_batches_total{result="stored"} >= 6' 'link_event_batches_total{result="gap"} == 0'
docker logs --since "$started" "$project-link-gateway" > "$out/2-gateway.log" 2>&1
docker logs --since "$started" "$project-apiserver" > "$out/2-apiserver.log" 2>&1
for line in 'RUNNER_LINK_REQUIRED switched: runners are told MODE_LINK' 'RUNNER_LINK_REQUIRED switched: runners are told MODE_HTTP'; do
  grep -q "$line" "$out/2-gateway.log" || fail "the gateway did not log \"$line\""
done
for line in 'RUNNER_LINK_REQUIRED switched on by administrator' 'RUNNER_LINK_REQUIRED switched off by administrator'; do
  grep -q "$line" "$out/2-apiserver.log" || fail "the apiserver did not log \"$line\""
done
session="$(json_field "$out/1-switch.json" 'facts.sessionUuid')"
final="$(json_field "$out/1-switch.json" 'facts.finalSeq')"
rows="$(psql_value "SELECT count(*) || ' ' || count(DISTINCT seq) || ' ' || COALESCE(min(seq), 0) || ' ' || COALESCE(max(seq), 0) FROM run_event WHERE session_id = '$session'")"
printf 'session %s: acknowledged over the link through %s before the switch went off and %s after; last seq %s; rows, distinct seqs, min, max: %s\n' \
  "$session" "$(json_field "$out/1-switch.json" 'facts.ackedBeforeOff')" "$(json_field "$out/1-switch.json" 'facts.ackedOnTheLink')" \
  "$final" "$rows" | tee "$out/2-db.txt" >&2
[ "$rows" = "$final $final 1 $final" ] || fail "the session's stored seqs are not 1..$final, each once"
switched="$(psql_value "SELECT required FROM runner_link_switch WHERE id = 1")"
[ "$switched" = f ] || fail "the switch was left $switched"

snapshot "$out/metrics-final.txt"
log "both steps hold; records in $out"
