#!/usr/bin/env bash
# The Codex rate-limit reset fault-injection harness (docs/codex-rate-limit-reset-runbook.md §5): every declared
# loss, duplication, reordering, timeout, restart, account or lease change and old-snapshot race, run across the
# real control plane and the real Go runner, each ending in a settled operation that is checked against the fake
# provider's ledger, the operation's history of rows, both sides' logs and a list of values no line may carry.
#
#   bash scripts/test-codex-reset-fault-injection.sh
#
# WHAT RUNS
#   1. runner-go: the hardening tests (no CONSUME_NOT_CALLED after a call, calls only under a fresh delivery, the
#      telemetry lines and their redaction, the probe's error text) and the consume and relay tests the hardening
#      changed; and a build of the fault-process binary (-tags codexresetfault) for step 2.
#   2. apiserver on PostgreSQL: runner-api/codex-reset-fault-injection.pg.spec.ts through scripts/run-pg-spec.sh,
#      which provisions a disposable server and counts a skip as red. Its 23 scenarios drive the real heartbeat and
#      result routes with step 1's Go runner processes, crash them with SIGKILL, restart the control plane, and put
#      a fault proxy between the two. Each scenario writes one line to the report printed at the end.
#   3. apiserver: the telemetry spec (what a log line and a metric label may hold) and the metrics route spec, from
#      the tree step 2 built.
#   4. @orbit/shared: the contract spec — claim renewal, the admission guard and the 250-seed interleaving walk.
#
# WHERE EACH DECLARED FAULT RUNS
#   command lost / delivered again ............. F2, F3
#   result lost / receipt lost / 503 ............ F4, F5
#   results duplicated, reordered, late ......... F6; the shared interleaving walk
#   app-server timeout / disconnect ............. F7, F8
#   runner killed before / after the consume .... F9, F10, F11
#   control plane restarted ..................... F12
#   refresh failing, and past its deadline ...... F13, F14
#   account switched before / during / after .... F15, F16, F17
#   lease missing, second live process, draining  F18, F19, F20
#   old process's older snapshot ................ F21
#   partitioned holder taken over ............... F22
#   consume deadline ............................ F23
#
# WHAT COUNTS AS GREEN
#   Every declared name is seen passing and nothing reports a failure, a skip or a todo; every scenario wrote its
#   report line, and every line says zero leaks, zero consume calls after confirmation, only the operation's key
#   sent and at most one credit spent. Exit codes alone are not trusted: `go test -run` exits 0 when its pattern
#   selects nothing, and `node --test` exits 0 when every case skipped.
#
# NO REAL ACCOUNT, NO REAL CREDIT
#   Every step runs without CODEX_API_KEY or any OPENAI_* variable, behind a `codex` on PATH that turns the run red
#   if anything reaches it. Go runs with HOME, ORBIT_HOME and CODEX_HOME in a scratch directory; each scenario's
#   runner processes find the fake app-server first on their own PATH, with credits in a temporary file.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="$REPO/src/apiserver"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/codex-reset-fault.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

GO_TESTS=(
  TestCodexResetConsumeNeverReportsNotCalledOnceACallWentOut
  TestCodexResetConsumeCallsOnlyWhileItsClaimIsDelivered
  TestCodexResetCallFreshnessEndsCallsInsideTheTakeoverWindow
  TestCodexResetLogLinesCarryTheOperationAndNothingSecret
  TestCodexResetStepLogsItsStagesUnderTheOperation
  TestPlanUsageProbeLogsNoProviderErrorText
  TestCodexResetConsumeRetriesWithoutAnOutcomeUnderTheSameKey
  TestCodexResetRefreshFollowsOnlyAConfirmedConsume
  TestCodexResetConsumeRecoversFromACrashAtEveryCheckpoint
  TestCodexResetRelayStartsEachClaimOncePerProcess
  TestCodexResetRelayHandsBackOnlyAnUnstartedClaimWhenDraining
  TestCodexResetRelayResendsAResultUntilItHasAReceipt
  TestCodexResetCommandDispositionFencesLeaseAndFreshness
)

PG_SPEC="src/apiserver/src/runner-api/codex-reset-fault-injection.pg.spec.ts"
PG_TESTS=(
  "(F1) baseline: one process claims, consumes once under the key and refreshes"
  "(F2) a lost command: the claim was written, its response never arrived, the next heartbeat delivers it again"
  "(F3) a command delivered again and again while its step runs starts nothing new"
  "(F4) a result lost on the way, then refused 503: sent again byte for byte and applied once"
  "(F5) a lost receipt: the result was applied, its resend is a DUPLICATE, and the refresh follows"
  "(F6) duplicated, reordered and late results after the outcome never move the operation"
  "(F7) an app-server that never answers the consume: the call times out and is retried under the same key"
  "(F8) an app-server that dies after the provider spent: retried, answered alreadyRedeemed, one credit"
  "(F9) the runner killed before its consume call: the successor takes the claim over and consumes once"
  "(F10) the runner killed after the provider spent but before it heard: the successor is answered alreadyRedeemed"
  "(F11) the runner killed after its consume was confirmed: the successor only refreshes, and no key reaches it"
  "(F12) the control plane restarted before and after the confirmation: nothing is lost and nothing repeats"
  "(F13) a refresh that fails twice is read again; the confirmed consume is not touched"
  "(F14) a refresh failing past its deadline settles REFRESH_FAILED, keeps the consume, and admission waits for a later read"
  "(F15) the account switched before any claim: settled NOT_ATTEMPTED, nothing called"
  "(F16) the account switched after a call that may have spent: never NOT_ATTEMPTED, settled UNRESOLVED"
  "(F17) the account switched after the consume was confirmed: only the refresh fails"
  "(F18) lease: no leaseOwner or capability claims nothing, and a second live process never takes a claim its holder renews"
  "(F19) draining: an unstarted claim is handed back and taken at once by the successor"
  "(F20) draining after a call: the holder is handed nothing, stops calling, and its successor settles the operation"
  "(F21) an old process's older read, delivered late, never takes the stored block back"
  "(F22) a partitioned holder is taken over; back online it is refused and never calls after the confirmation"
  "(F23) a consume that never gets an outcome settles UNRESOLVED at its deadline, and admission waits for a later read"
)

NODE_SPECS=(
  build/runners/codex-reset-telemetry.spec.js
  build/metrics/metrics.controller.spec.js
)

RED=()
red() { RED+=("$1"); echo "RED: $1"; }

# tap_passed <log> <name>: an `ok` line, at any depth, whose name is exactly <name> and carries no SKIP or TODO
# directive (a directive makes the name on that line longer than <name>).
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
echo "test-codex-reset-fault-injection: something reached the codex binary on PATH" >&2
exit 97
EOF
chmod +x "$SCRATCH/guard-bin/codex"
for name in $(compgen -e | grep -E '^(OPENAI_.*|CODEX_API_KEY)$'); do unset "$name"; done
GUARDED_PATH="$SCRATCH/guard-bin:$PATH"

# --- 1. runner-go ---------------------------------------------------------------------------------
echo "==> runner-go: ${#GO_TESTS[@]} named tests (HOME, ORBIT_HOME and CODEX_HOME in $SCRATCH)"
GO_LOG="$SCRATCH/go.log"
FAULT_BINARY="$SCRATCH/runner-go-fault.test"
(
  cd "$REPO/src/runner-go" || exit 2
  # The build and module caches stay where they are; only what a test could read an account from moves.
  export GOCACHE="$(go env GOCACHE)" GOMODCACHE="$(go env GOMODCACHE)" GOPATH="$(go env GOPATH)" GOENV="$(go env GOENV)"
  export HOME="$SCRATCH/home" ORBIT_HOME="$SCRATCH/orbit" CODEX_HOME="$SCRATCH/codex-home" PATH="$GUARDED_PATH"
  pattern="^($(IFS='|'; echo "${GO_TESTS[*]}"))\$"
  go test -count=1 -timeout 900s -run "$pattern" -v .
  echo "GO_TEST_EXIT=$?"
  go test -c -tags codexresetfault -o "$FAULT_BINARY" .
  echo "GO_FAULT_BUILD_EXIT=$?"
) 2>&1 | tee "$GO_LOG"
grep -q '^GO_TEST_EXIT=0$' "$GO_LOG" || red "runner-go: go test did not exit 0"
grep -q 'no tests to run' "$GO_LOG" && red "runner-go: the -run pattern selected no test"
grep -Eq '^[[:space:]]*--- (FAIL|SKIP):' "$GO_LOG" && red "runner-go: a test failed or skipped"
for name in "${GO_TESTS[@]}"; do
  grep -Eq "^--- PASS: $name \(" "$GO_LOG" || red "runner-go: $name did not report PASS"
done
if grep -q '^GO_FAULT_BUILD_EXIT=0$' "$GO_LOG" && [ -x "$FAULT_BINARY" ]; then
  export ORBIT_CODEX_RESET_FAULT_BINARY="$FAULT_BINARY"
else
  red "runner-go: the fault-process binary (-tags codexresetfault) did not build"
fi

# --- 2. the fault-injection scenarios on PostgreSQL ------------------------------------------------
echo "==> apiserver: $PG_SPEC on a disposable PostgreSQL, with the Go runner processes and the fake Codex"
PG_LOG="$SCRATCH/pg.log"
REPORT="$SCRATCH/fault-report.jsonl"
: > "$REPORT"
# 23 scenarios with real processes and backoffs outrun run-pg-spec.sh's 600-second default for one file.
ORBIT_CODEX_RESET_FAULT_REPORT="$REPORT" RUN_PG_SPEC_TIMEOUT="${RUN_PG_SPEC_TIMEOUT:-2400}" PATH="$GUARDED_PATH" \
  bash "$REPO/scripts/run-pg-spec.sh" "$PG_SPEC" 2>&1 | tee "$PG_LOG"
pg_rc=${PIPESTATUS[0]}
[ "$pg_rc" = 0 ] || red "apiserver pg: run-pg-spec.sh exited $pg_rc"
for name in "${PG_TESTS[@]}"; do
  tap_passed "$PG_LOG" "$name" || red "apiserver pg: \"$name\" did not report ok"
done
node -e '
  const fs = require("fs");
  const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const expected = Number(process.argv[2]);
  const bad = lines.filter((entry) =>
    entry.redaction.leaks !== 0 || entry.consumeCallsAfterConfirmation !== 0 ||
    entry.everyCallCarriedTheOperationKey !== true || entry.creditsSpent > 1);
  console.log("==== fault-injection report: " + lines.length + " scenario(s)");
  for (const entry of lines) {
    console.log([entry.scenario.padEnd(46), entry.final.status.padEnd(15), String(entry.final.failureCode ?? "-").padEnd(16),
      "calls=" + entry.consumeCalls, "afterConfirm=" + entry.consumeCallsAfterConfirmation, "spent=" + entry.creditsSpent,
      "claim=" + entry.final.claimGeneration, "leaks=" + entry.redaction.leaks, "trace=" + entry.statusTrace.join(">")].join("  "));
  }
  console.log("==== report lines follow, one JSON object per scenario");
  for (const entry of lines) console.log(JSON.stringify(entry));
  process.exit(lines.length === expected && bad.length === 0 ? 0 : 1);
' "$REPORT" "${#PG_TESTS[@]}" || red "fault-injection report: not one clean line per scenario"
if [ -n "${ORBIT_CODEX_RESET_FAULT_REPORT_OUT:-}" ]; then cp "$REPORT" "$ORBIT_CODEX_RESET_FAULT_REPORT_OUT"; fi

# --- 3. the telemetry specs -------------------------------------------------------------------------
echo "==> apiserver: ${#NODE_SPECS[@]} telemetry specs from the tree step 2 built"
NODE_LOG="$SCRATCH/node.log"
missing=0
for js in "${NODE_SPECS[@]}"; do
  [ -f "$API/$js" ] || { red "apiserver: $js was not built (see the run-pg-spec.sh output above)"; missing=1; }
done
if [ "$missing" = 0 ]; then
  ( cd "$API" && PATH="$GUARDED_PATH" NODE_OPTIONS='' node --test --test-concurrency=1 --test-reporter=tap \
      --test-reporter-destination=stdout "${NODE_SPECS[@]}" ) 2>&1 | tee "$NODE_LOG"
  node_rc=${PIPESTATUS[0]}
  [ "$node_rc" = 0 ] || red "apiserver: the telemetry specs exited $node_rc"
  for key in fail cancelled skipped todo; do
    [ "$(tap_count "$NODE_LOG" "$key")" = 0 ] || red "apiserver: telemetry specs: $(tap_count "$NODE_LOG" "$key") $key"
  done
  [ "$(tap_count "$NODE_LOG" pass)" -gt 0 ] || red "apiserver: the telemetry specs passed nothing"
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
echo "==> OK: ${#GO_TESTS[@]} runner-go tests, ${#PG_TESTS[@]} fault-injection scenarios with clean report lines, the telemetry specs and the shared contract spec passed, none skipped"
exit 0
