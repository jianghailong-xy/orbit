#!/usr/bin/env bash
# Usage: setup-base.sh <rev>
# A full checkout of <rev> on /mnt/data ($B/wt/base) with its own isolated install of the lockfile
# (npm ci --offline --ignore-scripts, the install worktree-overlay.sh does), for the unchanged P0
# command and the merge check. Nothing here writes to / apart from git's worktree metadata.
set -euo pipefail
B=/mnt/data/tmp/34dI9lY63LC7ZEZHbJ4bG
REPO=/root/.orbit/worktrees/29948cd5-4699-56fe-be2f-3864e2bd39a6
export TMPDIR=$B/tmp
W=$B/wt/base
if [ ! -d "$W" ]; then git -C "$REPO" worktree add --detach "$W" "$1"; fi
git -C "$W" checkout --detach "$1"
cd "$W"
if [ ! -d node_modules ]; then
  npm ci --offline --ignore-scripts --include=dev --include=optional --no-audit --no-fund
fi
# @orbit/shared has an exports map without ./package.json since main: resolve the workspace link itself.
echo "@orbit/shared -> $(realpath node_modules/@orbit/shared)"
git -C "$W" log --oneline -1
du -sh node_modules
