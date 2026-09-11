#!/usr/bin/env bash
# The Codex rate-limit reset consume and its authoritative refresh — what a runner process does with the
# CONSUME or REFRESH command a heartbeat hands it (docs/codex-rate-limit-reset-contract.md §6.4) — against a
# programmable fake `codex app-server` and a control plane that keeps the operation as @orbit/shared does.
#
#   bash scripts/test-codex-reset-consume.sh
#
# WHAT RUNS
#   runner-go, by name: the consume tests (src/runner-go/codex_rate_limit_reset_consume_test.go); the relay
#   tests whose relay hands the consume its commands; the contract tests that pin the command, its key and
#   the result vocabulary to contracts/codex-rate-limit-reset.*.json; and the probe test whose app-server
#   path and reader the consume shares.
#
# WHERE EACH DECLARED SCENARIO RUNS
#   request order and the one key ........ TestCodexResetConsumeCallsTheProviderInOrderUnderThePersistedKey
#   every outcome and its status ......... TestCodexResetConsumeMapsEachOutcomeToItsOperationStatus
#   runner and account scope, no call .... TestCodexResetConsumeCallsNothingForAnAccountItCannotVouchFor
#   capability ........................... TestCodexResetCapabilityIsDeclaredWithTheConsumeThatServesIt
#   transport and protocol errors ........ TestCodexResetConsumeRetriesWithoutAnOutcomeUnderTheSameKey
#   consume apart from the refresh ....... TestCodexResetRefreshFollowsOnlyAConfirmedConsume
#   crash and restart recovery ........... TestCodexResetConsumeRecoversFromACrashAtEveryCheckpoint
#
# WHAT COUNTS AS GREEN
#   Every declared test, and every declared scenario inside one, is seen passing, and nothing reports a
#   failure or a skip. Exit codes alone are not trusted: `go test -run` exits 0 when its pattern selects
#   nothing.
#
# NO REAL ACCOUNT, NO REAL CREDIT
#   Go runs without CODEX_API_KEY or any OPENAI_* variable, with HOME, ORBIT_HOME and CODEX_HOME in a scratch
#   directory, and behind a `codex` on PATH that turns the run red if anything reaches it. Each consume test
#   puts its own fake provider first on PATH, and that provider's credits are a file in a temporary directory.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/codex-reset-consume.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

GO_TESTS=(
  TestCodexResetConsumeCallsTheProviderInOrderUnderThePersistedKey
  TestCodexResetConsumeMapsEachOutcomeToItsOperationStatus
  TestCodexResetConsumeCallsNothingForAnAccountItCannotVouchFor
  TestCodexResetConsumeRetriesWithoutAnOutcomeUnderTheSameKey
  TestCodexResetRefreshFollowsOnlyAConfirmedConsume
  TestCodexResetConsumeRecoversFromACrashAtEveryCheckpoint
  TestCodexResetCapabilityIsDeclaredWithTheConsumeThatServesIt
  TestCodexResetRelayStartsEachClaimOncePerProcess
  TestCodexResetRelayActsOnNothingItMustNotActOn
  TestCodexResetRelayRefusesAConsumeOfAnotherProtocol
  TestCodexResetRelayHandsBackOnlyAnUnstartedClaimWhenDraining
  TestCodexResetRelayResendsAResultUntilItHasAReceipt
  TestCodexResetRelayStopsAtARefusalOrAnAnswerThatIsNoReceipt
  TestCodexResetRelayGivesUpAfterItsReceiptWindow
  TestCodexResetConsumeSendsOnlyThePersistedKey
  TestCodexResetCommandDispositionFencesLeaseAndFreshness
  TestCodexResetRunnerVocabularyMatchesTheContract
  TestCodexResetStatusDerivationMatchesTheContract
  TestCodexResetWireFixturesValidateLikeShared
  TestCodexUsageProbeReadsResetThroughAFakeAppServer
)

# The scenarios inside the consume tests, as t.Run names them (`go test -v` prints spaces as underscores).
GO_SCENARIOS=(
  "TestCodexResetConsumeMapsEachOutcomeToItsOperationStatus/reset"
  "TestCodexResetConsumeMapsEachOutcomeToItsOperationStatus/alreadyRedeemed"
  "TestCodexResetConsumeMapsEachOutcomeToItsOperationStatus/nothingToReset"
  "TestCodexResetConsumeMapsEachOutcomeToItsOperationStatus/noCredit"
  "TestCodexResetConsumeCallsNothingForAnAccountItCannotVouchFor/the operation's own account"
  "TestCodexResetConsumeCallsNothingForAnAccountItCannotVouchFor/another account is signed in"
  "TestCodexResetConsumeCallsNothingForAnAccountItCannotVouchFor/an API key login"
  "TestCodexResetConsumeCallsNothingForAnAccountItCannotVouchFor/signed out"
  "TestCodexResetConsumeCallsNothingForAnAccountItCannotVouchFor/a CLI without reset credits"
  "TestCodexResetConsumeCallsNothingForAnAccountItCannotVouchFor/custom API credentials in the runner's environment"
  "TestCodexResetConsumeCallsNothingForAnAccountItCannotVouchFor/a read that names no account is asked again"
  "TestCodexResetConsumeCallsNothingForAnAccountItCannotVouchFor/another process's claim"
  "TestCodexResetRefreshFollowsOnlyAConfirmedConsume/a lost receipt is sent again before the refresh starts"
  "TestCodexResetRefreshFollowsOnlyAConfirmedConsume/a result refused as a stale claim ends the step"
  "TestCodexResetRefreshFollowsOnlyAConfirmedConsume/a failed refresh is read again without touching the consume"
  "TestCodexResetRefreshFollowsOnlyAConfirmedConsume/another account after the consume fails the refresh for good"
  "TestCodexResetRefreshFollowsOnlyAConfirmedConsume/a REFRESH command only reads"
  "TestCodexResetConsumeRecoversFromACrashAtEveryCheckpoint/the provider spent the credit and its answer never reached the runner"
  "TestCodexResetConsumeRecoversFromACrashAtEveryCheckpoint/the outcome was answered and never reached the control plane"
  "TestCodexResetConsumeRecoversFromACrashAtEveryCheckpoint/the control plane confirmed the outcome and its receipt was never read"
  "TestCodexResetConsumeRecoversFromACrashAtEveryCheckpoint/the receipt was read and the authoritative read was in flight"
  "TestCodexResetConsumeRecoversFromACrashAtEveryCheckpoint/the refresh was read and never reached the control plane"
  "TestCodexResetConsumeRecoversFromACrashAtEveryCheckpoint/the control plane recorded the refresh and its receipt was never read"
  "TestCodexResetConsumeRecoversFromACrashAtEveryCheckpoint/the step had finished"
  "TestCodexResetConsumeRecoversFromACrashAtEveryCheckpoint/an unrecorded nothingToReset is asked again under the same key"
)

RED=()
red() { RED+=("$1"); echo "RED: $1"; }

# The guard the run goes behind: a `codex` that records being run and fails.
mkdir -p "$SCRATCH/home" "$SCRATCH/orbit" "$SCRATCH/codex-home" "$SCRATCH/guard-bin"
cat > "$SCRATCH/guard-bin/codex" <<EOF
#!/bin/sh
echo "codex \$*" >> "$SCRATCH/guard-hits"
echo "test-codex-reset-consume: something reached the codex binary on PATH instead of a test's own fake" >&2
exit 97
EOF
chmod +x "$SCRATCH/guard-bin/codex"

echo "==> runner-go: ${#GO_TESTS[@]} named tests, ${#GO_SCENARIOS[@]} named scenarios (HOME, ORBIT_HOME and CODEX_HOME in $SCRATCH)"
GO_LOG="$SCRATCH/go.log"
(
  cd "$REPO/src/runner-go" || exit 2
  # The build and module caches stay where they are; only what a test could read an account from moves.
  export GOCACHE="$(go env GOCACHE)" GOMODCACHE="$(go env GOMODCACHE)" GOPATH="$(go env GOPATH)" GOENV="$(go env GOENV)"
  for name in $(compgen -e | grep -E '^(OPENAI_.*|CODEX_API_KEY)$'); do unset "$name"; done
  export HOME="$SCRATCH/home" ORBIT_HOME="$SCRATCH/orbit" CODEX_HOME="$SCRATCH/codex-home" PATH="$SCRATCH/guard-bin:$PATH"
  pattern="^($(IFS='|'; echo "${GO_TESTS[*]}"))\$"
  go test -count=1 -timeout 900s -run "$pattern" -v .
) 2>&1 | tee "$GO_LOG"
go_rc=${PIPESTATUS[0]}
[ "$go_rc" = 0 ] || red "runner-go: go test exited $go_rc"
grep -q 'no tests to run' "$GO_LOG" && red "runner-go: the -run pattern selected no test"
grep -Eq '^[[:space:]]*--- (FAIL|SKIP):' "$GO_LOG" && red "runner-go: a test or a scenario failed or skipped"
for name in "${GO_TESTS[@]}"; do
  grep -Eq "^--- PASS: $name \(" "$GO_LOG" || red "runner-go: $name did not report PASS"
done
for name in "${GO_SCENARIOS[@]}"; do
  grep -Fq -- "--- PASS: ${name// /_} (" "$GO_LOG" || red "runner-go: scenario \"$name\" did not report PASS"
done
[ -e "$SCRATCH/guard-hits" ] && red "runner-go: the codex binary on PATH was run: $(tr '\n' ';' < "$SCRATCH/guard-hits")"

echo
if [ "${#RED[@]}" -gt 0 ]; then
  printf 'RED: %s\n' "${RED[@]}"
  exit 1
fi
echo "==> OK: ${#GO_TESTS[@]} runner-go tests and ${#GO_SCENARIOS[@]} scenarios passed against the fake app-server, none skipped"
exit 0
