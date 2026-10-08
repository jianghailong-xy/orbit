#!/usr/bin/env bash
# Usage: setup-base.sh <rev>
# A full checkout of <rev> on /mnt/data ($B/wt/base) with its own isolated install of the lockfile
# (npm ci --offline --ignore-scripts, the install worktree-overlay.sh does), for the unchanged P0
# command and the merge check. Nothing here writes to / apart from git's worktree metadata.
set -euo pipefail
B=/mnt/data/tmp/34cFgyWHIYDslABFPloEM
REPO=/root/.orbit/worktrees/a1f992c4-adcc-5b68-bd13-387124116c3d
export TMPDIR=$B/tmp
W=$B/wt/base
if [ ! -d "$W" ]; then git -C "$REPO" worktree add --detach "$W" "$1"; fi
git -C "$W" checkout --detach "$1"
cd "$W"
if [ ! -d node_modules ]; then
  npm ci --offline --ignore-scripts --include=dev --include=optional --no-audit --no-fund
fi
node -e "console.log('@orbit/shared ->', require('fs').realpathSync(require.resolve('@orbit/shared/package.json', {paths: ['src/web']})))"
git -C "$W" log --oneline -1
du -sh node_modules
