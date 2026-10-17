#!/usr/bin/env bash
# The unchanged P0 command on the unmodified new base 93ab20b8c (origin/main after the rebase), in a second
# /mnt/data checkout with its own isolated install, started once the update-mode runs on that base are done
# (two browser runs at a time at most, beside the official rounds).
set -u
B=/mnt/data/tmp/34cFgyWHIYDslABFPloEM
REPO=/root/.orbit/worktrees/a1f992c4-adcc-5b68-bd13-387124116c3d
export TMPDIR=$B/tmp
W=$B/wt/start2
[ -d "$W" ] || git -C "$REPO" worktree add --detach "$W" 93ab20b8c
git -C "$W" checkout -q --detach 93ab20b8c
[ -d "$W/node_modules" ] || (cd "$W" && npm ci --offline --ignore-scripts --include=dev --include=optional --no-audit --no-fund)
until python3 -c "import json,sys; sys.exit(0 if 'exit' in json.load(open(sys.argv[1])) else 1)" "$B/runs/full-orig-base2/meta.json" 2>/dev/null; do sleep 20; done
bash $B/scripts/round.sh "$W" "$B/checks/base2-start"
