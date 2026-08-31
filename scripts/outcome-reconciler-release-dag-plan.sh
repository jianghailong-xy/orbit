#!/usr/bin/env bash
# Focused structural regression only. It never starts the Release DAG matrix, and therefore never
# asks the frozen-target question: whether this checkout is the published target is a precondition
# of RUNNING the matrix, enforced by resolveTarget() in outcome-reconciler-release-dag.mjs and by
# outcome-reconciler-release-dag-target-check.mjs in the rebind harnesses. Asking it here made a
# structural gate unpassable for every task that produces a commit, because HEAD then necessarily
# differs from origin/main -- and unpassable again whenever main merely advanced.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
timeout -k 5 30 node "$REPO/scripts/outcome-reconciler-release-dag.mjs" --check-plan >/dev/null
timeout -k 10 1500 node --test --test-concurrency=1 --test-reporter=tap \
  "$REPO/test/outcome-reconciler-release-dag-plan.test.mjs"
