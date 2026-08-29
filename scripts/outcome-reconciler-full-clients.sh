#!/usr/bin/env bash
# Complete non-API release matrix: shared contracts, Web, Go runner and OrbitKit Swift.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$REPO/build"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SHARED_JSON="$BUILD/outcome-reconciler-full-shared.json"
WEB_JSON="$BUILD/outcome-reconciler-full-web.json"
GO_JSON="$BUILD/outcome-reconciler-full-go.jsonl"
SWIFT_LOG="$BUILD/outcome-reconciler-full-swift.log"
MANIFEST="$BUILD/outcome-reconciler-full-clients-manifest.json"
mkdir -p "$BUILD"

echo '==> full-clients: shared complete matrix'
(
  cd "$REPO/src/shared"
  "$REPO/node_modules/.bin/vitest" run --maxWorkers=1 --fileParallelism=false \
    --reporter=json --outputFile="$SHARED_JSON"
)

echo '==> full-clients: Web complete matrix'
(
  cd "$REPO/src/web"
  "$REPO/node_modules/.bin/vitest" run --maxWorkers=1 --fileParallelism=false \
    --reporter=json --outputFile="$WEB_JSON"
)

echo '==> full-clients: Go complete matrix'
(
  cd "$REPO/src/runner-go"
  ORBIT_MANUAL_LOGIN_CHECK=1 go test -json -count=1 -timeout 1800s ./...
) | tee "$GO_JSON"

echo '==> full-clients: OrbitKit complete Swift 6.1 matrix'
docker run --rm -e ORBIT_PERF=1 -v "$REPO:/src:ro" -w /src/src/macos/OrbitKit swift:6.1 \
  swift test --scratch-path /tmp/orbitkit-build 2>&1 | tee "$SWIFT_LOG"

echo '==> full-clients: validate zero-skip results and publish manifest'
OUTCOME_FULL_CLIENTS_STARTED_AT="$STARTED_AT" \
node "$REPO/scripts/outcome-reconciler-full-clients-manifest.mjs" \
  "$SHARED_JSON" "$WEB_JSON" "$GO_JSON" "$SWIFT_LOG" "$MANIFEST"
