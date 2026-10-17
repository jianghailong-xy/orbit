#!/usr/bin/env bash
# Usage: exp-tree.sh <name> <patch-script>  — scratch tree of the project tip with a diagnosis patch.
set -euo pipefail
REPO=/root/.orbit/worktrees/e65f238b-4789-5587-b24a-cf2d708322d1
B=/var/tmp/p0drift
TREE=$B/trees/$1
LOG=$B/logs/build-$1.log
{
  [ -d "$TREE" ] || git -C "$REPO" worktree add --detach "$TREE" da13423d3e80e00a487ed91327c31d6788cc7a7a
  bash "$2" "$TREE"
  git -C "$TREE" diff > "$B/exp/$1.diff"
  cp "$REPO/scripts/worktree-overlay.sh" "$REPO/scripts/worktree-dependencies.mjs" "$TREE/scripts/"
  (cd "$TREE" && bash scripts/worktree-overlay.sh)
  (cd "$TREE" && env -u PUBLIC_ORIGIN npm run build -w @orbit/shared && env -u PUBLIC_ORIGIN npm run build -w @orbit/web)
  touch "$TREE/.p0drift-built"
} > "$LOG" 2>&1
echo "$1 built"
