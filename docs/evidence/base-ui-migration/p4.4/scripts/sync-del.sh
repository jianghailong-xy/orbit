#!/usr/bin/env bash
# sync-del.sh: copy the worktree's uncommitted src/web/src changes into the delivery tree and rebuild it (for iterating;
# the record runs use trees made from commits by make-trees.sh).
set -euo pipefail
V=/mnt/data/tmp/34Za39J4QY3kDa5p2Wsau/v1
WT=/root/.orbit/worktrees/a8fc02e5-256c-58d5-bafe-dbd063f08987
git -C "$V/del" checkout -q -- src/web/src
for f in $(git -C "$WT" diff --name-only HEAD -- src/web/src); do cp "$WT/$f" "$V/del/$f"; echo "synced $f"; done
cd "$V/del/src/web" && systemd-run --scope --quiet -p MemoryMax=4G sh -c 'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh npx vite build 2>&1 | tail -1
