#!/usr/bin/env bash
# Usage: negative-control.sh <worktree> <outdir>
# On the delivery merge (the worktree's HEAD), a temporary commit appends patch.css (1px on newly registered
# screenshots) to src/web/src/index.css; the unchanged P0 command runs (netns-regression.sh); the worktree is
# then reset to the merge. The temporary commit stays on the local branch p0d2/negative-control, not delivered.
set -u
W=$1 OUT=$2
M=$(git -C "$W" rev-parse HEAD)
test -z "$(git -C "$W" status --porcelain)" || { echo "worktree not clean"; exit 2; }
cat /var/tmp/p0d2/negative-control/patch.css >> "$W/src/web/src/index.css"
git -C "$W" -c user.name=coordinator -c user.email=coord@orbit commit -q -am "p0d2 scratch: P0 negative control, 1px on newly registered screenshots (not delivered)"
N=$(git -C "$W" rev-parse HEAD)
git -C "$W" branch -f p0d2/negative-control "$N"
mkdir -p "$OUT"; git -C "$W" diff "$M" "$N" > "$OUT/patch.diff"; printf '{"merge": "%s", "negativeControlCommit": "%s"}\n' "$M" "$N" > "$OUT/trees.json"
nice -n -10 /var/tmp/p0d2/scripts/netns-regression.sh "$W" "$OUT"
code=$?
git -C "$W" reset -q --hard "$M"
echo "reset to $(git -C "$W" rev-parse HEAD); P0 exit $code"
