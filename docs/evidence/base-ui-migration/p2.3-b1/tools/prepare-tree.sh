#!/usr/bin/env bash
# Usage: prepare-tree.sh <rev> [label]
# Detached scratch worktree of <rev> under /var/tmp/p23b1/trees/<label|short>, own dependencies via
# the project tip's lockfile-aware overlay script, then @orbit/shared and @orbit/web built exactly as
# pretest:ui-migration does (PUBLIC_ORIGIN unset). Records the SHA-256 of every file in the dist.
set -euo pipefail
REPO=/root/.orbit/worktrees/bf593adf-7724-576c-968c-fcd10880a595
B=/var/tmp/p23b1
SHA=$(git -C "$REPO" rev-parse --verify "$1^{commit}")
LABEL=${2:-${SHA:0:9}}
TREE=$B/trees/$LABEL
LOG=$B/logs/build-$LABEL.log
[ -f "$TREE/.b1-built" ] && { echo "$LABEL already built"; exit 0; }
{
  echo "# prepare-tree $SHA ($LABEL) $(date -u +%FT%TZ)"
  [ -d "$TREE" ] || git -C "$REPO" worktree add --detach "$TREE" "$SHA"
  cp "$REPO/scripts/worktree-overlay.sh" "$TREE/scripts/worktree-overlay.sh"
  cp "$REPO/scripts/worktree-dependencies.mjs" "$TREE/scripts/worktree-dependencies.mjs" 2>/dev/null || true
  (cd "$TREE" && bash scripts/worktree-overlay.sh)
  (cd "$TREE" && env -u PUBLIC_ORIGIN npm run build -w @orbit/shared && env -u PUBLIC_ORIGIN npm run build -w @orbit/web)
  (cd "$TREE/src/web/dist" && find . -type f | LC_ALL=C sort | xargs sha256sum) > "$B/dists/$LABEL.sha256"
  echo "dist digest: $(sha256sum < "$B/dists/$LABEL.sha256" | cut -c1-64)"
  touch "$TREE/.b1-built"
} > "$LOG" 2>&1 || { echo "BUILD FAILED $LABEL (see $LOG)"; tail -20 "$LOG"; exit 1; }
echo "$LABEL ($SHA) built: $(tail -1 "$LOG")"
