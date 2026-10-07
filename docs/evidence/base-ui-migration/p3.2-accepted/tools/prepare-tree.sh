#!/usr/bin/env bash
# Usage: prepare-tree.sh <label> <commit>
# A detached worktree of <commit> at $P32ACC/trees/<label> (default P32ACC=/var/tmp/p32acc) with its own
# dependencies, prepared by the project's `bash scripts/worktree-overlay.sh` (the overlay's output is kept
# beside the tree). same-commit-originals.sh builds and runs it.
set -euo pipefail
B=${P32ACC:-/var/tmp/p32acc}
REPO=$(cd "$(dirname "$0")" && git rev-parse --show-toplevel)
LABEL=$1 COMMIT=$(git -C "$REPO" rev-parse "$2^{commit}")
T=$B/trees/$LABEL
mkdir -p "$B/trees"
[ -d "$T" ] || git -C "$REPO" worktree add --detach "$T" "$COMMIT"
test "$(git -C "$T" rev-parse HEAD)" = "$COMMIT"
test -z "$(git -C "$T" status --porcelain --untracked-files=no)"
(cd "$T" && bash scripts/worktree-overlay.sh) > "$B/trees/$LABEL.overlay.txt" 2>&1
echo "$LABEL: $COMMIT ready at $T"
