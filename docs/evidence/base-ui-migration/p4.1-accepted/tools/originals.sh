#!/usr/bin/env bash
# Resumable queue (a step whose completion marker exists is skipped):
#   1. tip-start: the standard P0 regression on the project tip, before the registration (netns-regression.sh);
#   2. after-3aa26fb97: same-commit originals of the landed P4.1 delivery (this worktree, clean at 3aa26fb97);
#   3. before-a84bc61e7: same-commit originals of the batch start (sparse worktree of a84bc61e7).
set -u
WT=/root/.orbit/worktrees/9ea6fb9f-1cd9-54f7-a1c8-8ea427da353a
BEFORE=/var/tmp/p41acc/trees/before-a84bc61e7
TOOLS=$WT/docs/evidence/base-ui-migration/p3.2-accepted/tools
NETNS=$WT/docs/evidence/base-ui-migration/p0-drift-2/tools/netns-regression.sh
R=/var/tmp/p41acc/runs
echo "worktree HEAD $(git -C $WT rev-parse HEAD); before tree HEAD $(git -C $BEFORE rev-parse HEAD); $(date -u +%FT%TZ)"
df -h / | tail -1
if [ ! -f $R/tip-start/exit.txt ]; then
  rm -rf $R/tip-start
  bash $NETNS $WT $R/tip-start; echo "step tip-start exit $?"
fi
df -h / | tail -1
if [ ! -f $R/after-3aa26fb97/meta.json ]; then
  bash $TOOLS/same-commit-originals.sh $WT $R/after-3aa26fb97; echo "step after-3aa26fb97 exit $?"
fi
rm -f $WT/src/web/ui-migration/drift.config.mjs
df -h / | tail -1
if [ ! -f $R/before-a84bc61e7/meta.json ]; then
  bash $TOOLS/same-commit-originals.sh $BEFORE $R/before-a84bc61e7; echo "step before-a84bc61e7 exit $?"
fi
rm -f $BEFORE/src/web/ui-migration/drift.config.mjs
df -h / | tail -1
echo "queue done $(date -u +%FT%TZ)"
