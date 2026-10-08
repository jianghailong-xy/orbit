#!/usr/bin/env bash
# make-reference-v2.sh DELIVERY SWITCH BASE [SPECFIX]: the slim worktrees the second version's runs use, as they were made.
#  - ref:  DELIVERY with only the page-switch commit SWITCH reverted (committed locally, never pushed):
#          this batch's pages on AntD, everything else (shared components, the P4.2 spec, main) as delivered.
#  - base: BASE, the batch's starting commit, for the shared-component check on pages migrated before this
#          batch; with SPECFIX cherry-picked onto it (committed locally, never pushed) when the delivery fixes a
#          spec both trees run, so the start tree runs the same spec.
# Both are sparse (src/web, src/shared, and the P0 evidence the Playwright setup verifies: P0.2 originals,
# drift and accepted layers and the decision documents their registries cite) and live on /mnt/data with
# every other heavy artifact of this task. node_modules comes from the delivery worktree (same lockfile).
set -euo pipefail
delivery=$1; switch=$2; base=$3; specfix=${4:-}
V=/mnt/data/tmp/34Za39Feocgj42rrBYwzl/v2
DEL=/root/.orbit/worktrees/2a435fb0-2ac5-5226-839d-0b1389da291c
EVIDENCE=(/docs/evidence/base-ui-migration/p0.2/ /docs/evidence/base-ui-migration/p0-drift/ /docs/evidence/base-ui-migration/p3.2/README.md
  /docs/evidence/base-ui-migration/p4.1/README.md /docs/evidence/base-ui-migration/p2.3-b1/README.md
  /docs/evidence/base-ui-migration/p0-drift-2/isolation/profile-validation-b1-fix.json)
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
make_tree "$V/ref" "$delivery"
git -C "$V/ref" -c user.name=p4.2-reference -c user.email=p4.2@reference.local revert --no-edit "$switch" > /dev/null
echo "reference HEAD $(git -C "$V/ref" rev-parse HEAD) = revert of $switch on $delivery"
make_tree "$V/base" "$base"
if [ -n "$specfix" ]; then
  git -C "$V/base" -c user.name=p4.2-start -c user.email=p4.2@start.local cherry-pick "$specfix" > /dev/null
  echo "base HEAD $(git -C "$V/base" rev-parse HEAD) = $base with $specfix cherry-picked"
else
  echo "base HEAD $(git -C "$V/base" rev-parse HEAD)"
fi
for tree in "$V/ref" "$V/base" "$DEL"; do (cd "$tree/src/web" && npm run build 2>&1 | tail -1); done
