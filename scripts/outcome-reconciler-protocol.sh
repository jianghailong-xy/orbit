#!/usr/bin/env bash
# Executable acceptance for the declarative Obligation/Action Protocol Registry.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/orbit-outcome-protocol.XXXXXX")"
TAP="$TMP/protocol.tap"
MANIFEST="$REPO/build/outcome-reconciler-v2-protocol-manifest.json"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cleanup() {
  rm -f "$TAP"
  rmdir "$TMP" 2>/dev/null || true
}
trap cleanup EXIT

echo "==> outcome-protocol: validate registry graph and execute every registered protocol"
if ! ( cd "$REPO" && node --test --test-concurrency=1 --test-reporter=tap \
  test/outcome-reconciler-v2.protocol.test.mjs >"$TAP" 2>&1 ); then
  cat "$TAP"
  exit 1
fi
cat "$TAP"

echo "==> outcome-protocol: write zero-skip conformance manifest"
OUTCOME_PROTOCOL_STARTED_AT="$STARTED_AT" \
  node "$REPO/scripts/outcome-reconciler-protocol-manifest.mjs" "$TAP" "$MANIFEST"
echo "==> outcome-protocol manifest: $MANIFEST"
