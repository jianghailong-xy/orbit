#!/usr/bin/env bash
# The whole integration run from nothing: rebuild from the checkout, a fresh database, fresh runners (their
# ORBIT_HOME, HOME and Default ~/.kimi-code), a fresh fake Kimi server, then scenarios 1→6 in order. Every
# scenario writes its own log and screenshots under shots/<n>-…/; this prints one PASS/FAIL line per scenario
# and exits non-zero if any failed.
set -uo pipefail
HERE=$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)
S=$(realpath -m "${KIMI_STACK_DIR:-/var/tmp/kimi-accounts-stack}")
cd "$HERE"
./stack.sh down || true
./stack.sh clean || true
rm -rf "$S/runners" "$S/shots" "$S/logs" "$S/run" "$S/fake-kimi-state.json" "$S/seed.json" "$S/accounts.json" "$S/secrets.env"
mkdir -p "$S/logs"
set -e
./stack.sh build
./stack.sh db
FAKE_KIMI_ACCESS_TTL=86400 ./stack.sh fake-kimi
./stack.sh api
./stack.sh web
./stack.sh main-web
node seed.mjs
set +e
status=0
for n in 1 2 3 4 5 6; do
  node "scenario$n.mjs" > "$S/logs/run-scenario$n.out" 2>&1
  code=$?
  grep -h "SCENARIO $n" "$S/logs/run-scenario$n.out" || echo "SCENARIO $n: no verdict (exit $code)"
  [ "$code" = 0 ] || status=1
done
./stack.sh status
exit $status
