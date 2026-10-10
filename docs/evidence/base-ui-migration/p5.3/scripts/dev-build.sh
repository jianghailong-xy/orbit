#!/usr/bin/env bash
# dev-build.sh TREE: the production build of one tree (ref = v1/dev-ref, del = the task worktree), vite alone.
set -u
V=/mnt/data/tmp/34Za39Ov1yysHZaYL6wgJ/v1
WT=/root/.orbit/worktrees/4071e471-3592-5308-a8bb-f597b81ac833
tree=$1
if [ "$tree" = ref ]; then dir=$V/dev-ref; else dir=$WT; fi
cd "$dir/src/web" && systemd-run --scope --quiet -p MemoryMax=6G sh -c 'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh npx vite build 2>&1 | tail -3
