#!/usr/bin/env bash
# Usage: scratch-worktree.sh <name> <rev> [patch...] — detached scratch worktree of <rev>; patches are applied and
# committed (so the scratch state has its own commit), then dependencies are prepared with the overlay.
set -euo pipefail
WT=/root/.orbit/worktrees/1709cbc5-0883-5919-8506-836771412386
S=/var/tmp/p0drift-s2
T=$S/trees/$1
git -C "$WT" worktree add --detach "$T" "$2" > /dev/null
if [ $# -gt 2 ]; then
  for p in "${@:3}"; do git -C "$T" apply "$p"; done
  git -C "$T" -c user.name=p0drift-scratch -c user.email=scratch@p0drift.invalid commit -qam "scratch: $1 ($(cd "$S/patches" && basename -a "${@:3}" | tr '\n' ' '))"
fi
(cd "$T" && bash scripts/worktree-overlay.sh > "$S/logs/overlay-$1.log" 2>&1)
echo "$1 $(git -C "$T" rev-parse HEAD)"
