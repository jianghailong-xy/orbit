#!/usr/bin/env bash
# make-delivery-tree-v2.sh DELIVERY: the delivery's own checkout on /mnt/data, so every run of the second version
# (checkout, TMPDIR and outputs) lives on /mnt/data (the coordinator's disk rule of 2026-10-08). A full checkout,
# not a sparse one: the merge check's unit tests read files outside src/web (contracts/, src/macos/,
# src/apiserver/, docs/evidence/), which a sparse tree does not have.
set -euo pipefail
delivery=$1
V=/mnt/data/tmp/34Za39Feocgj42rrBYwzl/v2
WT=/root/.orbit/worktrees/2a435fb0-2ac5-5226-839d-0b1389da291c
tree=$V/del
if [ -d "$tree" ]; then
  git -C "$tree" sparse-checkout disable
  git -C "$tree" checkout -q --detach "$delivery"
else
  git -C "$WT" worktree add --detach "$tree" "$delivery" > /dev/null
fi
ln -sfn "$WT/node_modules" "$tree/node_modules"
mkdir -p "$tree/src/web/node_modules"
cp -a "$WT/src/web/node_modules/@orbit" "$WT/src/web/node_modules/@types" "$tree/src/web/node_modules/"
echo "delivery tree HEAD $(git -C "$tree" rev-parse HEAD)"
(cd "$tree/src/web" && npm run build 2>&1 | tail -1)
