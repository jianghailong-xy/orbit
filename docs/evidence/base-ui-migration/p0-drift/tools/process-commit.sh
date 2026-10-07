#!/usr/bin/env bash
# Usage: process-commit.sh <rev> [label]
# Build <rev> in a scratch worktree. If an identical production dist (same SHA-256 of every file)
# was already run, record that and skip; otherwise run the P0 screenshot matrix against it. Keep
# the dist and the run, then remove the scratch worktree (git deletes it, node_modules included).
set -uo pipefail
REPO=/root/.orbit/worktrees/e65f238b-4789-5587-b24a-cf2d708322d1
B=/var/tmp/p0drift
SHA=$(git -C "$REPO" rev-parse --verify "$1^{commit}") || exit 1
SHORT=${SHA:0:9}
LABEL=${2:-$SHORT}
"$B/scripts/prepare-tree.sh" "$SHA" || exit 1
DIGEST=$(sha256sum < "$B/dists/$SHORT.sha256" | cut -c1-64)
SAME=$(flock "$B/dist-index.lock" awk -v d="$DIGEST" '$1==d {print $2; exit}' "$B/dist-index.txt" 2>/dev/null)
if [ -n "$SAME" ]; then
  echo "$SHORT $DIGEST same-dist-as $SAME" >> "$B/dist-same.txt"
  echo "$LABEL: dist identical to $SAME, matrix not re-run"
else
  python3 "$B/scripts/run-matrix.py" "$SHORT" "$LABEL" > "$B/logs/run-$LABEL.json" 2> "$B/logs/run-$LABEL.err"
  flock "$B/dist-index.lock" sh -c "echo '$DIGEST $LABEL' >> '$B/dist-index.txt'"
  echo "$LABEL: $(cat "$B/logs/run-$LABEL.json")"
fi
if [ "${KEEP_TREE:-}" != 1 ]; then
  mkdir -p "$B/dists/$SHORT" && cp -r "$B/trees/$SHORT/src/web/dist/." "$B/dists/$SHORT/"
  git -C "$REPO" worktree remove --force "$B/trees/$SHORT"
fi
