#!/usr/bin/env bash
# Run pg specs of this worktree in a capped scope outside the runner's cgroup. Usage: pg.sh <label> <spec>...
set -o pipefail
WT=/root/.orbit/worktrees/54a4a7e8-e645-56e0-95e2-01e100985351
LOG=/mnt/data/tmp/34hpKqWRaAJbUXoikQ3U4/logs
label=$1; shift
cd "$WT" || exit 2
echo "head=$(git rev-parse HEAD) dirty=$(git status --porcelain | wc -l) at $(date -u +%FT%TZ)"
systemd-run --scope --quiet -p MemoryMax=7G -- bash -c 'echo 1000 > /proc/self/oom_score_adj; exec bash scripts/run-pg-spec.sh "$@"' pg "$@" > "$LOG/$label.txt" 2>&1
code=$?
echo "$code" > "$LOG/$label.exit"
tail -40 "$LOG/$label.txt"
echo "exit=$code"
exit $code
