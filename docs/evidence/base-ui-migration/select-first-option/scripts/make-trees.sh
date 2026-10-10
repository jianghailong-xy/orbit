#!/usr/bin/env bash
# make-trees.sh DELIVERY BASE: the two trees the runs use, on /mnt/data (the project's disk rule: checkouts, TMPDIR
# and run outputs off the root partition).
#  - del: DELIVERY's own full checkout (the merge check reads files outside src/web).
#  - ref: the same-commit reference: DELIVERY with only this batch's product files put back as they are on BASE
#         (Select.tsx, Overlay.css, foundation.css), committed locally and never pushed. The new specs, the fixture
#         extension and the unit tests stay, so the same files drive both trees. Sparse: src/web, src/shared and the
#         evidence the Playwright setup reads (P0 originals, drift and accepted layers and the documents they cite).
# node_modules is this task's worktree's (same lockfile, hardlinked on the NVMe); each tree's @orbit/shared is its own.
set -euo pipefail
delivery=$1; base=$2
V=/mnt/data/tmp/34coPBk43ULRuisicUTAy
WT=/root/.orbit/worktrees/b02d6caa-7306-5c0d-a31b-dc04fd4510ec
PRODUCT=(src/web/src/components/ui/Select.tsx src/web/src/components/ui/Overlay.css src/web/src/components/ui/foundation.css)
deps() {
  ln -sfn "$WT/node_modules" "$1/node_modules"
  mkdir -p "$1/src/web/node_modules/@orbit"
  # A copy, not hardlinks: the trees are on another filesystem (a failed `cp -al` there leaves empty directories).
  [ -e "$1/src/web/node_modules/@types/react-dom/index.d.ts" ] || { rm -rf "$1/src/web/node_modules/@types"; cp -a "$WT/src/web/node_modules/@types" "$1/src/web/node_modules/@types"; }
  ln -sfn "$1/src/shared" "$1/src/web/node_modules/@orbit/shared"
}
if [ -d "$V/del/.git" ] || [ -f "$V/del/.git" ]; then
  git -C "$V/del" reset -q --hard
  git -C "$V/del" checkout -q --detach "$delivery"
else
  git -C "$WT" worktree add --detach "$V/del" "$delivery" > /dev/null
fi
deps "$V/del"
echo "delivery HEAD $(git -C "$V/del" rev-parse HEAD)"
if [ -e "$V/ref/.git" ]; then git -C "$WT" worktree remove --force "$V/ref"; fi
git -C "$WT" worktree add --no-checkout --detach "$V/ref" "$delivery" > /dev/null
git -C "$V/ref" sparse-checkout set --no-cone '/*' '!/*/' '/src/' '!/src/*/' '/src/web/' '/src/shared/' '/scripts/' '/docs/evidence/base-ui-migration/'
git -C "$V/ref" checkout -q --detach "$delivery"
git -C "$V/ref" checkout "$base" -- "${PRODUCT[@]}"
git -C "$V/ref" -c user.name=select-first-option-reference -c user.email=reference@select-first-option.local \
  commit -q -m "reference: $delivery with this batch's product files as on $base"
deps "$V/ref"
echo "reference HEAD $(git -C "$V/ref" rev-parse HEAD) = $delivery with ${PRODUCT[*]} from $base"
git -C "$V/ref" diff --stat "$delivery" HEAD
echo "$delivery $base $(git -C "$V/ref" rev-parse HEAD)" > "$V/trees.txt"
