#!/usr/bin/env bash
# make-trees.sh DELIVERY SWITCH DEPENDENCY BASE: the checkouts P6's comparisons run on, on /mnt/data (the project's
# disk rule). (P5.3's make-trees.sh, for P6.)
#  - ref:  DELIVERY with the dependency removal DEPENDENCY and the runtime switch SWITCH reverted (local commits, never
#          pushed): main.tsx on ConfigProvider/AntApp with antd's reset and theme.ts, antd in the manifest and
#          lockfile; everything else (the Orbit reset and root styles, the Orbit-only fixtures, the comments) as
#          delivered.
#  - base: BASE, the commit the batch is delivered on (origin/main, which holds the project tip), for the standard
#          P0 regression.
#  - del:  DELIVERY's own checkout.
# ref and base install the start's lockfile (antd included): node_modules links to a hard-linked copy of the task
# worktree's install from before the dependency left (/var/tmp/p6-34Za39RS-start, same lockfile bytes, checked
# below). del links to the task worktree's own install of the delivery's lockfile. src/web/node_modules/@orbit and
# @types are copied from the task worktree; Vite and Vitest alias @orbit/shared to each tree's own src/shared/src.
set -euo pipefail
delivery=$1; switch=$2; dependency=$3; base=$4
V=/mnt/data/tmp/34Za39RS6A28G7xPqMD0p/v1
WT=/root/.orbit/worktrees/05c9af49-f99c-506f-b2c2-2c26a5edc79e
START_NM=/var/tmp/p6-34Za39RS-start/node_modules
link_modules() {
  local tree=$1 modules=$2
  ln -sfn "$modules" "$tree/node_modules"
  mkdir -p "$tree/src/web/node_modules"
  cp -a "$WT/src/web/node_modules/@orbit" "$WT/src/web/node_modules/@types" "$tree/src/web/node_modules/"
}
tree() {
  local dir=$1 commit=$2
  if [ -d "$dir" ]; then git -C "$dir" checkout -q --detach "$commit"; else git -C "$WT" worktree add -q --detach "$dir" "$commit"; fi
}
tree "$V/ref" "$delivery"
git -C "$V/ref" -c user.name=p6-reference -c user.email=p6@reference.local revert --no-edit "$dependency" "$switch" > /dev/null
link_modules "$V/ref" "$START_NM"
echo "reference HEAD $(git -C "$V/ref" rev-parse HEAD) = revert of $dependency and $switch on $delivery"
tree "$V/base" "$base"
link_modules "$V/base" "$START_NM"
echo "base HEAD $(git -C "$V/base" rev-parse HEAD)"
tree "$V/del" "$delivery"
link_modules "$V/del" "$WT/node_modules"
echo "delivery HEAD $(git -C "$V/del" rev-parse HEAD)"
# The installs match the lockfiles they serve.
for t in ref base; do cmp -s "$V/$t/package-lock.json" "$V/start/package-lock.json" && echo "$t lockfile = the start's (its install)"; done
cmp -s "$V/del/package-lock.json" "$WT/package-lock.json" && echo "del lockfile = the task worktree's (its install)"
for t in ref base del; do (cd "$V/$t/src/web" && node -e "try{require.resolve('antd');console.log('$t: antd resolves')}catch{console.log('$t: antd does not resolve')}"); done
# Each tree's production build with vite alone (it empties dist first); the type check is in the merge check.
for t in ref base del; do (cd "$V/$t/src/web" && npx vite build 2>&1 | tail -1); done
