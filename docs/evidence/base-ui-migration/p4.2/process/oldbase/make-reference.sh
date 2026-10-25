#!/usr/bin/env bash
# make-reference.sh DELIVERY SWITCH: the two slim worktrees the formal runs use, as they were made.
#  - ref:  DELIVERY with only the page-switch commit SWITCH reverted (committed locally, never pushed):
#          this batch's pages on AntD, everything else (shared components, the P4.2 spec) as delivered.
#  - base: the batch's starting commit 3aa26fb97 (the P4.1 delivery), for the shared-component check on
#          pages migrated before this batch.
# Both are sparse: src/web, src/shared, and the P0 evidence the Playwright setup verifies (P0.2 originals,
# drift and accepted layers and the decision documents they cite). node_modules comes from the delivery
# worktree (same lockfile).
set -euo pipefail
delivery=$1; switch=$2
S=/var/tmp/p4.2-753ee3
DEL=/root/.orbit/worktrees/2a435fb0-2ac5-5226-839d-0b1389da291c
EVIDENCE=(/docs/evidence/base-ui-migration/p0.2/ /docs/evidence/base-ui-migration/p0-drift/ /docs/evidence/base-ui-migration/p3.2/README.md
  /docs/evidence/base-ui-migration/p2.3-b1/README.md /docs/evidence/base-ui-migration/p0-drift-2/isolation/profile-validation-b1-fix.json)
make_tree() {
  local tree=$1 commit=$2
  [ -d "$tree" ] || git -C "$DEL" worktree add --no-checkout --detach "$tree" "$commit" > /dev/null
  git -C "$tree" sparse-checkout set --no-cone '/*' '!/*/' '/src/' '!/src/*/' '/src/web/' '/src/shared/' '/scripts/worktree-overlay.sh' \
    '/docs/evidence/base-ui-migration/p0.2/environment.json' "${EVIDENCE[@]}"
  git -C "$tree" checkout -q --detach "$commit"
  ln -sfn "$DEL/node_modules" "$tree/node_modules"
  mkdir -p "$tree/src/web/node_modules"
  cp -a "$DEL/src/web/node_modules/@orbit" "$DEL/src/web/node_modules/@types" "$tree/src/web/node_modules/"
}
make_tree "$S/ref" "$delivery"
git -C "$S/ref" -c user.name=p4.2-reference -c user.email=p4.2@reference.local revert --no-edit "$switch" > /dev/null
echo "reference HEAD $(git -C "$S/ref" rev-parse HEAD) = revert of $switch on $delivery"
make_tree "$S/base" 3aa26fb97
# The start-of-batch audit reads the inventory as it was then.
git -C "$S/base" sparse-checkout add /docs/evidence/base-ui-migration/audit-baseline.json /docs/evidence/base-ui-migration/ownership.json \
  /docs/evidence/base-ui-migration/css-ownership.json /docs/evidence/base-ui-migration/routes-and-tests.md /docs/evidence/base-ui-migration/inventory-delta/
for tree in "$S/ref" "$S/base" "$DEL"; do (cd "$tree/src/web" && npm run build 2>&1 | tail -1); done
