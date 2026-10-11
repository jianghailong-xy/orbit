#!/usr/bin/env bash
# The project's merge check `npm run build -w @orbit/web && npm run test -w @orbit/web` on this task's worktree (NVMe, the
# project's rule since 2026-10-09), alone in a 6 GB memory-capped scope with oom_score_adj 500, after the memory gate of
# lib.sh. The full log goes to the scratch directory, with a meta file (commit, tree state, start, end, exit code).
set -u
. /mnt/data/tmp/34dTUdzY6mgNk4CGh7ZHl/tools/lib.sh
LOG=$B/merge-check.log META=$B/merge-check.meta
gate
{ echo "command=npm run build -w @orbit/web && npm run test -w @orbit/web"; echo "commit=$(git -C $WT rev-parse HEAD)"
  echo "trackedChanges=$(git -C $WT status --porcelain --untracked-files=no | wc -l)"; echo "started=$(date -u +%FT%TZ)"; } > $META
(cd $WT && capped bash -c 'npm run build -w @orbit/web && npm run test -w @orbit/web') > $LOG 2>&1
code=$?
{ echo "ended=$(date -u +%FT%TZ)"; echo "exit=$code"; } >> $META
echo "merge check exit $code" | tee -a $LOG
cat $META
exit $code
