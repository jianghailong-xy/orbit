#!/usr/bin/env bash
# Resumable queue (a step whose completion marker exists is skipped). Usage: originals.sh [tip|before]
#   tip:    1. tip-start: the standard P0 regression on the project tip b2568f28d, before the registration
#              (netns-regression.sh, the unchanged P0 command in a private network namespace);
#           2. after-b2568f28d: same-commit originals of the landed batch (this worktree, clean at b2568f28d);
#   before: 3. before-15b7b5609: same-commit originals of the batch start (the /mnt/data worktree, prepare-before.sh).
# Same-commit originals: p3.2-accepted/tools/same-commit-originals.sh, the parameterised p0-drift tool (the P3.1
# method): the tree's own P0 tests, scenarios and fixtures through p0-drift/tools/drift.config.mjs with
# --update-snapshots=all into a scratch directory, after the same build as pretest:ui-migration.
set -u
WT=/root/.orbit/worktrees/63507a7e-d688-5155-900e-de51850b6416
B=/mnt/data/tmp/34cfhmpygHQdZxRznyVH9
BEFORE=$B/trees/before-15b7b5609
TOOLS=$WT/docs/evidence/base-ui-migration/p3.2-accepted/tools
NETNS=$WT/docs/evidence/base-ui-migration/p0-drift-2/tools/netns-regression.sh
R=$B/runs
mkdir -p $R
case "${1:-}" in
tip)
  echo "worktree HEAD $(git -C $WT rev-parse HEAD) tracked changes [$(git -C $WT status --porcelain --untracked-files=no | wc -l)]; $(date -u +%FT%TZ)"
  test "$(git -C $WT rev-parse HEAD)" = "$(git -C $WT rev-parse b2568f28d)" || { echo "worktree HEAD is not b2568f28d"; exit 2; }
  df -BM / | tail -1
  if [ ! -f $R/tip-start/exit.txt ]; then
    rm -rf $R/tip-start
    bash $NETNS $WT $R/tip-start; echo "step tip-start exit $?"
  fi
  df -BM / | tail -1
  if [ ! -f $R/after-b2568f28d/meta.json ]; then
    bash $TOOLS/same-commit-originals.sh $WT $R/after-b2568f28d; echo "step after-b2568f28d exit $?"
  fi
  rm -f $WT/src/web/ui-migration/drift.config.mjs
  df -BM / | tail -1
  ;;
before)
  echo "before tree HEAD $(git -C $BEFORE rev-parse HEAD); $(date -u +%FT%TZ)"
  test "$(git -C $BEFORE rev-parse HEAD)" = "$(git -C $WT rev-parse 15b7b5609)" || { echo "before tree is not 15b7b5609"; exit 2; }
  if [ ! -f $R/before-15b7b5609/meta.json ]; then
    bash $TOOLS/same-commit-originals.sh $BEFORE $R/before-15b7b5609; echo "step before-15b7b5609 exit $?"
  fi
  rm -f $BEFORE/src/web/ui-migration/drift.config.mjs
  ;;
*) echo "usage: originals.sh tip|before"; exit 2 ;;
esac
echo "queue $1 done $(date -u +%FT%TZ)"
