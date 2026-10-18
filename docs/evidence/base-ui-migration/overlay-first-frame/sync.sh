#!/usr/bin/env bash
# Put a scratch tree (checked out at BASE) in the state under test.
#   sync.sh <tree>        the Orbit worktree's src/web (BASE plus anything not yet committed)
#   sync.sh <tree> ref    the same with the fix commit (FIX) inverted: the same-commit reference
# The evidence probes (*.mjs of overlay-first-frame) are copied too: their configs import the tree's choices config.
set -euo pipefail
ORBIT=/root/.orbit/worktrees/99d0ce19-f5db-5601-9902-ce52eaa1f17a
BASE=${BASE:-$(cat /mnt/data/tmp/overlay-first-frame-34brok/BASE)}
FIX=cd93013535f688856fb08ddbcd057fbee712cbc2
TREE=$1; MODE=${2:-fix}
[ "$(git -C "$TREE" rev-parse HEAD)" = "$(git -C "$ORBIT" rev-parse "$BASE")" ] || { echo "tree not at BASE"; exit 2; }
git -C "$TREE" checkout -q -- src/web
git -C "$TREE" clean -fdq -- src/web/src src/web/ui-migration
git -C "$ORBIT" diff --binary "$BASE" -- src/web | git -C "$TREE" apply --allow-empty
git -C "$ORBIT" ls-files --others --exclude-standard -- src/web | while read -r f; do mkdir -p "$TREE/$(dirname "$f")"; cp "$ORBIT/$f" "$TREE/$f"; done
if [ "$MODE" = ref ]; then git -C "$ORBIT" diff --binary "$FIX" "$FIX^" -- src/web | git -C "$TREE" apply; fi
mkdir -p "$TREE/docs/evidence/base-ui-migration/overlay-first-frame"
cp "$ORBIT"/docs/evidence/base-ui-migration/overlay-first-frame/*.mjs "$TREE/docs/evidence/base-ui-migration/overlay-first-frame/"
echo "synced $MODE: $(git -C "$TREE" status --porcelain -- src/web | wc -l) changed paths under src/web"
