#!/usr/bin/env bash
# round3.sh SWITCH: dev round 3: rebuild the reference tree (HEAD minus SWITCH), build both trees, run every environment
# on each tree in turn, compare. For the development round, not for the record.
set -u
S=/mnt/data/tmp/34Za39L1H6V82d2sobzPY/scripts
V=/mnt/data/tmp/34Za39L1H6V82d2sobzPY/v1
WT=/root/.orbit/worktrees/9f22d16e-3f30-5541-a5ef-91972ffc7911
avail=$(df --output=avail -BG / | tail -1 | tr -dc 0-9)
echo "root free ${avail}G"
if [ "$avail" -lt 6 ]; then echo "root free below 6G: not starting"; exit 3; fi
bash $S/dev-ref.sh "$1" || exit 1
bash $S/build-tree.sh "$WT" || exit 1
bash $S/build-tree.sh "$V/devref" || exit 1
bash $S/dev-all.sh devref r3
bash $S/dev-all.sh del r3
bash $S/dev-compare-all.sh r3
