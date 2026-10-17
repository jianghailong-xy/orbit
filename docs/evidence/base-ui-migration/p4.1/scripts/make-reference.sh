#!/usr/bin/env bash
# make-reference.sh DELIVERY SWITCH: point the slim reference worktree at DELIVERY, revert only the
# page-switch commit SWITCH (committed locally, never pushed), and build it.
set -euo pipefail
delivery=$1; switch=$2
ref=/var/tmp/p4.1-293463/tip
cd "$ref"
# Files copied in during development are tracked in DELIVERY.
rm -f src/web/ui-migration/p41.browser.mjs src/web/ui-migration/p41-fixtures.mjs src/web/ui-migration/p41.config.mjs src/web/ui-migration/p0-reference.config.mjs
git checkout --detach -q "$delivery"
git -c user.name=p4.1-reference -c user.email=p4.1@reference.local revert --no-edit "$switch" >/dev/null
echo "reference HEAD $(git rev-parse HEAD) = revert of $switch on $delivery"
git status --short | head
npm run build -w @orbit/web 2>&1 | tail -1
