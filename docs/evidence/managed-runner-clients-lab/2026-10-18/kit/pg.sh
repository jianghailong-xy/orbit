#!/usr/bin/env bash
# Run pg specs of this worktree in a capped scope outside the runner's cgroup. Usage: pg.sh <label> <spec>...
set -o pipefail
WT=/root/.orbit/worktrees/7ddda73b-7127-5859-a253-c2d61bb5aa40
LOG=/mnt/data/tmp/t07-34ZtjU1Q/logs
label=$1; shift
cd "$WT" || exit 2
echo "head=$(git rev-parse HEAD) dirty=$(git status --porcelain | wc -l) at $(date -u +%FT%TZ)"
systemd-run --scope --quiet -p MemoryMax=7G -- bash -c 'echo 1000 > /proc/self/oom_score_adj; exec bash scripts/run-pg-spec.sh "$@"' pg "$@" > "$LOG/$label.txt" 2>&1
code=$?
echo "$code" > "$LOG/$label.exit"
tail -40 "$LOG/$label.txt"
echo "exit=$code"
exit $code
