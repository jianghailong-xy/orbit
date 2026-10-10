#!/usr/bin/env bash
# tmp-merge.sh MERGE: after the final round P4.4 (34Za39J4QY3kDa5p2Wsau) landed on the project line with changes to the
# ui/ layer this batch depends on (Floating.ts, Popover.tsx, Tooltip.tsx, page rules in index.css). By the project's rule
# for the global layer, no rebase: the standard P0 and this batch's entries run on a temporary merge tree, MERGE = the
# branch merged onto the project tip by merge-tree + commit-tree (local, never pushed), checked out in the delivery tree.
# Also the merge check there. One step at a time (step.sh); results the configs write inside the tree are moved by hand.
S=$(cd "$(dirname "$0")" && pwd)
V=/mnt/data/tmp/34coPBk43ULRuisicUTAy
R=$V/runs
merge=$1
step() { "$S/step.sh" "$@"; [ $? -eq 3 ] && exit 3; return 0; }
moved() { [ -d "$1" ] && [ ! -e "$2" ] && mv "$1" "$2" && echo "moved $1 -> $2"; return 0; }
git -C "$V/del" checkout -q --detach "$merge" || exit 1
echo "del tree at $(git -C "$V/del" rev-parse HEAD)"
step m-overlays "$V/del" env P32_BASE_CONFIG=overlays.config.mjs P32_PORT=4511 P32_OUTPUT="$R/m-overlays-out" \
  npx playwright test --config ui-migration/port.config.mjs
step m-p0 "$V/del" npm run test:ui-migration
moved "$V/del/src/web/.ui-migration-results" "$R/m-p0-out"
step m-merge-check "$V/del" bash -c 'cd ../.. && npm run build -w @orbit/web && npm run test -w @orbit/web'
step m-choices "$V/del" env P32_BASE_CONFIG=choices.config.mjs P32_PORT=4512 P32_OUTPUT="$R/m-choices-out" \
  npx playwright test --config ui-migration/port.config.mjs
echo "tmp-merge.sh done $(date -u +%FT%TZ)"
