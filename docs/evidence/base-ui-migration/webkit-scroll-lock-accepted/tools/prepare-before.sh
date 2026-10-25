#!/usr/bin/env bash
# The before tree of the same-commit comparison: a detached worktree of the batch start 15b7b5609 (the project tip
# the scroll-lock batch started from, parent of its first commit 78cae80d9) on /mnt/data, with its dependencies laid
# down by that tree's own scripts/worktree-overlay.sh. A full checkout (about 1 GB, the evidence already slimmed),
# so the expected-screenshot assembly finds every document the registries cite.
set -euo pipefail
WT=/root/.orbit/worktrees/63507a7e-d688-5155-900e-de51850b6416
B=/mnt/data/tmp/34cfhmpygHQdZxRznyVH9
BEFORE=$B/trees/before-15b7b5609
mkdir -p $B/trees $B/logs
if [ ! -d $BEFORE ]; then
  git -C $WT worktree add --detach $BEFORE 15b7b5609
fi
test "$(git -C $BEFORE rev-parse HEAD)" = "$(git -C $WT rev-parse 15b7b5609)"
cd $BEFORE && bash scripts/worktree-overlay.sh > $B/logs/overlay-before.txt 2>&1
tail -3 $B/logs/overlay-before.txt
echo "before tree $(git -C $BEFORE rev-parse HEAD) ready, status [$(git -C $BEFORE status --porcelain | wc -l)]"
