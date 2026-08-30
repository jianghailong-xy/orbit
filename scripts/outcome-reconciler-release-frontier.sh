#!/usr/bin/env bash
# Compatibility entrypoint. The former multi-worktree frontier had a second matrix
# orchestrator/evidence writer; all callers now enter the single bounded Release DAG.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$REPO/scripts/outcome-reconciler-release-dag.mjs" "$@"
