#!/usr/bin/env bash
# Telemetry-driven acceptance for the new-task Outcome Reconciler canary. Every report field is
# reduced from hash-chained observations or immutable structured upstream Watchdog evidence.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$REPO/scripts/lib/outcome-reconciler-release-dag.sh"
API="$REPO/src/apiserver"
BUILD="$REPO/build"
COMPILED="$BUILD/outcome-canary-ts"
TAP="$BUILD/outcome-reconciler-v2-canary.tap"
TELEMETRY="$BUILD/outcome-reconciler-v2-canary-telemetry.jsonl"
MANIFEST="$BUILD/outcome-reconciler-v2-canary-manifest.json"
CONTRACT="$REPO/contracts/outcome-reconciler-v2-canary.json"
CAPABILITIES="$BUILD/outcome-reconciler-v2-canary-orbit-capabilities.json"
UPSTREAM_EVIDENCE="$BUILD/outcome-reconciler-v2-canary-upstream-watchdog-evidence.json"
UPSTREAM_TASK="$BUILD/outcome-reconciler-v2-canary-upstream-watchdog-task.json"
UPSTREAM_TASK_ID="34Ex0SFCY6DpfvW2I4ydE"
TIMEOUT_SECONDS="${OUTCOME_CANARY_TIMEOUT:-180}"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
COLLECTOR_SHA="${OUTCOME_CANARY_COLLECTOR_SHA:-$(git -C "$REPO" rev-parse HEAD)}"
TARGET_SHA="${OUTCOME_CANARY_TARGET_SHA:-$(git -C "$REPO" rev-parse HEAD)}"

command -v /usr/local/bin/orbit >/dev/null || {
  echo '!! Orbit CLI is required for immutable upstream Watchdog evidence' >&2
  exit 1
}
[[ "$COLLECTOR_SHA" =~ ^[0-9a-f]{40}$ ]] || {
  echo '!! collector SHA must be a full git SHA' >&2
  exit 1
}
[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || {
  echo '!! target SHA must be a full git SHA' >&2
  exit 1
}

TSC="$REPO/node_modules/.bin/tsc"
[ -x "$TSC" ] || TSC=/root/orbit/node_modules/.bin/tsc
[ -x "$TSC" ] || { echo '!! TypeScript compiler is unavailable' >&2; exit 1; }
TYPE_ROOT="$REPO/node_modules/@types"
[ -d "$TYPE_ROOT" ] || TYPE_ROOT=/root/orbit/node_modules/@types
[ -d "$TYPE_ROOT" ] || { echo '!! Node TypeScript definitions are unavailable' >&2; exit 1; }

mkdir -p "$BUILD" "$COMPILED"

echo '==> outcome-canary: discover Orbit CLI capabilities and fetch immutable Watchdog evidence'
/usr/local/bin/orbit capabilities --json > "$CAPABILITIES"
node -e '
  const fs = require("node:fs");
  const capabilities = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const ids = new Set(capabilities.capabilities.map(({ id }) => id));
  if (!ids.has("task_get") || !ids.has("task_evidence_list")) {
    throw new Error("required Orbit read capabilities are unavailable");
  }
' "$CAPABILITIES"
/usr/local/bin/orbit task evidence-list "$UPSTREAM_TASK_ID" --json > "$UPSTREAM_EVIDENCE"
/usr/local/bin/orbit task get "$UPSTREAM_TASK_ID" --json > "$UPSTREAM_TASK"

if [ "${OUTCOME_RELEASE_DAG_PREPARED_BUILD:-0}" = 1 ]; then
  outcome_release_dag_assert_build
  CANARY_MODULE="$API/dist/outcome-reconciler/outcome-canary.js"
  echo '==> outcome-canary: use exact bound production build'
else
  echo '==> outcome-canary: compile production cohort, reducer, security and control-plane logic'
  "$TSC" \
    "$API/src/outcome-reconciler/outcome-canary.ts" \
    "$API/src/outcome-reconciler/outcome-payload-redaction.ts" \
    --target ES2022 --module nodenext --moduleResolution nodenext --strict --skipLibCheck \
    --typeRoots "$TYPE_ROOT" --outDir "$COMPILED"
  CANARY_MODULE="$COMPILED/outcome-reconciler/outcome-canary.js"
fi

echo '==> outcome-canary: generate hash-chained 111k cohort telemetry and exercise rollback/rollforward'
set +e
OUTCOME_CANARY_MODULE="$CANARY_MODULE" \
OUTCOME_CANARY_CONTRACT_PATH="$CONTRACT" \
OUTCOME_CANARY_TELEMETRY_PATH="$TELEMETRY" \
OUTCOME_CANARY_UPSTREAM_EVIDENCE_PATH="$UPSTREAM_EVIDENCE" \
OUTCOME_CANARY_UPSTREAM_TASK_PATH="$UPSTREAM_TASK" \
OUTCOME_CANARY_COLLECTOR_SHA="$COLLECTOR_SHA" \
OUTCOME_CANARY_TARGET_SHA="$TARGET_SHA" \
timeout -k 10 "$TIMEOUT_SECONDS" node --test --test-concurrency=1 \
  "$REPO/test/outcome-reconciler-v2.canary.test.mjs" 2>&1 | tee "$TAP"
TEST_RC=${PIPESTATUS[0]}
set -e
if [ "$TEST_RC" -ne 0 ]; then
  echo "!! outcome-canary tests failed rc=$TEST_RC" >&2
  exit "$TEST_RC"
fi

echo '==> outcome-canary: reduce raw telemetry into a target-SHA-bound signed manifest'
OUTCOME_CANARY_MODULE="$CANARY_MODULE" \
OUTCOME_CANARY_COLLECTOR_SHA="$COLLECTOR_SHA" \
OUTCOME_CANARY_STARTED_AT="$STARTED_AT" \
node "$REPO/scripts/outcome-reconciler-canary-manifest.mjs" \
  "$TAP" "$TELEMETRY" "$CONTRACT" "$UPSTREAM_EVIDENCE" "$UPSTREAM_TASK" "$MANIFEST"

echo '==> outcome-canary: independently verify manifest hash, Ed25519 signature and zero-skip gates'
node "$REPO/scripts/outcome-reconciler-canary-verify.mjs" \
  "$MANIFEST" "$TELEMETRY" "$UPSTREAM_EVIDENCE" "$UPSTREAM_TASK"
echo "==> outcome-canary manifest: $MANIFEST"
