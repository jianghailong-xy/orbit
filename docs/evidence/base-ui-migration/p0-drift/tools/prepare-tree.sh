#!/usr/bin/env bash
# Usage: prepare-tree.sh <rev>
# Checks <rev> out as a detached scratch worktree, prepares its own dependencies with the project
# tip's lockfile-aware overlay script, builds @orbit/shared and @orbit/web exactly as
# pretest:ui-migration does, and records the SHA-256 of every file in the production dist.
set -euo pipefail
REPO=/root/.orbit/worktrees/e65f238b-4789-5587-b24a-cf2d708322d1
B=/var/tmp/p0drift
SHA=$(git -C "$REPO" rev-parse --verify "$1^{commit}")
SHORT=${SHA:0:9}
TREE=$B/trees/$SHORT
LOG=$B/logs/build-$SHORT.log
[ -f "$TREE/.p0drift-built" ] && { echo "$SHORT already built"; exit 0; }
{
  echo "# prepare-tree $SHA  $(date -u +%FT%TZ)"
  [ -d "$TREE" ] || git -C "$REPO" worktree add --detach "$TREE" "$SHA"
  test "$(git -C "$TREE" rev-parse HEAD)" = "$SHA"
  cp "$REPO/scripts/worktree-overlay.sh" "$TREE/scripts/worktree-overlay.sh"
  cp "$REPO/scripts/worktree-dependencies.mjs" "$TREE/scripts/worktree-dependencies.mjs"
  (cd "$TREE" && bash scripts/worktree-overlay.sh)
  (cd "$TREE" && env -u PUBLIC_ORIGIN npm run build -w @orbit/shared && env -u PUBLIC_ORIGIN npm run build -w @orbit/web)
  (cd "$TREE/src/web/dist" && find . -type f | LC_ALL=C sort | xargs sha256sum) > "$B/dists/$SHORT.sha256"
  echo "dist digest: $(sha256sum < "$B/dists/$SHORT.sha256" | cut -c1-64)"
  touch "$TREE/.p0drift-built"
} > "$LOG" 2>&1 || { echo "BUILD FAILED $SHORT (see $LOG)"; tail -20 "$LOG"; exit 1; }
echo "$SHORT built: $(tail -1 "$LOG")"
