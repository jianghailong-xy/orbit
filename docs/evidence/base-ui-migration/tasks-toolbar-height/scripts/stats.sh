#!/usr/bin/env bash
# stats.sh FROM TO: rounds FROM..TO of the reproduction statistics -- P4.3a's geometry probe on the project tip and on
# the project line before P4.3a, alternating within each round so both trees see the same host conditions.
# Resumable: a round already written is skipped.
set -u
T=/mnt/data/tmp/34coPBqt8gi229cVNds0E
for n in $(seq "$1" "$2"); do
  for tree in tip pre; do
    [ -f "$T/runs/geom-$tree-r$n/run.txt" ] && grep -q '^exit=' "$T/runs/geom-$tree-r$n/run.txt" && continue
    "$T/scripts/geom.sh" "$tree" "$tree-r$n"
  done
done
