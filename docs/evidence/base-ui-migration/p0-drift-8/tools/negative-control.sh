#!/usr/bin/env bash
# Usage: negative-control.sh <base commit> <patch> <name> [checkout]
# A temporary commit (<base> + <patch>, kept only on the local branch p0d8/<name>, never delivered), then:
#  1. the unchanged P0 command on it (round.sh) in the /mnt/data checkout (default $B/wt/base) -> $B/checks/<name>;
#  2. its lean build tree and an update-mode full matrix with the reg runner (the P0 tests of the registration commit) -> $B/runs/full-<name>, so every newly
#     registered screenshot can be compared with its registered expectation, not only the first screenshot each test
#     stops at.
# The checkout returns to <base> afterwards. As p0-drift-7/tools/negative-control.sh.
B=/mnt/data/tmp/34dI9lY63LC7ZEZHbJ4bG
BASE=$1 PATCH=$2 NAME=$3 W=${4:-$B/wt/base}
git -C "$W" checkout -q --detach "$BASE" || exit 2
[ -z "$(git -C "$W" status --porcelain)" ] || { echo "worktree not clean"; exit 2; }
git -C "$W" apply "$PATCH" || exit 2
git -C "$W" -c user.name=coordinator -c user.email=coord@orbit commit -q -am "negative control $NAME (temporary, not delivered)" || exit 2
NC=$(git -C "$W" rev-parse HEAD)
git -C "$W" branch -f "p0d8/$NAME" "$NC"
echo "temporary commit $NC on p0d8/$NAME"
mkdir -p $B/checks/$NAME && cp "$PATCH" $B/checks/$NAME/patch.diff && echo "$NC" > $B/checks/$NAME/commit.txt
if [ ! -f "$B/checks/$NAME/exit.txt" ]; then bash $B/scripts/round.sh "$W" "$B/checks/$NAME"; fi
git -C "$W" checkout -q --detach "$BASE"
nice -n 10 bash $B/scripts/prepare-tree.sh "$NC" "$NAME"
bash $B/scripts/run.sh "$NAME" reg "full-$NAME"
