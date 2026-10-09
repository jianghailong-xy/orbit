#!/usr/bin/env bash
# Usage: negative-control.sh <worktree> <patch.diff> <outdir> <branch>
# On the worktree's HEAD, a temporary commit applies <patch.diff>; one official P0 round runs (round.sh: the unchanged
# P0 command in its own network namespace); the worktree is then reset to HEAD. The temporary commit stays on the
# local branch <branch> only, never delivered.
set -u
W=$1 PATCH=$2 OUT=$3 BR=$4
M=$(git -C "$W" rev-parse HEAD)
test -z "$(git -C "$W" status --porcelain)" || { echo "worktree not clean"; exit 2; }
git -C "$W" apply "$PATCH" || exit 2
git -C "$W" -c user.name=coordinator -c user.email=coord@orbit commit -q -am "p0d3 scratch: P0 negative control $(basename "$PATCH" .diff) (not delivered)"
N=$(git -C "$W" rev-parse HEAD)
git -C "$W" branch -f "$BR" "$N"
mkdir -p "$OUT"; git -C "$W" diff "$M" "$N" > "$OUT/patch.diff"; printf '{"base": "%s", "negativeControlCommit": "%s", "branch": "%s"}\n' "$M" "$N" "$BR" > "$OUT/trees.json"
/var/tmp/p0d3/scripts/round.sh "$W" "$OUT"
code=$?
git -C "$W" reset -q --hard "$M"
echo "reset to $(git -C "$W" rev-parse HEAD); P0 exit $code"
