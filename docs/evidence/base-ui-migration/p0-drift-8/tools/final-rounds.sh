#!/usr/bin/env bash
# Usage: final-rounds.sh <commit> <outdir-prefix> [checkout]
# Two consecutive official P0 rounds (round.sh: the unchanged P0 command in its own network namespace) in the
# /mnt/data checkout (default $B/wt/base) of <commit>, then the round-by-round comparison. Resumable: a round with exit.txt is kept.
B=/mnt/data/tmp/34dI9lY63LC7ZEZHbJ4bG
W=${3:-$B/wt/base}
C=$1 P=$2
git -C "$W" checkout -q --detach "$C" || exit 2
[ -z "$(git -C "$W" status --porcelain)" ] || { echo "worktree not clean"; git -C "$W" status --porcelain | head; exit 2; }
echo "tree $(git -C "$W" rev-parse HEAD)"
for n in 1 2; do
  OUT=$B/checks/$P-$n
  if [ -f "$OUT/exit.txt" ]; then echo "round $n kept: $(cat "$OUT/exit.txt")"; continue; fi
  rm -rf "$OUT"
  bash $B/scripts/round.sh "$W" "$OUT"
  echo "round $n: exit $?"
  cp -a "$W/src/web/.ui-migration-results/expected-screenshots" "$OUT/expected-screenshots-assembled"
done
python3 $B/scripts/compare-rounds.py $B/checks/$P-1/summary.json $B/checks/$P-2/summary.json $B/checks/$P-compare.json
