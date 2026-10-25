#!/usr/bin/env bash
# Resumable queue (a step whose marker exists is skipped), one browser run at a time:
#   1. tip-start: the standard P0 regression on the project tip a167c2ff0 (this task's worktree, clean), before the
#      registration (netns-regression.sh: the unchanged `NO_COLOR=1 npm run test:ui-migration -w @orbit/web`);
#   2. after-b72da6eda: same-commit originals of P5.3's delivery (p3.2-accepted same-commit-originals.sh, 252 shots);
#   3. before-8f94ddda9: same-commit originals of P5.3's reference (the delivery with the switch c868a02c2 reverted).
set -u
. /mnt/data/tmp/34dTUdzY6mgNk4CGh7ZHl/tools/lib.sh
echo "worktree HEAD $(git -C $WT rev-parse HEAD) status [$(git -C $WT status --porcelain | wc -l)] $(date -u +%FT%TZ)"
if [ ! -f $R/tip-start/exit.txt ]; then
  gate; rm -rf $R/tip-start
  capped bash $NETNS $WT $R/tip-start; echo "step tip-start exit $?"
fi
for side in after-b72da6eda before-8f94ddda9; do
  T=$B/trees/$side
  if [ ! -f $R/$side/meta.json ]; then
    gate
    capped bash $TOOLS32/same-commit-originals.sh $T $R/$side; echo "step $side exit $?"
  fi
  rm -f $T/src/web/ui-migration/drift.config.mjs
done
echo "queue done $(date -u +%FT%TZ)"
