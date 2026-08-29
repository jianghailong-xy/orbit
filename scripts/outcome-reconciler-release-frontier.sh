#!/usr/bin/env bash
# Unique release-frontier acceptance. Every independent-verifier entrypoint is executed, followed
# by the complete API/Web/Go/Swift matrices and the remote/deployment evidence gates. No filtering,
# skip allowance, or stale-manifest reuse is accepted.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$REPO/build"
PHASE="${OUTCOME_RELEASE_FRONTIER_PHASE:-final}"
if [ "$PHASE" != final ] && [ "$PHASE" != prebinding ]; then
  echo "invalid OUTCOME_RELEASE_FRONTIER_PHASE: $PHASE" >&2
  exit 2
fi
LOG_DIR="$BUILD/outcome-reconciler-release-frontier-logs-$PHASE"
LEDGER="$BUILD/outcome-reconciler-release-frontier-$PHASE.tsv"
OUTPUT="$BUILD/outcome-reconciler-release-frontier-manifest.json"
if [ "$PHASE" = prebinding ]; then
  OUTPUT="$BUILD/outcome-reconciler-release-frontier-prebinding-manifest.json"
fi
mkdir -p "$LOG_DIR"
: > "$LEDGER"
FAILED=0

run_npm() {
  local name="$1"
  local package_script="$2"
  local log_relative="build/$(basename "$LOG_DIR")/${name}.log"
  local log="$REPO/$log_relative"
  echo "==> release-frontier [$PHASE]: $name ($package_script)"
  set +e
  (
    cd "$REPO"
    npm run "$package_script"
  ) 2>&1 | tee "$log"
  local rc=${PIPESTATUS[0]}
  set -e
  printf '%s\t%s\t%s\t%s\n' "$name" "$package_script" "$rc" "$log_relative" >> "$LEDGER"
  if [ "$rc" -ne 0 ]; then
    echo "!! release-frontier: $name failed rc=$rc" >&2
    FAILED=1
  fi
}

run_direct() {
  local name="$1"
  local command_name="$2"
  shift 2
  local log_relative="build/$(basename "$LOG_DIR")/${name}.log"
  local log="$REPO/$log_relative"
  echo "==> release-frontier [$PHASE]: $name"
  set +e
  (cd "$REPO" && "$@") 2>&1 | tee "$log"
  local rc=${PIPESTATUS[0]}
  set -e
  printf '%s\t%s\t%s\t%s\n' "$name" "$command_name" "$rc" "$log_relative" >> "$LEDGER"
  if [ "$rc" -ne 0 ]; then
    echo "!! release-frontier: $name failed rc=$rc" >&2
    FAILED=1
  fi
}

set -e
# The 17 commands are copied verbatim from immutable verifier evidence DphKCyIZ7Se648G54i1Ux.
run_npm bootstrap test:outcome-reconciler:bootstrap
run_npm contract test:outcome-reconciler:contract
run_npm protocol test:outcome-reconciler:protocol
run_npm evaluator test:outcome-reconciler:evaluator
run_npm projection test:outcome-reconciler:projection
run_npm done-gate test:outcome-reconciler:done-gate
run_npm actions test:outcome-reconciler:actions
run_npm coordinator test:outcome-reconciler:coordinator
run_npm watchdog test:outcome-reconciler:watchdog
run_npm acceptance-runtime test:outcome-reconciler:acceptance-runtime
run_npm fact-ingress test:outcome-reconciler:fact-ingress
run_npm ratification test:outcome-reconciler:ratification
run_npm auto-dispatch test:outcome-reconciler:auto-dispatch
run_npm work-overview-readiness test:outcome-reconciler:work-overview-readiness
run_npm auto-dispatch-integration test:outcome-reconciler:auto-dispatch:integration
run_npm watchdog-current-binding-regression test:outcome-reconciler:watchdog-current-binding:regression
run_npm watchdog-current-binding test:outcome-reconciler:watchdog-current-binding

# The six entrypoints that were literally absent from the failed verifier target.
run_npm delivery test:outcome-reconciler:delivery
run_npm versioning test:outcome-reconciler:versioning
run_npm surfaces test:outcome-reconciler:surfaces
run_npm replay test:outcome-reconciler:replay
run_npm canary test:outcome-reconciler:canary
run_npm owner-ratification-ui test:outcome-reconciler:owner-ratification-ui

# Complete, unfiltered product matrices.
run_npm full-api test:outcome-reconciler:full-api
run_npm full-clients test:outcome-reconciler:full-clients
run_npm authoritative-target test:outcome-reconciler:authoritative-target

if [ "$PHASE" = final ]; then
  run_direct release-live-state test:outcome-reconciler:release-live-state \
    node scripts/outcome-reconciler-release-live-state.mjs
fi

if [ "$FAILED" -ne 0 ]; then
  echo '!! release-frontier: one or more declared entrypoints failed; no PASS manifest published' >&2
  exit 1
fi

node "$REPO/scripts/outcome-reconciler-release-frontier-manifest.mjs" \
  "$PHASE" "$LEDGER" "$OUTPUT"
echo "✓ release-frontier $PHASE accepted: manifest=$OUTPUT target=$(git -C "$REPO" rev-parse HEAD)"
