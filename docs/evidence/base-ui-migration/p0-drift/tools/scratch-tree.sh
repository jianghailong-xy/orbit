#!/usr/bin/env bash
# Usage: scratch-tree.sh <name> <rev> <patch-script> — detached scratch worktree of <rev> with a patch
# applied (diff kept next to the script) and its own dependencies; the P0 command builds it.
set -euo pipefail
REPO=/root/.orbit/worktrees/e65f238b-4789-5587-b24a-cf2d708322d1
B=/var/tmp/p0drift
TREE=$B/trees/$1
[ -d "$TREE" ] || git -C "$REPO" worktree add --detach "$TREE" "$2" > /dev/null
bash "$3" "$TREE"
git -C "$TREE" diff > "${3%.sh}.diff"
(cd "$TREE" && bash scripts/worktree-overlay.sh > "$B/logs/overlay-$1.log" 2>&1)
echo "$1 ready at $(git -C "$TREE" rev-parse HEAD) + $(basename "${3%.sh}.diff")"
