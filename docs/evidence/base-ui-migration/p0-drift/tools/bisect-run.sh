#!/usr/bin/env bash
# Usage: bisect-run.sh <rev> <label> [playwright selection...]
# Build <rev> in a scratch worktree, run the selected P0 scenes (default: whole matrix) into
# runs/<label>, keep the dist, remove the worktree unless KEEP_TREE=1.
set -uo pipefail
REPO=/root/.orbit/worktrees/e65f238b-4789-5587-b24a-cf2d708322d1
B=/var/tmp/p0drift
SHA=$(git -C "$REPO" rev-parse --verify "$1^{commit}") || exit 1
SHORT=${SHA:0:9}; LABEL=$2; shift 2
"$B/scripts/prepare-tree.sh" "$SHA" >/dev/null || { echo "$LABEL: build failed"; exit 1; }
python3 "$B/scripts/run-matrix.py" "$SHORT" "$LABEL" "$@" > "$B/logs/run-$LABEL.json" 2> "$B/logs/run-$LABEL.err"
echo "$LABEL ($SHORT): $(cat "$B/logs/run-$LABEL.json")"
if [ "${KEEP_TREE:-}" != 1 ]; then
  mkdir -p "$B/dists/$SHORT" && cp -r "$B/trees/$SHORT/src/web/dist/." "$B/dists/$SHORT/"
  git -C "$REPO" worktree remove --force "$B/trees/$SHORT"
fi
