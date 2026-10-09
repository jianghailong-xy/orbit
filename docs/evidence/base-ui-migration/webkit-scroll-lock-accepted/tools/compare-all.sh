#!/usr/bin/env bash
# After both same-commit runs, before the registration: keeps the expectations the P0 globalSetup assembled at
# b2568f28d (this worktree's .ui-migration-results/expected-screenshots, written by the tip-start run and again by the
# after run on the same commit; the two sources.json must be identical) as runs/expected-pre, then compares
# (p3.2-accepted/tools/compare.cjs: byte equality, exact pixel difference and the P0 comparator; the first directory
# is the expectation): expectation -> before, expectation -> after, before -> after.
set -euo pipefail
WT=/root/.orbit/worktrees/63507a7e-d688-5155-900e-de51850b6416
S=/mnt/data/tmp/34cfhmpygHQdZxRznyVH9; R=$S/runs
COMPARE="node $WT/docs/evidence/base-ui-migration/p3.2-accepted/tools/compare.cjs"
rm -rf $R/expected-pre; mkdir -p $S/compare
cp -r $WT/src/web/.ui-migration-results/expected-screenshots $R/expected-pre
cmp $R/expected-pre/sources.json $R/tip-start/sources.json && echo "expected-pre sources.json = tip-start sources.json"
echo "expected-pre: $(find $R/expected-pre -name '*.png' | wc -l) screenshots"
$COMPARE $R/expected-pre $R/before-15b7b5609/snapshots $S/compare/exp-vs-before.json
$COMPARE $R/expected-pre $R/after-b2568f28d/snapshots $S/compare/exp-vs-after.json
$COMPARE $R/before-15b7b5609/snapshots $R/after-b2568f28d/snapshots $S/compare/before-vs-after.json
