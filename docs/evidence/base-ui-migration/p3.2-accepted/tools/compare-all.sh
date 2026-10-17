#!/usr/bin/env bash
# Usage: compare-all.sh <runs dir> <current expectation dir> <out dir>
# The comparisons listing.py reads (compare.cjs; the first directory is the expectation side):
#   current expectation -> before (fffcdb532), -> after (2925958ae); before -> after; before -> 066d3dd30;
#   066d3dd30 -> after; P3.2's r2c reference/delivery task screenshots -> before/after.
set -euo pipefail
T=$(cd "$(dirname "$0")" && pwd)
P32=$(git -C "$T" rev-parse --show-toplevel)/docs/evidence/base-ui-migration/p3.2
R=$1 EXP=$2 OUT=$3
B=$R/before-fffcdb532/snapshots A=$R/after-2925958ae/snapshots C=$R/p32-066d3dd30/snapshots
mkdir -p "$OUT"
for pair in "exp-vs-before $EXP $B" "exp-vs-after $EXP $A" "before-vs-after $B $A" "before-vs-p32 $B $C" "p32-vs-after $C $A" \
            "r2cref-vs-before $P32/r2c-p0-task-reference-shots/screenshots $B" "r2cdel-vs-after $P32/r2c-p0-task-delivery/screenshots $A"; do
  set -- $pair
  printf '%-18s ' "$1"; node "$T/compare.cjs" "$2" "$3" "$OUT/$1.json"
done
