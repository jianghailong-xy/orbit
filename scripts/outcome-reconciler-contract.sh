#!/usr/bin/env bash
# Executable acceptance for the frozen Outcome Reconciler V2 semantic contract.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/orbit-outcome-contract.XXXXXX")"
TAP="$TMP/contract.tap"
MANIFEST="$REPO/build/outcome-reconciler-v2-contract-manifest.json"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cleanup() {
  rm -f "$TAP"
  rmdir "$TMP" 2>/dev/null || true
}
trap cleanup EXIT

echo "==> outcome-contract: run frozen schema, reducer, mutation and live exit-coverage tests"
if ! ( cd "$REPO" && node --test --test-concurrency=1 --test-reporter=tap \
  test/outcome-reconciler-v2.contract.test.mjs >"$TAP" 2>&1 ); then
  cat "$TAP"
  exit 1
fi
cat "$TAP"

echo "==> outcome-contract: write schema/contract manifest"
OUTCOME_CONTRACT_STARTED_AT="$STARTED_AT" \
  node "$REPO/scripts/outcome-reconciler-contract-manifest.mjs" "$TAP" "$MANIFEST"
echo "==> outcome-contract manifest: $MANIFEST"
