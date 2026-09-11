#!/usr/bin/env bash
# The Codex reset-credit read and its monotonic snapshot, as named tests that each have to RUN and
# PASS (docs/codex-rate-limit-reset-contract.md §2, §3 and §8).
#
#   bash scripts/test-codex-reset-read.sh
#
# WHAT RUNS
#   1. runner-go: the read, the account fingerprint, the account scope, the probe cache and the
#      heartbeat, against contracts/codex-rate-limit-reset.fixtures.json served by a fake
#      `codex app-server`.
#   2. apiserver on PostgreSQL: codex-reset-plan-usage.pg.spec.ts through scripts/run-pg-spec.sh,
#      which provisions a disposable server, builds the test tree and counts a skip as red.
#   3. apiserver: codex-reset-plan-usage.spec.ts, from the tree step 2 built.
#
# WHAT COUNTS AS GREEN
#   Every declared name is seen passing, and nothing reports a failure, a skip or a todo. Exit codes
#   alone are not trusted: `go test -run` exits 0 when its pattern selects nothing, and `node --test`
#   exits 0 when every case skipped.
#
# NO REAL ACCOUNT
#   The runner-go tests run with HOME, ORBIT_HOME and CODEX_HOME in a scratch directory, without
#   CODEX_API_KEY or any OPENAI_* variable, and behind a `codex` on PATH that turns the run red if
#   anything reaches it instead of a test's own fake. Nothing here answers
#   account/rateLimitResetCredit/consume.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="$REPO/src/apiserver"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/codex-reset-read.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

GO_TESTS=(
  TestCodexResetReadKeepsTopLevelCreditsLossless
  TestCodexResetReadStampsFetchedAtAndProcessGeneration
  TestCodexAccountFingerprintKeyIsCreatedOnceAndPrivate
  TestCodexResetReadMarksUnsupportedAuthAndUnidentifiedAccounts
  TestCodexResetOverrideAccountsNeverOpenReset
  TestCodexResetProbeCacheOnlyMovesForward
  TestCodexUsageProbeReadsResetThroughAFakeAppServer
  TestCodexResetProviderReadsMapLosslessly
  TestCodexResetDetailCapNeverChangesTheCount
  TestCodexAccountFingerprintIsKeyedAndOpaque
  TestCodexResetBlockCarriesNoRawAccountData
  TestCodexResetLegacyHeartbeatStillParsesUnchanged
  TestCodexResetHeartbeatCarriesTheBlockNestedAndFlat
  TestPlanUsageProbeMergesRollingCodexWindow
  TestPlanUsageProbeIgnoresRollingUpdatesForOtherBuckets
  TestPlanUsageProbeIgnoresOtherBucketsBeforeAnyRead
  TestPlanUsageProbeTracksNonDefaultPlanBucket
)

PG_SPEC="src/apiserver/src/runner-api/codex-reset-plan-usage.pg.spec.ts"
PG_TESTS=(
  "the planUsage compare-and-set against PostgreSQL"
  "a runner that never reported (NULL) is written, and a value re-read and sent back matches"
  "an older read from an old process keeps the stored block while the rest of its report lands"
  "a newer block written between the read and the write makes the stale write match nothing"
  "two processes heartbeating at once, round after round, never leave an older block stored"
)

API_SPEC="build/runner-api/codex-reset-plan-usage.spec.js"
API_TESTS=(
  "a heartbeat stores the reset block losslessly: credits null, truncated details and a count above the listed rows"
  "an older read delivered after a newer one — the same process out of order — cannot take the stored block back"
  "an old process cannot overwrite a newer process block: an older read or the same millisecond is refused, a later read is not"
  "a block the heartbeat process did not read, or any block on a heartbeat without a leaseOwner, is never stored"
  "a Codex snapshot without a block or with an invalid one keeps the stored block, and a heartbeat without Codex usage is stored as before"
  "a block carrying raw account data is refused and never stored"
  "the write is a compare-and-set: a newer block stored between the read and the write is merged against, never overwritten"
  "a writer that keeps losing gives up after PLAN_USAGE_CAS_ATTEMPTS attempts without writing"
  "an override context never opens reset on the stored default-account block, and unsupported auth is refused on its own"
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

# --- 1. runner-go ---------------------------------------------------------------------------------
echo "==> runner-go: ${#GO_TESTS[@]} named tests (HOME, ORBIT_HOME and CODEX_HOME in $SCRATCH)"
mkdir -p "$SCRATCH/home" "$SCRATCH/orbit" "$SCRATCH/codex-home" "$SCRATCH/guard-bin"
cat > "$SCRATCH/guard-bin/codex" <<EOF
#!/bin/sh
echo "codex \$*" >> "$SCRATCH/guard-hits"
echo "test-codex-reset-read: a test reached the codex binary on PATH instead of its own fake" >&2
exit 97
EOF
chmod +x "$SCRATCH/guard-bin/codex"
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
grep -Eq '^[[:space:]]*--- (FAIL|SKIP):' "$GO_LOG" && red "runner-go: a test failed or skipped"
for name in "${GO_TESTS[@]}"; do
  grep -Eq "^--- PASS: $name \(" "$GO_LOG" || red "runner-go: $name did not report PASS"
done
[ -e "$SCRATCH/guard-hits" ] && red "runner-go: the codex binary on PATH was run: $(tr '\n' ';' < "$SCRATCH/guard-hits")"

# --- 2. apiserver on PostgreSQL -------------------------------------------------------------------
echo "==> apiserver: $PG_SPEC on a disposable PostgreSQL"
PG_LOG="$SCRATCH/pg.log"
bash "$REPO/scripts/run-pg-spec.sh" "$PG_SPEC" 2>&1 | tee "$PG_LOG"
pg_rc=${PIPESTATUS[0]}
[ "$pg_rc" = 0 ] || red "apiserver pg: run-pg-spec.sh exited $pg_rc"
for name in "${PG_TESTS[@]}"; do
  tap_passed "$PG_LOG" "$name" || red "apiserver pg: \"$name\" did not report ok"
done

# --- 3. apiserver ---------------------------------------------------------------------------------
echo "==> apiserver: $API_SPEC"
API_LOG="$SCRATCH/api.log"
if [ -f "$API/$API_SPEC" ]; then
  ( cd "$API" && NODE_OPTIONS='' node --test --test-concurrency=1 --test-reporter=tap --test-reporter-destination=stdout "$API_SPEC" ) 2>&1 | tee "$API_LOG"
  api_rc=${PIPESTATUS[0]}
  [ "$api_rc" = 0 ] || red "apiserver: node --test exited $api_rc"
  for key in fail cancelled skipped todo; do
    [ "$(tap_count "$API_LOG" "$key")" = 0 ] || red "apiserver: $(tap_count "$API_LOG" "$key") $key"
  done
  [ "$(tap_count "$API_LOG" pass)" -ge "${#API_TESTS[@]}" ] || red "apiserver: $(tap_count "$API_LOG" pass) passed, ${#API_TESTS[@]} declared"
  for name in "${API_TESTS[@]}"; do
    tap_passed "$API_LOG" "$name" || red "apiserver: \"$name\" did not report ok"
  done
else
  red "apiserver: $API_SPEC was not built (see the run-pg-spec.sh output above)"
fi

echo
if [ "${#RED[@]}" -gt 0 ]; then
  printf 'RED: %s\n' "${RED[@]}"
  exit 1
fi
echo "==> OK: ${#GO_TESTS[@]} runner-go tests, ${#PG_TESTS[@]} PostgreSQL cases and ${#API_TESTS[@]} apiserver cases passed, none skipped"
exit 0
