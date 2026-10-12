#!/usr/bin/env bash
# make-trees.sh DELIVERY SWITCH: the trees the P4.3b runs use, all on /mnt/data (the coordinator's disk
# rule of 2026-10-08: checkouts, TMPDIR and run outputs off the root partition).
#  - ref:   DELIVERY with only the business switch SWITCH reverted (committed locally, never pushed): this
#           batch's graphs and cards on AntD, everything else (shared components, the P4.3b specs, main)
#           as delivered. Sparse: src/web, src/shared and the P0 evidence the Playwright setup verifies.
#  - del:   DELIVERY's own full checkout (the merge check's unit tests read files outside src/web).
#  - start: the batch's base, the commit DELIVERY was rebased onto (origin/main, which holds the project tip),
#           sparse like ref; START (optional third argument) moves it there.
# node_modules comes from this task's worktree (same lockfile); @orbit/shared is that worktree's build.
set -euo pipefail
delivery=$1; switch=$2; start=${3:-}
V=/mnt/data/tmp/34blYpxEcHMAf4oafuC2W
WT=/root/.orbit/worktrees/ba9b2bbb-b78b-5991-855c-183de0d5d9e3
# trees.txt names the commits once all three trees are built (final-chain.sh skips them then).
rm -f "$V/trees.txt"
EVIDENCE=(/docs/evidence/base-ui-migration/p0.2/ /docs/evidence/base-ui-migration/p0-drift/ /docs/evidence/base-ui-migration/p3.2/README.md
  /docs/evidence/base-ui-migration/p4.1/README.md /docs/evidence/base-ui-migration/p2.3-b1/README.md
  /docs/evidence/base-ui-migration/p0-drift-2/isolation/profile-validation-b1-fix.json
  /docs/evidence/base-ui-migration/webkit-scroll-lock/README.md)
deps() {
  ln -sfn "$WT/node_modules" "$1/node_modules"
  mkdir -p "$1/src/web/node_modules"
  cp -a "$WT/src/web/node_modules/@orbit" "$WT/src/web/node_modules/@types" "$1/src/web/node_modules/"
}
if [ -d "$V/ref" ]; then git -C "$WT" worktree remove --force "$V/ref"; fi
git -C "$WT" worktree add --no-checkout --detach "$V/ref" "$delivery" > /dev/null
git -C "$V/ref" sparse-checkout set --no-cone '/*' '!/*/' '/src/' '!/src/*/' '/src/web/' '/src/shared/' '/scripts/worktree-overlay.sh' \
  '/docs/evidence/base-ui-migration/p0.2/environment.json' "${EVIDENCE[@]}"
git -C "$V/ref" checkout -q --detach "$delivery"
git -C "$V/ref" -c user.name=p4.3b-reference -c user.email=p4.3b@reference.local revert --no-edit "$switch" > /dev/null
deps "$V/ref"
echo "reference HEAD $(git -C "$V/ref" rev-parse HEAD) = revert of $switch on $delivery"
if [ -d "$V/del" ]; then
  # Earlier trials copied spec files over the tracked ones: put the tree back before moving it.
  git -C "$V/del" reset -q --hard
  git -C "$V/del" checkout -q --detach "$delivery"
else
  git -C "$WT" worktree add --detach "$V/del" "$delivery" > /dev/null
fi
deps "$V/del"
echo "delivery HEAD $(git -C "$V/del" rev-parse HEAD)"
if [ -n "$start" ]; then
  git -C "$V/start" reset -q --hard
  git -C "$V/start" clean -q -f -- src/web/ui-migration
  git -C "$V/start" checkout -q --detach "$start"
  deps "$V/start"
  echo "start HEAD $(git -C "$V/start" rev-parse HEAD)"
fi
for tree in "$V/ref" "$V/del" "$V/start"; do (cd "$tree/src/web" && TMPDIR=$V/tmp npm run build 2>&1 | tail -1); done
echo "$delivery $switch $start" > "$V/trees.txt"
