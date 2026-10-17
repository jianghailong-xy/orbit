#!/usr/bin/env bash
# Usage: p42-final.sh <commit> <label>
# The P4.2 cases on <commit> in the /mnt/data checkout $B/wt/base: check it out (clean), build it as
# pretest:ui-migration does (npm run build -w @orbit/shared && npm run build -w @orbit/web), then p42-run.sh.
B=/mnt/data/tmp/34cswWfvNasFTq8kDM0Q4
W=$B/wt/base C=$1 L=$2
export TMPDIR=$B/tmp
git -C "$W" checkout -q --detach "$C" || exit 2
[ -z "$(git -C "$W" status --porcelain)" ] || { echo "worktree not clean"; git -C "$W" status --porcelain | head; exit 2; }
(cd "$W" && env -u PUBLIC_ORIGIN npm run build -w @orbit/shared > $B/logs/p42-final-build-$L.log 2>&1 && env -u PUBLIC_ORIGIN npm run build -w @orbit/web >> $B/logs/p42-final-build-$L.log 2>&1) || { echo "build failed"; tail -20 $B/logs/p42-final-build-$L.log; exit 3; }
echo "built $(git -C "$W" rev-parse HEAD): $(cd $W/src/web/dist && find . -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -c1-16)"
bash $B/scripts/p42-run.sh "$W" "$L"
