#!/usr/bin/env bash
# dev-ref.sh SWITCH: the development reference tree — the worktree's HEAD with only the business-switch commit SWITCH
# reverted (local, never pushed), sparse (src/web, src/shared and the P0 evidence the Playwright setup verifies), on
# /mnt/data. The worktree's uncommitted P5.1 spec files are copied in, so both trees run the same cases. node_modules
# links to the worktree's isolated install (same lockfile).
set -euo pipefail
switch=$1
V=/mnt/data/tmp/34Za39L1H6V82d2sobzPY/v1
WT=/root/.orbit/worktrees/9f22d16e-3f30-5541-a5ef-91972ffc7911
EVIDENCE=(/docs/evidence/base-ui-migration/p0.2/ /docs/evidence/base-ui-migration/p0-drift/ /docs/evidence/base-ui-migration/p3.2/README.md
  /docs/evidence/base-ui-migration/p4.1/README.md /docs/evidence/base-ui-migration/p2.3-b1/README.md
  /docs/evidence/base-ui-migration/p0-drift-2/isolation/profile-validation-b1-fix.json
  /docs/evidence/base-ui-migration/webkit-scroll-lock/README.md /docs/evidence/base-ui-migration/p3.2/p32-reference.config.mjs
  /docs/evidence/base-ui-migration/p4.4/README.md)
tree=$V/devref
if [ ! -d "$tree" ]; then git -C "$WT" worktree add --no-checkout --detach "$tree" HEAD > /dev/null; fi
git -C "$tree" sparse-checkout set --no-cone '/*' '!/*/' '/src/' '!/src/*/' '/src/web/' '/src/shared/' '/scripts/worktree-overlay.sh' \
  '/docs/evidence/base-ui-migration/p0.2/environment.json' "${EVIDENCE[@]}"
git -C "$tree" checkout -q --detach "$(git -C "$WT" rev-parse HEAD)"
git -C "$tree" -c user.name=p5.1-reference -c user.email=p5.1@reference.local revert --no-edit "$switch" > /dev/null
ln -sfn "$WT/node_modules" "$tree/node_modules"
mkdir -p "$tree/src/web/node_modules"
cp -a "$WT/src/web/node_modules/@orbit" "$WT/src/web/node_modules/@types" "$tree/src/web/node_modules/"
for f in p51.browser.mjs p51-fixtures.mjs p51.config.mjs playwright.config.mjs; do cp "$WT/src/web/ui-migration/$f" "$tree/src/web/ui-migration/$f"; done
echo "devref HEAD $(git -C "$tree" rev-parse HEAD) = revert of $switch on $(git -C "$WT" rev-parse --short HEAD)"
git -C "$tree" status --short | head
