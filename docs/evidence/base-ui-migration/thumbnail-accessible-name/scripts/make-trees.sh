#!/usr/bin/env bash
# make-trees.sh DELIVERY FIX: the two checkouts the before/after comparison runs on, on /mnt/data with every other heavy
# artifact of this task (the project's disk rule). (P5.3's make-trees.sh, for this follow-up.)
#  - ref: DELIVERY with only the fix commit FIX reverted (committed locally, never pushed): the composer's thumbnail named
#         by its empty alt, as before the fix; everything else as delivered.
#  - del: DELIVERY.
# Both are full checkouts (OrbitKit runs on del). node_modules comes from the task worktree (same lockfile, its own
# isolated install); src/web/node_modules/@orbit and @types are copied from it. Each tree gets its production build.
set -euo pipefail
delivery=$1; fix=$2
V=/mnt/data/tmp/34dTUqxH5MjymjtUhs5C5/v1
WT=/root/.orbit/worktrees/815e244b-5a5b-5984-96fb-3b42c31b28ff
mkdir -p "$V"
link_modules() {
  local tree=$1
  ln -sfn "$WT/node_modules" "$tree/node_modules"
  mkdir -p "$tree/src/web/node_modules"
  cp -a "$WT/src/web/node_modules/@orbit" "$WT/src/web/node_modules/@types" "$tree/src/web/node_modules/"
}
tree() {
  local dir=$1 commit=$2
  if [ -d "$dir" ]; then git -C "$dir" checkout -q --detach "$commit"; else git -C "$WT" worktree add -q --detach "$dir" "$commit"; fi
  link_modules "$dir"
}
tree "$V/ref" "$delivery"
git -C "$V/ref" -c user.name=thumbnail-name-reference -c user.email=reference@thumbnail.local revert --no-edit "$fix" > /dev/null
echo "reference HEAD $(git -C "$V/ref" rev-parse HEAD) = revert of $fix on $delivery"
tree "$V/del" "$delivery"
echo "delivery HEAD $(git -C "$V/del" rev-parse HEAD)"
# Each tree's production build with vite alone (it empties dist first); the type check is in the merge check.
for t in "$V/ref" "$V/del"; do (cd "$t/src/web" && npx vite build 2>&1 | tail -1); done
