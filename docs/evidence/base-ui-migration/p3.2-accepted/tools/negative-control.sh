#!/usr/bin/env bash
# Usage: negative-control.sh <scratch worktree> <commit> <patch.css> <outdir>
# p0-drift-2/tools/negative-control.sh with its paths made parameters. The scratch worktree is checked out
# (detached) at <commit>, the registration; a temporary commit appends <patch.css> to src/web/src/index.css;
# the unchanged P0 command runs in a private network namespace (p0-drift-2/tools/netns-regression.sh); the
# worktree then goes back to <commit>. The temporary commit stays only on the local branch
# p32acc/<patch name>; it is not delivered.
set -u
REPO=$(cd "$(dirname "$0")" && git rev-parse --show-toplevel)
W=$1 C=$(git -C "$1" rev-parse "$2^{commit}") PATCH=$(cd "$(dirname "$3")" && pwd)/$(basename "$3") OUT=$4
NAME=$(basename "$PATCH" .css)
git -C "$W" checkout -q --detach "$C" || exit 2
test -z "$(git -C "$W" status --porcelain --untracked-files=no)" || { echo "worktree not clean"; exit 2; }
cat "$PATCH" >> "$W/src/web/src/index.css"
git -C "$W" commit -q -am "p32acc scratch: P0 negative control $NAME (not delivered)"
N=$(git -C "$W" rev-parse HEAD)
git -C "$W" branch -f "p32acc/$NAME" "$N"
mkdir -p "$OUT"; git -C "$W" diff "$C" "$N" > "$OUT/patch.diff"
printf '{"registration": "%s", "negativeControlCommit": "%s", "branch": "p32acc/%s"}\n' "$C" "$N" "$NAME" > "$OUT/trees.json"
bash "$REPO/docs/evidence/base-ui-migration/p0-drift-2/tools/netns-regression.sh" "$W" "$OUT"
code=$?
git -C "$W" checkout -q --detach "$C"
echo "back at $(git -C "$W" rev-parse HEAD); P0 exit $code"
exit $code
