#!/usr/bin/env bash
# Focused pcc allocator/cleanup/target rebind. It cannot schedule the complete Release DAG.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$REPO/build/outcome-reconciler-release-dag-pcc-rebind"
STATE="$BUILD/state"
TAP="$BUILD/plan-and-pcc.tap"
FOCUS_LOG="$BUILD/focused-pcc.log"
MANIFEST="$REPO/build/outcome-reconciler-release-dag-pcc-rebind-manifest.json"

rm -rf -- "$BUILD"
mkdir -p "$STATE"

echo '==> release-dag-pcc-rebind: validate the frozen DAG without scheduling nodes'
timeout -k 5 30 node "$REPO/scripts/outcome-reconciler-release-dag.mjs" --check-plan \
  >"$STATE/plan-check.json"

echo '==> release-dag-pcc-rebind: run zero-skip allocator, safety and binding regressions'
set +e
timeout -k 10 180 node --test --test-concurrency=1 --test-reporter=tap \
  "$REPO/test/outcome-reconciler-release-dag-plan.test.mjs" \
  "$REPO/test/outcome-reconciler-release-dag-pcc-rebind.test.mjs" 2>&1 | tee "$TAP"
TEST_RC=${PIPESTATUS[0]}
set -e
[ "$TEST_RC" -eq 0 ] || exit "$TEST_RC"

echo '==> release-dag-pcc-rebind: verify pushed origin/main and AGENT merge receipt'
timeout -k 5 90 node "$REPO/scripts/outcome-reconciler-release-dag-target-check.mjs" \
  >"$STATE/target-check.json"

echo '==> release-dag-pcc-rebind: run only affected suites and three representative pcc cases'
set +e
OUTCOME_RELEASE_DAG_STATE_ROOT="$STATE" \
timeout -k 20 1450 node "$REPO/scripts/outcome-reconciler-release-dag.mjs" \
  --focus-pcc-rebind 2>&1 | tee "$FOCUS_LOG"
FOCUS_RC=${PIPESTATUS[0]}
set -e
[ "$FOCUS_RC" -eq 0 ] || exit "$FOCUS_RC"

echo '==> release-dag-pcc-rebind: publish immutable-old-attempt and focused-new-target manifest'
timeout -k 5 30 node "$REPO/scripts/outcome-reconciler-release-dag-pcc-rebind-manifest.mjs" \
  "$TAP" "$FOCUS_LOG" "$STATE" "$MANIFEST"

echo '==> release-dag-pcc-rebind: PASS (complete Release DAG was not executed)'
