#!/usr/bin/env bash
# make-trees.sh DELIVERY SWITCH BASE: the three checkouts the same-commit comparison runs on, all on
# /mnt/data with every other heavy artifact of this task (the project's disk rule).
#  - ref:  DELIVERY with only the business-switch commit SWITCH reverted (committed locally, never pushed):
#          this batch's pages on AntD; shared components, the P4.3a spec and everything else as delivered.
#  - base: BASE, the commit the batch is delivered on (origin/main), for the shared-component check on
#          pages migrated before this batch.
#  - del:  DELIVERY's own full checkout (the merge check's unit tests read files outside src/web).
# ref and base are sparse (src/web, src/shared, and the P0 evidence the Playwright setup verifies: P0.2
# originals, drift and accepted layers and the decision documents their registries cite).
# (Round 6 added webkit-scroll-lock/README.md, which main's accepted layer cites since e8ad36c0a; on round 6's
# trees it was added to the sparse checkout in place, so the reference kept its revert commit.)
# node_modules comes from the task worktree (same lockfile, its own isolated install). src/web/node_modules/@orbit
# is copied from the task worktree, so @orbit/shared resolves to the task worktree's src/shared (with the dist
# its overlay built). The batch does not touch src/shared (git diff BASE DELIVERY -- src/shared is empty), and
# Vite and Vitest alias @orbit/shared to each tree's own src/shared/src.
set -euo pipefail
delivery=$1; switch=$2; base=$3
V=/mnt/data/tmp/34Za39GvWRQ08ZmKOpFNe/v1
WT=/root/.orbit/worktrees/8682ce7d-8166-5c60-8bec-942544612de2
EVIDENCE=(/docs/evidence/base-ui-migration/p0.2/ /docs/evidence/base-ui-migration/p0-drift/ /docs/evidence/base-ui-migration/p3.2/README.md
  /docs/evidence/base-ui-migration/p4.1/README.md /docs/evidence/base-ui-migration/p2.3-b1/README.md
  /docs/evidence/base-ui-migration/p0-drift-2/isolation/profile-validation-b1-fix.json
  /docs/evidence/base-ui-migration/webkit-scroll-lock/README.md)
link_modules() {
  local tree=$1
  ln -sfn "$WT/node_modules" "$tree/node_modules"
  mkdir -p "$tree/src/web/node_modules"
  cp -a "$WT/src/web/node_modules/@orbit" "$WT/src/web/node_modules/@types" "$tree/src/web/node_modules/"
}
sparse_tree() {
  local tree=$1 commit=$2
  [ -d "$tree" ] || git -C "$WT" worktree add --no-checkout --detach "$tree" "$commit" > /dev/null
  git -C "$tree" sparse-checkout set --no-cone '/*' '!/*/' '/src/' '!/src/*/' '/src/web/' '/src/shared/' '/scripts/worktree-overlay.sh' \
    '/docs/evidence/base-ui-migration/p0.2/environment.json' "${EVIDENCE[@]}"
  git -C "$tree" checkout -q --detach "$commit"
  link_modules "$tree"
}
sparse_tree "$V/ref" "$delivery"
git -C "$V/ref" -c user.name=p4.3a-reference -c user.email=p4.3a@reference.local revert --no-edit "$switch" > /dev/null
echo "reference HEAD $(git -C "$V/ref" rev-parse HEAD) = revert of $switch on $delivery"
sparse_tree "$V/base" "$base"
echo "base HEAD $(git -C "$V/base" rev-parse HEAD)"
if [ -d "$V/del" ]; then git -C "$V/del" checkout -q --detach "$delivery"; else git -C "$WT" worktree add -q --detach "$V/del" "$delivery"; fi
link_modules "$V/del"
echo "delivery HEAD $(git -C "$V/del" rev-parse HEAD)"
# Each tree's production build with vite alone (it empties dist first), so a tree's served build never depends on its
# type check passing: on origin/main from f6f385d2e until its fix 74fc42d4f tsc -b fails, and `npm run build` would
# stop before vite and leave the previous dist in place. The type check is in the merge check step.
for tree in "$V/ref" "$V/base" "$V/del"; do (cd "$tree/src/web" && npx vite build 2>&1 | tail -1); done
