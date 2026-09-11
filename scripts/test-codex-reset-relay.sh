#!/usr/bin/env bash
# The Codex rate-limit reset relay — the command a heartbeat hands a runner process, the result it
# posts and the receipt it gets (docs/codex-rate-limit-reset-contract.md §6.2–§6.5) — witnessed against
# a disposable PostgreSQL, with a scripted runner fixture and with this repository's Go runner.
#
#   bash scripts/test-codex-reset-relay.sh
#
# WHAT RUNS
#   1. runner-go: the relay's named tests against a scripted control plane, the contract tests that pin
#      the Go mirror to contracts/codex-rate-limit-reset.*.json, and a build of the live relay test
#      (-tags codexresetlive) for step 2.
#   2. apiserver on PostgreSQL: runner-api/codex-reset-relay.pg.spec.ts through scripts/run-pg-spec.sh,
#      which provisions a disposable server, builds the test tree and counts a skip as red. It drives the
#      real heartbeat and result routes the way a runner does, and its case (13) runs step 1's Go binary
#      against them.
#   3. apiserver: the heartbeat specs whose runners send none of the reset fields, from the tree step 2
#      built — the old runner paths, unchanged.
#   4. @orbit/shared: the contract spec, the TypeScript half of what step 1's contract tests pin.
#
# WHERE EACH DECLARED SCENARIO RUNS
#   command lost ............. pg (4); the live Go test, step 2 of it
#   receipt lost ............. pg (7); TestCodexResetRelayResendsAResultUntilItHasAReceipt; the live Go test
#   duplicate / reordered .... pg (6), (8), (9); TestCodexResetRelayStartsEachClaimOncePerProcess
#   restart .................. pg (5) the apiserver, (6) the runner process
#   old runner ............... pg (1), (11); step 3; TestCodexResetLegacyHeartbeatStillParsesUnchanged
#   lease / draining ......... pg (2), (10), (12); TestCodexResetRelayHandsBackOnlyAnUnstartedClaimWhenDraining
#
# WHAT COUNTS AS GREEN
#   Every declared name is seen passing, and nothing reports a failure, a skip or a todo. Exit codes alone
#   are not trusted: `go test -run` exits 0 when its pattern selects nothing, and `node --test` exits 0
#   when every case skipped.
#
# NO REAL ACCOUNT
#   Every step runs without CODEX_API_KEY or any OPENAI_* variable and behind a `codex` on PATH that turns
#   the run red if anything reaches it; Go runs with HOME, ORBIT_HOME and CODEX_HOME in a scratch
#   directory. The executors are the tests' own functions: nothing here calls a provider method.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="$REPO/src/apiserver"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/codex-reset-relay.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

GO_TESTS=(
  TestCodexResetRelayStartsEachClaimOncePerProcess
  TestCodexResetRelayActsOnNothingItMustNotActOn
  TestCodexResetRelayRefusesAConsumeOfAnotherProtocol
  TestCodexResetRelayHandsBackOnlyAnUnstartedClaimWhenDraining
  TestCodexResetRelayResendsAResultUntilItHasAReceipt
  TestCodexResetRelayStopsAtARefusalOrAnAnswerThatIsNoReceipt
  TestCodexResetRelayGivesUpAfterItsReceiptWindow
  TestCodexResetGoMirrorMatchesTheContractFieldByField
  TestCodexResetRunnerVocabularyMatchesTheContract
  TestCodexResetWireFixturesValidateLikeShared
  TestCodexResetLegacyHeartbeatStillParsesUnchanged
  TestCodexResetConsumeSendsOnlyThePersistedKey
  TestCodexResetCommandDispositionFencesLeaseAndFreshness
)

PG_SPEC="src/apiserver/src/runner-api/codex-reset-relay.pg.spec.ts"
PG_TESTS=(
  "(1) an old runner is answered as it always was and claims nothing, beside a capable process that does"
  "(2) only a capable, leased, non-draining process of the operation's own runner is handed the command"
  "(3) account scope: another account settles an unclaimed operation, after waiting out a fresh claim"
  "(4) a lost command is delivered again on the next heartbeat, byte for byte, with nothing written"
  "(5) an apiserver restart loses nothing: the new server redelivers the command and takes its result"
  "(6) a runner restart: the new process waits out the old claim, takes it over under the same key, and fences the old one"
  "(7) a lost receipt: the result sent again is a DUPLICATE that writes nothing, and a refreshed block is stored once"
  "(8) duplicated, reordered and late results never move an operation backwards, rewrite its outcome or change its key"
  "(9) a result is refused as the contract says, and a refusal writes nothing"
  "(10) draining: a draining process is handed nothing, RELEASED hands its claim back, and the successor claims it at once"
  "(11) deadlines settle at any heartbeat of the runner, an old runner's too, and a fresh claim holds them off"
  "(12) two processes heartbeating at once claim an operation exactly once"
  "(13) the Go runner relay against these routes: its heartbeat, the command, results and receipts over the wire"
)

OLD_RUNNER_SPECS=(
  build/runner-api/heartbeat-lease-owner.spec.js
  build/runner-api/runtime-default-heartbeat.spec.js
  build/runner-api/repos-root-heartbeat.spec.js
  build/runner-api/repo-health-heartbeat.spec.js
  build/runner-api/model-catalog-refresh-heartbeat.spec.js
  build/runner-api/engine-sign-out-alert.spec.js
  build/runner-api/engine-update-relay.spec.js
  build/runner-api/clone-dispatch.spec.js
  build/runner-api/merge-source-sha.spec.js
  build/runner-api/codex-reset-plan-usage.spec.js
  build/runner-api/source-pin-wire.spec.js
)

RED=()
red() { RED+=("$1"); echo "RED: $1"; }

# tap_passed <log> <name>: an `ok` line, at any depth, whose name is exactly <name> and carries no
# SKIP or TODO directive (a directive makes the name on that line longer than <name>).
tap_passed() {
  awk -v want="$2" '
    { line = $0; sub(/^[ \t]+/, "", line) }
    line ~ /^ok [0-9]+ - / { name = line; sub(/^ok [0-9]+ - /, "", name); if (name == want) found = 1 }
    END { exit found ? 0 : 1 }' "$1"
}
# tap_count <log> <key>: the last `# <key> N` summary line's N.
tap_count() { awk -v key="$2" '$1 == "#" && $2 == key { n = $3 } END { print n + 0 }' "$1"; }

# The guard every step runs behind: a `codex` that records being run and fails.
mkdir -p "$SCRATCH/home" "$SCRATCH/orbit" "$SCRATCH/codex-home" "$SCRATCH/guard-bin"
cat > "$SCRATCH/guard-bin/codex" <<EOF
#!/bin/sh
echo "codex \$*" >> "$SCRATCH/guard-hits"
echo "test-codex-reset-relay: something reached the codex binary on PATH" >&2
exit 97
EOF
chmod +x "$SCRATCH/guard-bin/codex"
for name in $(compgen -e | grep -E '^(OPENAI_.*|CODEX_API_KEY)$'); do unset "$name"; done
GUARDED_PATH="$SCRATCH/guard-bin:$PATH"

# --- 1. runner-go ---------------------------------------------------------------------------------
echo "==> runner-go: ${#GO_TESTS[@]} named tests (HOME, ORBIT_HOME and CODEX_HOME in $SCRATCH)"
GO_LOG="$SCRATCH/go.log"
LIVE_BINARY="$SCRATCH/runner-go-live.test"
(
  cd "$REPO/src/runner-go" || exit 2
  # The build and module caches stay where they are; only what a test could read an account from moves.
  export GOCACHE="$(go env GOCACHE)" GOMODCACHE="$(go env GOMODCACHE)" GOPATH="$(go env GOPATH)" GOENV="$(go env GOENV)"
  export HOME="$SCRATCH/home" ORBIT_HOME="$SCRATCH/orbit" CODEX_HOME="$SCRATCH/codex-home" PATH="$GUARDED_PATH"
  pattern="^($(IFS='|'; echo "${GO_TESTS[*]}"))\$"
  go test -count=1 -timeout 900s -run "$pattern" -v .
  echo "GO_TEST_EXIT=$?"
  go test -c -tags codexresetlive -o "$LIVE_BINARY" .
  echo "GO_LIVE_BUILD_EXIT=$?"
) 2>&1 | tee "$GO_LOG"
grep -q '^GO_TEST_EXIT=0$' "$GO_LOG" || red "runner-go: go test did not exit 0"
grep -q 'no tests to run' "$GO_LOG" && red "runner-go: the -run pattern selected no test"
grep -Eq '^[[:space:]]*--- (FAIL|SKIP):' "$GO_LOG" && red "runner-go: a test failed or skipped"
for name in "${GO_TESTS[@]}"; do
  grep -Eq "^--- PASS: $name \(" "$GO_LOG" || red "runner-go: $name did not report PASS"
done
if grep -q '^GO_LIVE_BUILD_EXIT=0$' "$GO_LOG" && [ -x "$LIVE_BINARY" ]; then
  export ORBIT_CODEX_RESET_LIVE_TEST_BINARY="$LIVE_BINARY"
else
  red "runner-go: the live relay test (-tags codexresetlive) did not build"
fi

# --- 2. apiserver on PostgreSQL -------------------------------------------------------------------
echo "==> apiserver: $PG_SPEC on a disposable PostgreSQL"
PG_LOG="$SCRATCH/pg.log"
PATH="$GUARDED_PATH" bash "$REPO/scripts/run-pg-spec.sh" "$PG_SPEC" 2>&1 | tee "$PG_LOG"
pg_rc=${PIPESTATUS[0]}
[ "$pg_rc" = 0 ] || red "apiserver pg: run-pg-spec.sh exited $pg_rc"
for name in "${PG_TESTS[@]}"; do
  tap_passed "$PG_LOG" "$name" || red "apiserver pg: \"$name\" did not report ok"
done

# --- 3. the old runner paths ----------------------------------------------------------------------
echo "==> apiserver: ${#OLD_RUNNER_SPECS[@]} heartbeat specs of runners that send no reset field"
OLD_LOG="$SCRATCH/old.log"
missing=0
for js in "${OLD_RUNNER_SPECS[@]}"; do
  [ -f "$API/$js" ] || { red "apiserver: $js was not built (see the run-pg-spec.sh output above)"; missing=1; }
done
if [ "$missing" = 0 ]; then
  ( cd "$API" && PATH="$GUARDED_PATH" NODE_OPTIONS='' node --test --test-concurrency=1 --test-reporter=tap \
      --test-reporter-destination=stdout "${OLD_RUNNER_SPECS[@]}" ) 2>&1 | tee "$OLD_LOG"
  old_rc=${PIPESTATUS[0]}
  [ "$old_rc" = 0 ] || red "apiserver: the old runner heartbeat specs exited $old_rc"
  for key in fail cancelled skipped todo; do
    [ "$(tap_count "$OLD_LOG" "$key")" = 0 ] || red "apiserver: old runner heartbeat specs: $(tap_count "$OLD_LOG" "$key") $key"
  done
  [ "$(tap_count "$OLD_LOG" pass)" -gt 0 ] || red "apiserver: the old runner heartbeat specs passed nothing"
  echo "==== old runner heartbeats pass=$(tap_count "$OLD_LOG" pass) fail=$(tap_count "$OLD_LOG" fail) skipped=$(tap_count "$OLD_LOG" skipped)"
fi

# --- 4. @orbit/shared -----------------------------------------------------------------------------
echo "==> @orbit/shared: src/codexRateLimitReset.spec.ts"
VITEST="$REPO/node_modules/.bin/vitest"
SHARED_JSON="$SCRATCH/shared.json"
if [ -x "$VITEST" ]; then
  ( cd "$REPO/src/shared" && PATH="$GUARDED_PATH" "$VITEST" run src/codexRateLimitReset.spec.ts \
      --reporter=default --reporter=json --outputFile.json="$SHARED_JSON" ) 2>&1 | tail -15
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    console.log(`==== shared contract spec tests=${r.numTotalTests} pass=${r.numPassedTests} fail=${r.numFailedTests} skipped=${r.numPendingTests} todo=${r.numTodoTests}`);
    process.exit(r.success && r.numTotalTests > 0 && r.numFailedTests === 0 && r.numPendingTests === 0 && r.numTodoTests === 0 ? 0 : 1);
  ' "$SHARED_JSON" || red "@orbit/shared: the contract spec did not pass every case, or skipped one"
else
  red "@orbit/shared: no vitest at $VITEST (run-pg-spec.sh lays the node_modules overlay step 4 uses)"
fi

[ -e "$SCRATCH/guard-hits" ] && red "the codex binary on PATH was run: $(tr '\n' ';' < "$SCRATCH/guard-hits")"

echo
if [ "${#RED[@]}" -gt 0 ]; then
  printf 'RED: %s\n' "${RED[@]}"
  exit 1
fi
echo "==> OK: ${#GO_TESTS[@]} runner-go tests, ${#PG_TESTS[@]} PostgreSQL cases (the Go relay among them), the old runner heartbeats and the shared contract spec passed, none skipped"
exit 0
