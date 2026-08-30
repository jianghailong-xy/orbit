#!/usr/bin/env bash
# Focused structural regression only. It never starts the Release DAG matrix.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
timeout -k 5 90 git -C "$REPO" fetch --quiet origin refs/heads/main:refs/remotes/origin/main
timeout -k 5 30 node "$REPO/scripts/outcome-reconciler-release-dag.mjs" --check-plan >/dev/null
timeout -k 10 1500 node --test --test-concurrency=1 --test-reporter=tap \
  "$REPO/test/outcome-reconciler-release-dag-plan.test.mjs"
timeout -k 5 90 node "$REPO/scripts/outcome-reconciler-release-dag-target-check.mjs"
