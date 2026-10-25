#!/usr/bin/env bash
# make-trees.sh: the scratch checkouts the variants run in, on /mnt/data (never pushed, removed after the judgment):
#   exp-pre  743d21ab2  this task's starting point (the project line after P6, with origin/main merged), before the fix
#   exp-fix  62ab70582  the fix
#   exp-base f78e93f61  the parent of P6's delivery: AntD still in the app and the "Open legacy Modal" button still
#                       drawn above the regions (P6's ro-loop-variants "base")
# exp-pre and exp-fix share this worktree's lockfile and use its node_modules; exp-base gets its own through
# scripts/worktree-overlay.sh (as of f78e93f61), which borrows /root/orbit's install when that satisfies its lockfile.
set -eu
V=/mnt/data/tmp/34dcr9bZPPrl6TDzvXowg/v
WT=/root/.orbit/worktrees/17f5fa0c-dee8-55a3-9637-1996a39597e0
mkdir -p "$V"
tree() {
  local dir=$1 commit=$2
  [ -d "$dir" ] || git -C "$WT" worktree add -q --detach "$dir" "$commit"
  git -C "$dir" checkout -q --detach "$commit" && git -C "$dir" checkout -q -- .
  echo "$dir: $(git -C "$dir" rev-parse HEAD)"
}
tree $V/exp-pre 743d21ab293caafe6c35325369d4d20eeaf7250d
tree $V/exp-fix 62ab70582f95d3c8919f310e82b37fa896032314
tree $V/exp-base f78e93f615fceda94eeea0c9cdd400fb44b7949e
for dir in $V/exp-pre $V/exp-fix; do
  ln -sfn "$WT/node_modules" "$dir/node_modules"
  mkdir -p "$dir/src/web/node_modules" && cp -a "$WT/src/web/node_modules/@orbit" "$WT/src/web/node_modules/@types" "$dir/src/web/node_modules/"
done
(cd $V/exp-base && bash scripts/worktree-overlay.sh)
