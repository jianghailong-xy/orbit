#!/usr/bin/env bash
# Focused repair verification for the six failed 2c697755 Release DAG nodes. It cannot schedule
# the complete Release DAG and leaves deployment/owner-ratification boundaries untouched.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$REPO/build/outcome-reconciler-release-dag-regression-rebind"
STATE="$BUILD/state"
TAP="$BUILD/structural.tap"
FOCUS_LOG="$BUILD/focused.log"
MANIFEST="$REPO/build/outcome-reconciler-release-dag-regression-rebind-manifest.json"

rm -rf -- "$BUILD"
mkdir -p "$STATE"

echo '==> release-dag-regression-rebind: validate the frozen DAG without scheduling nodes'
timeout -k 5 30 node "$REPO/scripts/outcome-reconciler-release-dag.mjs" --check-plan \
  >"$STATE/plan-check.json"

echo '==> release-dag-regression-rebind: prove fingerprints, strict bindings and focused topology'
set +e
timeout -k 10 180 node --test --test-concurrency=1 --test-reporter=tap \
  "$REPO/test/outcome-reconciler-release-dag-plan.test.mjs" \
  "$REPO/test/outcome-reconciler-release-dag-regression-rebind.test.mjs" 2>&1 | tee "$TAP"
TEST_RC=${PIPESTATUS[0]}
set -e
[ "$TEST_RC" -eq 0 ] || exit "$TEST_RC"

echo '==> release-dag-regression-rebind: verify pushed origin/main and AGENT merge receipt'
timeout -k 5 90 node "$REPO/scripts/outcome-reconciler-release-dag-target-check.mjs" \
  >"$STATE/target-check.json"

echo '==> release-dag-regression-rebind: run only Watchdog, full-web and four failed API specs'
set +e
OUTCOME_RELEASE_DAG_STATE_ROOT="$STATE" \
timeout -k 20 1400 node "$REPO/scripts/outcome-reconciler-release-dag.mjs" \
  --focus-regression-rebind 2>&1 | tee "$FOCUS_LOG"
FOCUS_RC=${PIPESTATUS[0]}
set -e
[ "$FOCUS_RC" -eq 0 ] || exit "$FOCUS_RC"

echo '==> release-dag-regression-rebind: bind immutable old failure and focused new evidence'
timeout -k 5 45 node "$REPO/scripts/outcome-reconciler-release-dag-regression-rebind-manifest.mjs" \
  "$TAP" "$FOCUS_LOG" "$STATE" "$MANIFEST"

echo '==> release-dag-regression-rebind: PASS (complete Release DAG and deployment were not executed)'
