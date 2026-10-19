#!/usr/bin/env bash
# The project merge check `npm run build -w @orbit/web && npm run test -w @orbit/web` in this worktree (HEAD = the
# registration commit, no tracked changes; this evidence directory untracked, read by neither the build nor Vitest).
# The full output goes to /mnt/data/tmp/34cfhmpygHQdZxRznyVH9/logs/merge-check.log; the evidence keeps the output
# filtered by p3.2-accepted/tools/filter-merge-check.py and a record of the full one (lines, bytes, SHA-256).
set -u
WT=/root/.orbit/worktrees/63507a7e-d688-5155-900e-de51850b6416
S=/mnt/data/tmp/34cfhmpygHQdZxRznyVH9
LOG=$S/logs/merge-check.log
mkdir -p $S/checks
cd $WT
{ echo "# HEAD $(git rev-parse HEAD); tracked changes: [$(git status --porcelain --untracked-files=no | tr '\n' ' ')]; untracked: [$(git status --porcelain | grep '^??' | tr '\n' ' ')]"
  echo "# argv: npm run build -w @orbit/web && npm run test -w @orbit/web"
  echo "# started $(date -u +%FT%TZ)"; df -BM / | tail -1 | sed 's/^/# df: /'; } > $LOG
npm run build -w @orbit/web >> $LOG 2>&1 && npm run test -w @orbit/web >> $LOG 2>&1
code=$?
echo "# finished $(date -u +%FT%TZ) exit $code" >> $LOG
df -BM / | tail -1 | sed 's/^/# df: /' >> $LOG
python3 -I $WT/docs/evidence/base-ui-migration/p3.2-accepted/tools/filter-merge-check.py $LOG > $S/checks/merge-check.txt
grep -E '^# finished' $LOG >> $S/checks/merge-check.txt
tail -1 $LOG >> $S/checks/merge-check.txt
echo "merge check exit $code"
exit $code
