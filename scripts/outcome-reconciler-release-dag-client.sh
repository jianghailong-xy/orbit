#!/usr/bin/env bash
# Disjoint adapters for the complete non-API matrix. Each action owns exactly one
# legacy matrix segment; aggregate only validates their already-produced artifacts.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$REPO/build"
source "$REPO/scripts/lib/outcome-reconciler-release-dag.sh"
ACTION="${1:-}"
SHARED_JSON="$BUILD/outcome-reconciler-full-shared.json"
WEB_JSON="$BUILD/outcome-reconciler-full-web.json"
GO_JSON="$BUILD/outcome-reconciler-full-go.jsonl"
SWIFT_LOG="$BUILD/outcome-reconciler-full-swift.log"
MANIFEST="$BUILD/outcome-reconciler-full-clients-manifest.json"
mkdir -p "$BUILD"

case "$ACTION" in
  shared)
    outcome_release_dag_assert_build
    echo '==> release-dag full-shared: complete matrix'
    (
      cd "$REPO/src/shared"
      "$REPO/node_modules/.bin/vitest" run --maxWorkers=1 --fileParallelism=false \
        --reporter=json --outputFile="$SHARED_JSON"
    )
    ;;
  web)
    outcome_release_dag_assert_build
    echo '==> release-dag full-web: complete matrix'
    (
      cd "$REPO/src/web"
      "$REPO/node_modules/.bin/vitest" run --maxWorkers=1 --fileParallelism=false \
        --reporter=json --outputFile="$WEB_JSON"
    )
    ;;
  go)
    echo '==> release-dag full-go: complete matrix'
    (
      cd "$REPO/src/runner-go"
      ORBIT_MANUAL_LOGIN_CHECK=1 go test -json -count=1 -timeout 1800s ./...
    ) | tee "$GO_JSON"
    ;;
  swift)
    echo '==> release-dag full-swift: complete Swift 6.1 matrix'
    [ "$(docker image inspect --format '{{.Id}}' swift:6.1)" = \
      "${OUTCOME_RELEASE_DAG_SWIFT_IMAGE_ID:?}" ] || {
      echo 'Swift image changed after DAG admission' >&2
      exit 1
    }
    docker run --rm --cpus 3 --memory 4g --memory-swap 4g --pids-limit 1024 \
      -e ORBIT_PERF=1 -v "$REPO:/src:ro" \
      -w /src/src/macos/OrbitKit swift:6.1 \
      swift test --jobs 3 --scratch-path /tmp/orbitkit-build 2>&1 | tee "$SWIFT_LOG"
    ;;
  aggregate)
    : "${OUTCOME_RELEASE_DAG_RUN_ROOT:?}"
    STARTED_AT="$(node -e '
      const fs=require("fs");
      const path=require("path");
      const value=JSON.parse(fs.readFileSync(path.join(process.argv[1],"binding.json"),"utf8"));
      process.stdout.write(value.admittedAt);
    ' "$OUTCOME_RELEASE_DAG_RUN_ROOT")"
    echo '==> release-dag full-clients: validate exact zero-skip union'
    OUTCOME_FULL_CLIENTS_STARTED_AT="$STARTED_AT" \
      node "$REPO/scripts/outcome-reconciler-full-clients-manifest.mjs" \
        "$SHARED_JSON" "$WEB_JSON" "$GO_JSON" "$SWIFT_LOG" "$MANIFEST"
    ;;
  *)
    echo 'usage: outcome-reconciler-release-dag-client.sh shared|web|go|swift|aggregate' >&2
    exit 2
    ;;
esac
