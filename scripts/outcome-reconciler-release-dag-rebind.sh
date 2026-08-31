#!/usr/bin/env bash
# Focused target/plan/binding/prepare-postgres rebind. It never schedules the formal Release DAG.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$REPO/build/outcome-reconciler-release-dag-rebind"
STATE="$BUILD/state"
TAP="$BUILD/plan-and-binding.tap"
FOCUS_LOG="$BUILD/prepare-postgres.log"
MANIFEST="$REPO/build/outcome-reconciler-release-dag-rebind-manifest.json"

rm -rf -- "$BUILD"
mkdir -p "$STATE"

echo '==> release-dag-rebind: validate the declared plan without scheduling nodes'
timeout -k 5 30 node "$REPO/scripts/outcome-reconciler-release-dag.mjs" --check-plan \
  >"$STATE/plan-check.json"

echo '==> release-dag-rebind: run target, binding and isolated Prisma structural regressions'
set +e
timeout -k 10 180 node --test --test-concurrency=1 --test-reporter=tap \
  "$REPO/test/outcome-reconciler-release-dag-plan.test.mjs" \
  "$REPO/test/outcome-reconciler-release-dag-rebind.test.mjs" 2>&1 | tee "$TAP"
TEST_RC=${PIPESTATUS[0]}
set -e
[ "$TEST_RC" -eq 0 ] || exit "$TEST_RC"

echo '==> release-dag-rebind: verify the pushed target and AGENT merge receipt'
timeout -k 5 90 node "$REPO/scripts/outcome-reconciler-release-dag-target-check.mjs" \
  >"$STATE/target-check.json"

echo '==> release-dag-rebind: execute only the prepare-postgres dependency closure'
set +e
OUTCOME_RELEASE_DAG_STATE_ROOT="$STATE" \
timeout -k 20 1200 node "$REPO/scripts/outcome-reconciler-release-dag.mjs" \
  --focus-prepare-postgres 2>&1 | tee "$FOCUS_LOG"
FOCUS_RC=${PIPESTATUS[0]}
set -e
[ "$FOCUS_RC" -eq 0 ] || exit "$FOCUS_RC"

echo '==> release-dag-rebind: publish the zero-skip focused machine manifest'
timeout -k 5 30 node "$REPO/scripts/outcome-reconciler-release-dag-rebind-manifest.mjs" \
  "$TAP" "$FOCUS_LOG" "$STATE" "$MANIFEST"

echo '==> release-dag-rebind: PASS (formal Release DAG not executed)'
